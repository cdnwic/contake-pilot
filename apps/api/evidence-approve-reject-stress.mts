/** Whitelist-PG gate v1.1 - bounded approve-vs-reject barrier study (QA
 *  harness-safety controls, 2026-09-17). OPT-IN ONLY: refuses to run without
 *  STRESS_OPT_IN=1; never part of the ordinary suites (not a .test.ts file).
 *
 *  Controls: hard caps (16 iterations, 6-minute runtime ceiling, <=2 noise
 *  apps, <=4 race requests + <=120 paced noise requests per iteration);
 *  zero-noise control (8) -> ramp to 1 noise app (8) -> a 2nd only with
 *  measured headroom (loadavg1<2.0 and freeMem>600MB); STOP on first
 *  timeout/resource/cleanup/integrity issue; thresholds RSS>1400MB,
 *  loadavg1>3.5, freeMem<300MB, free disk<200MB; abort cancels in-flight
 *  work via the single finally path (apps closed, DBs closed, noise stopped,
 *  timers cleared; this script spawns NO child processes); per-iteration
 *  PGlite instances are in-memory and disposable - teardown proof is
 *  recorded per iteration (appClosed/dbClosed) plus a post-run host
 *  recovery + zero-residue sample. The noise envelope (separate PGlite
 *  instances hitting whitelist-check) is CPU/memory load, deliberately
 *  separated from the race DB's contention domain. The approve/reject pair
 *  is released on a synchronized barrier (same tick) with skew measured.
 *  PGlite is SINGLE-CONNECTION: cross-connection race proof is gate C
 *  (real PostgreSQL, two connections), not this study's claim.
 *  Artifacts: JSONL appended per iteration to /tmp/approve-reject-stress.json
 *  (durable per-iteration), human log on stdout; header carries commit, tree,
 *  command, env and resource baselines. */
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from './src/app.js';
import { AuthService, hashPasswordPure } from './src/auth.js';
import { PostgresGraphRepository, createPgOtpState, pgliteConnectable } from './src/repo/postgres.js';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import * as os from 'node:os';
import { appendFileSync, writeFileSync, statfsSync } from 'node:fs';
import { execSync } from 'node:child_process';

if (process.env['STRESS_OPT_IN'] !== '1') { console.error('opt-in required: STRESS_OPT_IN=1'); process.exit(2); }

const MAX_ITERS = 16, QUIET_ITERS = 8;
const RUNTIME_CEILING_MS = 6 * 60 * 1000;
const NOISE_DELAY_MS = 25, NOISE_MAX_REQ_PER_ITER = 120;
const MAX_RSS_MB = 1400, MAX_LOAD1 = 3.5, MIN_FREE_MB = 300, MIN_DISK_MB = 200;
const OUT = '/tmp/approve-reject-stress.json';
const PHONE_BASE = 972500970000;
const COMMIT = execSync('git log -1 --format=%H').toString().trim();
const TREE = execSync('git log -1 --format=%T').toString().trim();

let aborted: string | undefined;
const timers: ReturnType<typeof setTimeout>[] = [];
const freeDiskMB = () => Math.round(statfsSync('/tmp').bfree * 4096 / 1e6);
const resourcesOK = (): string | undefined => {
  const rss = process.memoryUsage().rss / 1e6;
  if (rss > MAX_RSS_MB) return `rss ${Math.round(rss)}MB > ${MAX_RSS_MB}`;
  if (os.loadavg()[0]! > MAX_LOAD1) return `loadavg1 ${os.loadavg()[0]} > ${MAX_LOAD1}`;
  if (os.freemem() / 1e6 < MIN_FREE_MB) return `freemem ${Math.round(os.freemem() / 1e6)}MB < ${MIN_FREE_MB}`;
  if (freeDiskMB() < MIN_DISK_MB) return `free disk ${freeDiskMB()}MB < ${MIN_DISK_MB}`;
  return undefined;
};
const ceiling = setTimeout(() => { aborted = 'runtime ceiling 6m reached'; }, RUNTIME_CEILING_MS);
timers.push(ceiling);

interface IterRec {
  i: number; noiseApps: number; noiseRequests: number; codes: number[]; loserCode?: string;
  terminal?: string; decisions: number; decisionMatchesState: boolean;
  accounts: number; accountMatchesState: boolean; raceMs: number; barrierSkewMs: number;
  lagMaxMs: number; lagMeanMs: number; loadavg1: number; rssMB: number; freeMB: number;
  handlesBefore: number; handlesAfter: number; appClosed: boolean; dbClosed: boolean; ok: boolean; err?: string;
}
const rec = (j: Record<string, unknown>) => { appendFileSync(OUT, JSON.stringify(j) + '\n'); };

async function noiseApp(stop: { stop: boolean }, counter: { n: number }): Promise<void> {
  let db: PGlite | undefined; let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    db = new PGlite();
    const conn = pgliteConnectable(db);
    const repo = await PostgresGraphRepository.create(conn);
    const otp = await createPgOtpState(conn);
    app = buildApp(repo, new AuthService(repo, undefined, undefined, otp));
    while (!stop.stop && counter.n < NOISE_MAX_REQ_PER_ITER && !aborted) {
      await app.inject({ method: 'POST', url: '/v1/auth/whitelist-check', payload: { phone: '+972500000009' } }).catch(() => undefined);
      counter.n += 1;
      await new Promise(r => setTimeout(r, NOISE_DELAY_MS)); // paced, never unbounded
    }
  } finally {
    await app?.close().catch(() => undefined);
    await db?.close().catch(() => undefined);
  }
}

async function iteration(i: number, noiseCount: number): Promise<IterRec> {
  const r: IterRec = {
    i, noiseApps: noiseCount, noiseRequests: 0, codes: [], decisions: -1, decisionMatchesState: false,
    accounts: -1, accountMatchesState: false, raceMs: -1, barrierSkewMs: -1, lagMaxMs: -1, lagMeanMs: -1,
    loadavg1: os.loadavg()[0]!, rssMB: Math.round(process.memoryUsage().rss / 1e6), freeMB: Math.round(os.freemem() / 1e6),
    handlesBefore: (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length,
    handlesAfter: -1, appClosed: false, dbClosed: false, ok: false,
  };
  const hist: IntervalHistogram = monitorEventLoopDelay();
  const noise: { stop: boolean }[] = []; const counter = { n: 0 };
  const noisePs: Promise<void>[] = [];
  let db: PGlite | undefined; let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    for (let k = 0; k < noiseCount; k += 1) { const s = { stop: false }; noise.push(s); noisePs.push(noiseApp(s, counter)); }
    db = new PGlite();
    const conn = pgliteConnectable(db);
    const repo = await PostgresGraphRepository.create(conn);
    await repo.createUser({ userId: 'u-admin', orgId: 'org-1', name: 'מנהל', role: 'admin', scopes: [], email: 'admin@x.local', passwordHash: hashPasswordPure('admin123'), active: true });
    const otp = await createPgOtpState(conn);
    app = buildApp(repo, new AuthService(repo, undefined, undefined, otp));
    const admin = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@x.local', password: 'admin123' } })).json().token as string;
    const H = { authorization: `Bearer ${admin}` };
    const phone = `+${PHONE_BASE + i}`;
    await app.inject({ method: 'POST', url: '/v1/whitelist', headers: H, payload: { phone } });
    await app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone, displayName: 'מועמד', requestedRole: 'field_manager' } });
    if (aborted) throw new Error('aborted: ' + aborted);
    hist.enable();
    let tA = 0; let tR = 0;
    const t0 = performance.now();
    const [a, rej] = await Promise.all([ // synchronized barrier: released same tick
      app.inject({ method: 'POST', url: `/v1/whitelist/${phone}/approve`, headers: H, payload: { role: 'field_manager' } }).then(x => { tA = performance.now(); return x; }),
      app.inject({ method: 'POST', url: `/v1/whitelist/${phone}/reject`, headers: H, payload: { reasonHe: 'לא' } }).then(x => { tR = performance.now(); return x; }),
    ]);
    const t1 = performance.now();
    hist.disable();
    r.raceMs = Math.round((t1 - t0) * 100) / 100;
    r.barrierSkewMs = Math.round(Math.abs(tA - tR) * 100) / 100;
    r.lagMaxMs = Math.round((hist.max / 1e6) * 100) / 100;
    r.lagMeanMs = Math.round((hist.mean / 1e6) * 100) / 100;
    r.codes = [a.statusCode, rej.statusCode].sort((x, y) => x - y);
    const loser = a.statusCode === 409 ? a : rej;
    r.loserCode = loser.statusCode === 409 ? String(loser.json().error?.code) : undefined;
    const entry = await repo.getWhitelistEntry(phone);
    r.terminal = entry?.status;
    const decisions = (await repo.listAudit('org-1')).filter(x => x.action === 'whitelist.approve' || x.action === 'whitelist.reject');
    r.decisions = decisions.length;
    r.decisionMatchesState = decisions.length === 1 && decisions[0]!.action === (entry?.status === 'approved' ? 'whitelist.approve' : 'whitelist.reject');
    const accounts = (await repo.listUsers('org-1')).filter(u => u.phone === phone);
    r.accounts = accounts.length;
    r.accountMatchesState = accounts.length === (entry?.status === 'approved' ? 1 : 0);
    r.ok = r.codes[0] === 200 && r.codes[1] === 409 && r.loserCode === 'WHITELIST_NOT_PENDING'
      && (entry?.status === 'approved' || entry?.status === 'rejected') && r.decisionMatchesState && r.accountMatchesState;
  } catch (e) {
    r.err = String(e).slice(0, 300);
  } finally { // single cleanup path: apps, connections, noise, timers
    for (const s of noise) s.stop = true;
    await Promise.all(noisePs).catch(() => undefined);
    await app?.close().then(() => { r.appClosed = true; }).catch(() => undefined);
    await db?.close().then(() => { r.dbClosed = true; }).catch(() => undefined);
    r.noiseRequests = counter.n;
    r.handlesAfter = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length;
  }
  return r;
}

writeFileSync(OUT, JSON.stringify({ header: true, commit: COMMIT, tree: TREE, command: 'STRESS_OPT_IN=1 npx tsx evidence-approve-reject-stress.mts', env: { REPO_IMPL: 'postgres (PGlite, single-connection label applies)' }, baseline: { loadavg: os.loadavg(), freeMB: Math.round(os.freemem() / 1e6), diskMB: freeDiskMB(), cpus: os.cpus().length }, caps: { MAX_ITERS, RUNTIME_CEILING_MS, NOISE_DELAY_MS, NOISE_MAX_REQ_PER_ITER, MAX_RSS_MB, MAX_LOAD1, MIN_FREE_MB, MIN_DISK_MB }, startedAt: new Date().toISOString() }) + '\n');

const recs: IterRec[] = [];
let noiseStage = 0;
for (let i = 0; i < MAX_ITERS; i += 1) {
  if (aborted) break;
  const thresh = resourcesOK();
  if (thresh) { aborted = 'resource threshold: ' + thresh; break; }
  if (i >= QUIET_ITERS) {
    noiseStage = 1;
    if (i === QUIET_ITERS * 1.5 || i === 12) { // ramp checkpoint: a 2nd app only with measured headroom
      if (os.loadavg()[0]! < 2.0 && os.freemem() / 1e6 > 600) noiseStage = 2;
    }
  }
  const r = await iteration(i, noiseStage);
  recs.push(r);
  rec({ iteration: r });
  console.log(`iter ${r.i} noise=${r.noiseApps} ok=${r.ok} codes=${r.codes} terminal=${r.terminal} decisions=${r.decisions} accounts=${r.accounts} raceMs=${r.raceMs} skewMs=${r.barrierSkewMs} lagMax=${r.lagMaxMs} rss=${r.rssMB} free=${r.freeMB} noiseReq=${r.noiseRequests} handles=${r.handlesBefore}->${r.handlesAfter} cleanup=${r.appClosed}/${r.dbClosed}${r.err ? ' ERR=' + r.err : ''}`);
  if (!r.ok || r.err || !r.appClosed || !r.dbClosed) { aborted = `stop-on-first-issue at iter ${i}: ${r.err ?? 'assertion/cleanup failure'}`; break; } // stop on first issue
}

// post-run host recovery + zero-residue proof
for (const t of timers) clearTimeout(t);
const settle = async () => { await new Promise(r => setTimeout(r, 2000)); };
await settle();
const recovery = { loadavg: os.loadavg(), freeMB: Math.round(os.freemem() / 1e6), rssMB: Math.round(process.memoryUsage().rss / 1e6), handles: (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length, diskMB: freeDiskMB() };
const fails = recs.filter(r => !r.ok);
const summary = { summary: true, iterations: recs.length, passed: recs.length - fails.length, aborted: aborted ?? null, recovery, finishedAt: new Date().toISOString() };
rec(summary);
console.log('SUMMARY', JSON.stringify(summary));
process.exit(fails.length || aborted ? 1 : 0);
