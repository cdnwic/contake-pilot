/** PR-1 dual-mode repo factory: REPO_IMPL=postgres runs every carried suite
 *  against the real Postgres adapter on a hermetic PGlite instance; anything
 *  else keeps the in-memory default. */
import { PGlite } from '@electric-sql/pglite';
import type { GraphRepository } from '../../src/repo/graph-repository.js';
import { MemoryGraphRepository } from '../../src/repo/memory.js';
import { PostgresGraphRepository, pgliteConnectable, createPgOtpState } from '../../src/repo/postgres.js';
import { memoryOtpState, type OtpStateStore } from '../../src/auth.js';
import { applySeed, seedDemo } from '../../src/seed.js';
import type { SeedData } from '../../src/repo/graph-repository.js';

export const REPO_IMPL = process.env['REPO_IMPL'] ?? 'memory';

// PGlite instances are heavy (WASM); keep at most ONE live per test file.
let live: PGlite | undefined;
async function freshPglite(): Promise<PGlite> {
  await live?.close().catch(() => undefined);
  live = new PGlite();
  return live;
}

export async function makeTestRepo(): Promise<GraphRepository> {
  if (REPO_IMPL === 'postgres') {
    const repo = await PostgresGraphRepository.create(pgliteConnectable(await freshPglite()));
    await applySeed(repo, seedDemo());
    return repo;
  }
  return MemoryGraphRepository.seeded(seedDemo());
}

/** Same factory with an explicit seed (profile-parity builds custom graphs). */
export async function makeTestRepoFrom(data: SeedData): Promise<GraphRepository> {
  if (REPO_IMPL === 'postgres') {
    const repo = await PostgresGraphRepository.create(pgliteConnectable(await freshPglite()));
    await applySeed(repo, data);
    return repo;
  }
  return MemoryGraphRepository.seeded(data);
}

/** Pilot-prep #4: repo + OTP store bound to the SAME adapter (one pglite in PG
 *  mode), mirroring the server's DATABASE_URL wiring. */
export async function makeTestBackend(): Promise<{ repo: GraphRepository; otpStore: OtpStateStore }> {
  if (REPO_IMPL === 'postgres') {
    const conn = pgliteConnectable(await freshPglite());
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
 *  A paused hook holds the PGlite serialization chain, so a racing admin
 *  mutation queues exactly as it would behind the open registration tx.
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
  if (REPO_IMPL === 'postgres') {
    let hook: AuditHook | undefined;
    const raw = await freshPglite();
    const wrapped = {
      query: (text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; affectedRows?: number }> => {
        if (hook && /^\s*INSERT\s+INTO\s+auth_audit/i.test(text)) {
          const entry = { phone: String(params?.[0]), kind: String(params?.[1]), detail: params?.[2] ?? undefined };
          return Promise.resolve(hook(entry, () => raw.query(text, params))) as Promise<{ rows: Record<string, unknown>[]; affectedRows?: number }>;
        }
        return raw.query(text, params);
      },
    };
    const conn = pgliteConnectable(wrapped);
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
