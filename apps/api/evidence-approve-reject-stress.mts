/** Whitelist-PG gate v1.1 (QA timing adjudication): controlled parallel-load
 *  approve-vs-reject barrier study on the PG adapter (PGlite).
 *  Per iteration: explicit start-barrier releases approve+reject in the SAME
 *  tick; we assert the 200/409 pair, exactly one terminal state, exactly one
 *  decision audit row matching the landed state, and an account iff approve
 *  won. Iterations alternate quiet vs loaded (4 noise apps hammering
 *  whitelist-check on separate PGlite instances = controlled parallel load).
 *  Captures: race duration, barrier skew, event-loop lag (max/mean), loadavg,
 *  active handles, and full DB open/close lifecycle per iteration.
 *  Output: JSONL at /tmp/approve-reject-stress.json + human log on stdout. */
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from './src/app.js';
import { AuthService, hashPasswordPure } from './src/auth.js';
import { PostgresGraphRepository, createPgOtpState, pgliteConnectable } from './src/repo/postgres.js';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import * as os from 'node:os';
import { appendFileSync } from 'node:fs';

const N = 24; // 12 quiet + 12 loaded
const OUT = '/tmp/approve-reject-stress.json';
const PHONE_BASE = 972500970000;

interface IterRec {
  i: number; loaded: boolean; codes: number[]; loserCode?: string;
  terminal?: string; decisions: number; decisionMatchesState: boolean;
  accounts: number; accountMatchesState: boolean;
  raceMs: number; barrierSkewMs: number; lagMaxMs: number; lagMeanMs: number;
  loadavg1: number; handlesBefore: number; handlesAfter: number;
  dbOpened: boolean; dbClosed: boolean; appClosed: boolean; ok: boolean; err?: string;
}

async function noiseApp(stop: { stop: boolean }): Promise<void> {
  const db = new PGlite();
  const conn = pgliteConnectable(db);
  const repo = await PostgresGraphRepository.create(conn);
  const otp = await createPgOtpState(conn);
  const app = buildApp(repo, new AuthService(repo, undefined, undefined, otp));
  while (!stop.stop) {
    await app.inject({ method: 'POST', url: '/v1/auth/whitelist-check', payload: { phone: '+972500000009' } }).catch(() => undefined);
  }
  await app.close().catch(() => undefined);
  await db.close().catch(() => undefined);
}

async function iteration(i: number, loaded: boolean): Promise<IterRec> {
  const rec: IterRec = {
    i, loaded, codes: [], decisions: -1, decisionMatchesState: false,
    accounts: -1, accountMatchesState: false, raceMs: -1, barrierSkewMs: -1,
    lagMaxMs: -1, lagMeanMs: -1, loadavg1: os.loadavg()[0]!,
    handlesBefore: (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length,
    handlesAfter: -1, dbOpened: false, dbClosed: false, appClosed: false, ok: false,
  };
  const hist: IntervalHistogram = monitorEventLoopDelay();
  const noise: { stop: boolean }[] = [];
  const noisePs: Promise<void>[] = [];
  try {
    if (loaded) {
      for (let k = 0; k < 4; k += 1) { const s = { stop: false }; noise.push(s); noisePs.push(noiseApp(s)); }
    }
    const liveDb = new PGlite();
    rec.dbOpened = true;
    const conn = pgliteConnectable(liveDb);
    const repo = await PostgresGraphRepository.create(conn);
    await repo.createUser({ userId: 'u-admin', orgId: 'org-1', name: 'מנהל', role: 'admin', scopes: [], email: 'admin@x.local', passwordHash: hashPasswordPure('admin123'), active: true });
    const otp = await createPgOtpState(conn);
    const app = buildApp(repo, new AuthService(repo, undefined, undefined, otp));
    const admin = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@x.local', password: 'admin123' } })).json().token as string;
    const H = { authorization: `Bearer ${admin}` };
    const phone = `+${PHONE_BASE + i}`;
    await app.inject({ method: 'POST', url: '/v1/whitelist', headers: H, payload: { phone } });
    await app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone, displayName: 'מועמד', requestedRole: 'field_manager' } });

    // Explicit barrier: both requests constructed; released in the same tick.
    hist.enable();
    let tA = 0; let tR = 0;
    const t0 = performance.now();
    const [a, r] = await Promise.all([
      app.inject({ method: 'POST', url: `/v1/whitelist/${phone}/approve`, headers: H, payload: { role: 'field_manager' } }).then(x => { tA = performance.now(); return x; }),
      app.inject({ method: 'POST', url: `/v1/whitelist/${phone}/reject`, headers: H, payload: { reasonHe: 'לא' } }).then(x => { tR = performance.now(); return x; }),
    ]);
    const t1 = performance.now();
    hist.disable();
    rec.raceMs = Math.round((t1 - t0) * 100) / 100;
    rec.barrierSkewMs = Math.round(Math.abs(tA - tR) * 100) / 100;
    rec.lagMaxMs = Math.round((hist.max / 1e6) * 100) / 100;
    rec.lagMeanMs = Math.round((hist.mean / 1e6) * 100) / 100;

    rec.codes = [a.statusCode, r.statusCode].sort((x, y) => x - y);
    const loser = a.statusCode === 409 ? a : r;
    rec.loserCode = loser.statusCode === 409 ? String(loser.json().error?.code) : undefined;
    const entry = await repo.getWhitelistEntry(phone);
    rec.terminal = entry?.status;
    const decisions = (await repo.listAudit('org-1')).filter(x => x.action === 'whitelist.approve' || x.action === 'whitelist.reject');
    rec.decisions = decisions.length;
    rec.decisionMatchesState = decisions.length === 1
      && decisions[0]!.action === (entry?.status === 'approved' ? 'whitelist.approve' : 'whitelist.reject');
    const accounts = (await repo.listUsers('org-1')).filter(u => u.phone === phone);
    rec.accounts = accounts.length;
    rec.accountMatchesState = accounts.length === (entry?.status === 'approved' ? 1 : 0);
    rec.ok = rec.codes[0] === 200 && rec.codes[1] === 409
      && rec.loserCode === 'WHITELIST_NOT_PENDING'
      && (entry?.status === 'approved' || entry?.status === 'rejected')
      && rec.decisionMatchesState && rec.accountMatchesState;
    await app.close(); rec.appClosed = true;
    await liveDb.close(); rec.dbClosed = true;
  } catch (e) {
    rec.err = String(e).slice(0, 300);
  } finally {
    for (const s of noise) s.stop = true;
    await Promise.all(noisePs);
    rec.handlesAfter = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length;
  }
  return rec;
}

const recs: IterRec[] = [];
for (let i = 0; i < N; i += 1) {
  const rec = await iteration(i, i >= N / 2);
  recs.push(rec);
  appendFileSync(OUT, JSON.stringify(rec) + '\n');
  console.log(`iter ${rec.i} loaded=${rec.loaded} ok=${rec.ok} codes=${rec.codes} loser=${rec.loserCode} terminal=${rec.terminal} decisions=${rec.decisions} accounts=${rec.accounts} raceMs=${rec.raceMs} skewMs=${rec.barrierSkewMs} lagMax=${rec.lagMaxMs} lagMean=${rec.lagMeanMs} handles=${rec.handlesBefore}->${rec.handlesAfter} db=${rec.dbOpened}/${rec.dbClosed}${rec.err ? ' ERR=' + rec.err : ''}`);
}
const fails = recs.filter(r => !r.ok);
console.log(`SUMMARY: ${recs.length - fails.length}/${N} iterations OK; failures: ${fails.length}`);
if (fails.length) { console.log(JSON.stringify(fails, null, 1)); process.exit(1); }
