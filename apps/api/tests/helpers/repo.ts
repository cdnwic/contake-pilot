/** PR-1 dual-mode repo factory: REPO_IMPL=postgres runs every carried suite
 *  against the real Postgres adapter on a hermetic PGlite instance; anything
 *  else keeps the in-memory default.
 *
 * Whitelist-PG gate v1.1 (QA harness controls, 2026-09-17): the PG lane uses
 * ONE file-scoped PGlite instance with an explicit lifecycle instead of a
 * fresh WASM boot per test (the per-test boot/close churn on the 2vCPU/2GB
 * gate box pushed beforeEach past the 10s hook timeout mid/late suite):
 *  - file-scoped instance, detectable instanceId + fileId, NO cross-file
 *    singleton (vitest isolates modules per file; this module's state is
 *    per-file by construction);
 *  - before each reset the previous connectable is drained (its serialized
 *    query chain is awaited), so no in-flight/fire-and-forget query crosses
 *    a reset; afterAll closes the instance and FAILS LOUDLY on cleanup error;
 *  - reset is an uninstrumented admin path on the RAW handle (outside every
 *    fault hook and counter): DROP/CREATE SCHEMA, owner/grants/search_path
 *    restored, then the PRODUCTION bootstrap (PostgresGraphRepository.create
 *    DDL / createPgOtpState DDL) re-runs;
 *  - audit fault injection (makeTestBackendFrom) intercepts INSERT INTO
 *    auth_audit at the connectable layer with a BEGIN/COMMIT depth trace, so
 *    round-4/round-7 injection is proven to fire INSIDE the real auth_audit
 *    transaction; reset queries never pass the hook;
 *  - PGlite is SINGLE-CONNECTION: cross-connection races are gate C's
 *    real-PostgreSQL two-connection proof, not this lane's claim.
 *  Set PG_HARNESS_TRACE=1 for lifecycle/query trace lines on stderr. */
import { PGlite } from '@electric-sql/pglite';
import type { GraphRepository } from '../../src/repo/graph-repository.js';
import { MemoryGraphRepository } from '../../src/repo/memory.js';
import { PostgresGraphRepository, pgliteConnectable, createPgOtpState, type Connectable } from '../../src/repo/postgres.js';
import { memoryOtpState, type OtpStateStore } from '../../src/auth.js';
import type { DispatchStateStore } from '../../src/services/dispatch.js';
import { probe } from './g4-diag.js';
import { applySeed, seedDemo } from '../../src/seed.js';
import type { SeedData } from '../../src/repo/graph-repository.js';

export const REPO_IMPL = process.env['REPO_IMPL'] ?? 'memory';

interface FilePglite {
  raw: PGlite;
  instanceId: string;
  fileId: string;
  resets: number;
  maxRssMB: number;
  lastConn?: Connectable;
}
let filePg: FilePglite | undefined;
let instanceCounter = 0;

const TRACE = process.env['PG_HARNESS_TRACE'] === '1';
function trace(fp: FilePglite, rec: Record<string, unknown>): void {
  const rssMB = Math.round(process.memoryUsage().rss / 1e6);
  if (rssMB > fp.maxRssMB) fp.maxRssMB = rssMB;
  if (TRACE) console.error('[pg-harness]', JSON.stringify({ instance: fp.instanceId, file: fp.fileId, rssMB, ...rec }));
}

let vitestExpect: { getState(): { testPath?: string } } | undefined;
if (process.env['VITEST']) {
  // dynamic: importing 'vitest' outside the runner throws at module init, and
  // evidence scripts (tsx) import this helper without a runner.
  const v = await import('vitest');
  vitestExpect = v.expect;
  v.afterAll(async () => {
    const fp = filePg;
    filePg = undefined;
    if (!fp) return;
    probe('helperAA:closing', { instance: fp.instanceId, file: fp.fileId, resets: fp.resets, maxRssMB: fp.maxRssMB });
    try {
      await fp.raw.close();
    } catch (e) {
      throw new Error(`[pg-harness] LOUD cleanup failure: instance ${fp.instanceId} (${fp.fileId}) close: ${String(e)}`);
    }
    probe('helperAA:closed', { instance: fp.instanceId });
    trace(fp, { op: 'close', resets: fp.resets, maxRssMB: fp.maxRssMB });
  });
  v.afterAll(async () => {
    const pools = realPgPools.splice(0);
    if (!pools.length) return;
    const errs: string[] = [];
    for (const pool of pools) {
      try { await pool.end(); } catch (e) { errs.push(String(e)); }
    }
    if (errs.length) throw new Error(`[realpg-harness] LOUD cleanup failure: ${errs.length}/${pools.length} pools failed to close: ${errs.join('; ')}`);
  });
}

function currentFileId(): string {
  try { return vitestExpect?.getState().testPath ?? 'unknown'; } catch { return 'unknown'; }
}

async function fileInstance(): Promise<FilePglite> {
  if (filePg) return filePg;
  const raw = new PGlite();
  filePg = { raw, instanceId: `pgi-${process.pid}-${++instanceCounter}`, fileId: currentFileId(), resets: 0, maxRssMB: 0 };
  trace(filePg, { op: 'boot' });
  return filePg;
}

/** Uninstrumented admin reset on the RAW handle (never through a fault hook):
 *  drains the previous connectable's serialized chain, drops/recreates the
 *  schema, restores owner/grants/search_path. Production bootstrap (DDL via
 *  PostgresGraphRepository.create / createPgOtpState) is invoked by the
 *  factories right after. */
async function resetInstance(fp: FilePglite): Promise<void> {
  probe('pg:reset-entry', { instance: fp.instanceId, resets: fp.resets });
  if (fp.resets > 0) {
    if (fp.lastConn) {
      const t0 = performance.now();
      await fp.lastConn.query('SELECT 1'); // drain: chains behind any in-flight query
      trace(fp, { op: 'drain', ms: Math.round((performance.now() - t0) * 10) / 10 });
    }
    const t0 = performance.now();
    // DISCARD ALL first: clears session state a schema drop leaves behind
    // (prepared statements, advisory locks, LISTEN channels, session GUCs).
    await fp.raw.query('DISCARD ALL');
    await fp.raw.query('DROP SCHEMA public CASCADE');
    await fp.raw.query('CREATE SCHEMA public');
    await fp.raw.query('ALTER SCHEMA public OWNER TO postgres');
    await fp.raw.query('GRANT ALL ON SCHEMA public TO public');
    await fp.raw.query('SET search_path TO public');
    probe('pg:reset-done', { instance: fp.instanceId, resets: fp.resets });
    trace(fp, { op: 'reset', ms: Math.round((performance.now() - t0) * 10) / 10 });
  }
  fp.resets += 1;
}

/** Introspection for evidence/self-test scripts (read-only). */
export function getFileInstanceInfo(): { instanceId: string; fileId: string; resets: number; maxRssMB: number } | undefined {
  return filePg && { instanceId: filePg.instanceId, fileId: filePg.fileId, resets: filePg.resets, maxRssMB: filePg.maxRssMB };
}

export async function makeTestRepo(): Promise<GraphRepository> {
  if (REPO_IMPL === 'realpg') return makeRealPgRepoFrom(seedDemo());
  if (REPO_IMPL === 'postgres') {
    const fp = await fileInstance();
    await resetInstance(fp);
    const conn = pgliteConnectable(fp.raw);
    fp.lastConn = conn;
    const repo = await PostgresGraphRepository.create(conn);
    await applySeed(repo, seedDemo());
    return repo;
  }
  return MemoryGraphRepository.seeded(seedDemo());
}

/** G2 hermetic real-PostgreSQL lane (QA order, 2026-09-17): every repo
 *  creation gets its OWN schema t<epoch36><rand4> on DATABASE_URL, pinned
 *  per-connection via search_path (no suite ever touches schema public, so
 *  concurrent/stale runs cannot bleed into each other); every pool is tracked
 *  and closed in afterAll (loud on error); a lazy janitor drops only stale
 *  t_* schemas older than 1h (crashed-run leftovers). */
let realPgSchema: string | undefined;
const realPgPools: import('pg').Pool[] = [];
let realPgJanitorDone = false;

async function realPgPool(schema?: string): Promise<import('pg').Pool> {
  const { Pool } = await import('pg');
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('realpg lane requires DATABASE_URL');
  if (!realPgJanitorDone) {
    realPgJanitorDone = true;
    const admin = new Pool({ connectionString: url, max: 1 });
    try {
      const { rows } = await admin.query(`SELECT nspname FROM pg_namespace WHERE nspname ~ '^t[a-z0-9]+[0-9a-f]{4}$'`);
      const now = Date.now();
      for (const r of rows as { nspname: string }[]) {
        const m = /^t([a-z0-9]+)[0-9a-f]{4}$/.exec(r.nspname);
        if (!m) continue;
        const epoch = parseInt(m[1]!, 36);
        if (Number.isFinite(epoch) && now - epoch > 3_600_000) {
          await admin.query(`DROP SCHEMA IF EXISTS "${r.nspname}" CASCADE`);
        }
      }
    } finally {
      await admin.end();
    }
  }
  const pool = new Pool({ connectionString: url, max: 4, ...(schema ? { options: `-c search_path=${schema}` } : {}) });
  realPgPools.push(pool);
  return pool;
}

/** Same factory with an explicit seed (profile-parity builds custom graphs). */
async function makeRealPgRepoFrom(data: SeedData): Promise<GraphRepository> {
  const { randomBytes } = await import('node:crypto');
  const schema = `t${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  realPgSchema = schema;
  const admin = await realPgPool();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = await realPgPool(schema);
  const repo = await PostgresGraphRepository.create(pool as unknown as Connectable);
  await applySeed(repo, data);
  return repo;
}

export async function makeTestRepoFrom(data: SeedData): Promise<GraphRepository> {
  if (REPO_IMPL === 'realpg') return makeRealPgRepoFrom(data);
  if (REPO_IMPL === 'postgres') {
    const fp = await fileInstance();
    await resetInstance(fp);
    const conn = pgliteConnectable(fp.raw);
    fp.lastConn = conn;
    const repo = await PostgresGraphRepository.create(conn);
    await applySeed(repo, data);
    return repo;
  }
  return MemoryGraphRepository.seeded(data);
}

/** Pilot-prep #4: repo + OTP store bound to the SAME adapter (one pglite in PG
 *  mode), mirroring the server's DATABASE_URL wiring. */
export async function makeTestBackend(): Promise<{ repo: GraphRepository; otpStore: OtpStateStore }> {
  if (REPO_IMPL === 'realpg') {
    const repo = await makeRealPgRepoFrom(seedDemo());
    const pool = await realPgPool(realPgSchema);
    const otpStore = await createPgOtpState(pool as unknown as Connectable);
    return { repo, otpStore };
  }
  if (REPO_IMPL === 'postgres') {
    const fp = await fileInstance();
    await resetInstance(fp);
    const conn = pgliteConnectable(fp.raw);
    fp.lastConn = conn;
    const repo = await PostgresGraphRepository.create(conn);
    await applySeed(repo, seedDemo());
    const otpStore = await createPgOtpState(conn);
    return { repo, otpStore };
  }
  return { repo: MemoryGraphRepository.seeded(seedDemo()), otpStore: memoryOtpState() };
}

/** Whitelist-PG gate (harness lane): one fault-injection / observation point
 *  for the auth_audit channel on BOTH adapters. The shared whitelist suites
 *  drive audit failures and pauses through this hook and read outcomes through
 *  the returned store:
 *  - memory: wraps otpStore.appendAuthAudit (the repo's committed-write sink
 *    AND the route-level appendWhitelistAudit both flow through it);
 *  - postgres: intercepts INSERT INTO auth_audit at the connectable layer, so
 *    BOTH the PG OTP store's appends and the PG repo's in-tx committed insert
 *    are seen - the adapter's real write path is exercised, never bypassed.
 *    A BEGIN/COMMIT depth trace proves the injection fires INSIDE the real
 *    auth_audit transaction; a paused hook holds the PGlite serialization
 *    chain, so a racing admin mutation queues exactly as it would behind the
 *    open registration tx. Reset queries never pass the hook or its counter.
 *  Assertions in the carried suites are unchanged. */
export type AuditHook = (
  entry: { phone: string; kind: string; detail?: unknown },
  real: () => Promise<unknown>,
) => unknown;

export interface TestBackend {
  repo: GraphRepository;
  otpStore: OtpStateStore;
  setAuditHook: (hook?: AuditHook) => void;
}

export async function makeTestBackendFrom(data: SeedData): Promise<TestBackend> {
  if (REPO_IMPL === 'realpg') {
    // audit fault injection at the pool-query layer: intercepts INSERT INTO
    // auth_audit with a BEGIN/COMMIT depth trace, mirroring the PGlite lane;
    // both the PG OTP store's appends and the repo's in-tx insert are seen.
    let hook: AuditHook | undefined;
    let txDepth = 0;
    const schema = `t${Date.now().toString(36)}${(await import('node:crypto')).randomBytes(2).toString('hex')}`;
    realPgSchema = schema;
    const admin = await realPgPool();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = await realPgPool(schema);
    const wrapped: Connectable = {
      query: async (text: string, params?: unknown[]) => {
        const tt = text.trim().toUpperCase();
        if (tt === 'BEGIN') txDepth += 1;
        else if (tt.startsWith('COMMIT') || tt.startsWith('ROLLBACK')) txDepth = Math.max(0, txDepth - 1);
        if (hook && /^\s*INSERT\s+INTO\s+auth_audit/i.test(text)) {
          const entry = { phone: String(params?.[0]), kind: String(params?.[1]), detail: params?.[2] ?? undefined };
          return hook(entry, () => pool.query(text, params)) as Promise<{ rows: Record<string, unknown>[]; affectedRows?: number }>;
        }
        return pool.query(text, params) as Promise<{ rows: Record<string, unknown>[]; affectedRows?: number }>;
      },
    };
    const repo = await PostgresGraphRepository.create(wrapped);
    await applySeed(repo, data);
    const otpStore = await createPgOtpState(wrapped);
    return { repo, otpStore, setAuditHook: h => { hook = h; } };
  }
  if (REPO_IMPL === 'postgres') {
    const fp = await fileInstance();
    let hook: AuditHook | undefined;
    let txDepth = 0;
    let auditSeq = 0;
    const wrapped = {
      query: (text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; affectedRows?: number }> => {
        const tt = text.trim().toUpperCase();
        if (tt === 'BEGIN') txDepth += 1;
        else if (tt.startsWith('COMMIT') || tt.startsWith('ROLLBACK')) txDepth = Math.max(0, txDepth - 1);
        if (hook && /^\s*INSERT\s+INTO\s+auth_audit/i.test(text)) {
          auditSeq += 1;
          trace(fp, { op: 'audit-insert', seq: auditSeq, inTx: txDepth > 0 });
          const entry = { phone: String(params?.[0]), kind: String(params?.[1]), detail: params?.[2] ?? undefined };
          return Promise.resolve(hook(entry, () => fp.raw.query(text, params))) as Promise<{ rows: Record<string, unknown>[]; affectedRows?: number }>;
        }
        return fp.raw.query(text, params);
      },
    };
    const conn = pgliteConnectable(wrapped);
    await resetInstance(fp); // uninstrumented: raw handle, outside the hook/counters
    fp.lastConn = conn;
    const repo = await PostgresGraphRepository.create(conn);
    await applySeed(repo, data);
    const otpStore = await createPgOtpState(conn);
    return { repo, otpStore, setAuditHook: h => { hook = h; } };
  }
  const repo = MemoryGraphRepository.seeded(data);
  const otpStore = memoryOtpState();
  let hook: AuditHook | undefined;
  const realAppend = otpStore.appendAuthAudit.bind(otpStore);
  otpStore.appendAuthAudit = e => (hook ? Promise.resolve(hook(e, () => realAppend(e))) as Promise<void> : realAppend(e));
  return { repo, otpStore, setAuditHook: h => { hook = h; } };
}

/** G2 stop-ship (2026-09-17): a DispatchStateStore matching the current lane,
 *  over the SAME durable backend the repo uses - this mirrors the server.ts
 *  production composition (pgDispatchState injected into buildApp AND the
 *  send-side dispatcher). memory lane: a plain shared in-memory store.
 *  PGlite lane: over the file-scoped instance's serialized connectable.
 *  realpg lane: a fresh Pool on DATABASE_URL (multi-connection proof).
 *  `existing` lets a test mint a SECOND store over the same backend
 *  (restart proof). */
export async function makeLaneDispatchState(): Promise<DispatchStateStore> {
  if (REPO_IMPL === 'realpg') {
    if (!realPgSchema) throw new Error('makeLaneDispatchState: call makeTestRepo/makeTestRepoFrom first (schema unknown)');
    const { pgDispatchState } = await import('../../src/repo/postgres.js');
    return pgDispatchState(await realPgPool(realPgSchema) as unknown as Connectable);
  }
  if (REPO_IMPL === 'postgres') {
    const fp = await fileInstance();
    const { pgDispatchState } = await import('../../src/repo/postgres.js');
    return pgDispatchState(pgliteConnectable(fp.raw));
  }
  const { memoryDispatchState } = await import('../../src/services/dispatch.js');
  return memoryDispatchState();
}

/** G2 server-assembly tests: a Queryable over the lane's real backend (the
 *  SAME store makeTestRepo uses), for assembleServer's DATABASE_URL mode.
 *  Memory lane: undefined (assemble in in-memory mode). */
export async function makeLaneQueryable(): Promise<import('../../src/repo/postgres.js').Queryable | undefined> {
  if (REPO_IMPL === 'realpg') {
    if (!realPgSchema) throw new Error('makeLaneQueryable: call makeTestRepo first (schema unknown)');
    return await realPgPool(realPgSchema) as unknown as import('../../src/repo/postgres.js').Queryable;
  }
  if (REPO_IMPL === 'postgres') {
    const fp = await fileInstance();
    return pgliteConnectable(fp.raw);
  }
  return undefined;
}
