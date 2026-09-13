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
