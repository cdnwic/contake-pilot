/** Whitelist-PG gate root-cause probe + isolation proof for per-file PGlite
 *  reuse with schema reset (QA adjudication 05:37):
 *  Phase A: current pattern cost (close prev + fresh WASM boot + DDL + seed) x30.
 *  Phase B: reuse pattern cost (DROP/CREATE SCHEMA + DDL + seed) x30.
 *  Phase C: ISOLATION regression checks across a reset:
 *    C1 data isolation: rows written before the reset are gone after it;
 *    C2 schema identity: tables recreated by DDL, sequences restart (seq=1);
 *    C3 no surviving session/prepared state: a prepared statement and an
 *       advisory lock taken before the reset do not leak; LISTEN/NOTIFY
 *       state does not carry; pg_prepared_statements is empty after reset;
 *    C4 close hygiene: a second fresh instance boots while the reused one
 *       is open (file-level next-test pattern), then afterAll-style close.
 *  Prints JSON lines; evidence only, no assertions relaxed anywhere. */
import { PGlite } from '@electric-sql/pglite';
import { PostgresGraphRepository, pgliteConnectable } from './src/repo/postgres.js';
import { applySeed, seedDemo } from './src/seed.js';

const rss = () => Math.round(process.memoryUsage().rss / 1e6);
const t = async <T>(f: () => Promise<T>): Promise<[T, number]> => { const t0 = performance.now(); const r = await f(); return [r, Math.round((performance.now() - t0) * 10) / 10]; };
const j = (rec: Record<string, unknown>) => console.log(JSON.stringify(rec));

// Phase A: current pattern
let prev: PGlite | undefined;
const aTimes: number[] = [];
for (let i = 0; i < 30; i += 1) {
  const [, ms] = await t(async () => {
    await prev?.close();
    prev = new PGlite();
    const repo = await PostgresGraphRepository.create(pgliteConnectable(prev));
    await applySeed(repo, seedDemo());
  });
  aTimes.push(ms);
  if (i % 10 === 0) j({ phase: 'A', i, ms, rssMB: rss() });
}
await prev?.close();

// Phase B: reuse + reset
const live = new PGlite();
const bTimes: number[] = [];
for (let i = 0; i < 30; i += 1) {
  const [, ms] = await t(async () => {
    await live.query('DISCARD ALL');
    await live.query('DROP SCHEMA public CASCADE');
    await live.query('CREATE SCHEMA public');
    const repo = await PostgresGraphRepository.create(pgliteConnectable(live));
    await applySeed(repo, seedDemo());
  });
  bTimes.push(ms);
  if (i % 10 === 0) j({ phase: 'B', i, ms, rssMB: rss() });
}

// Phase C: isolation across a reset
const c: Record<string, unknown> = {};
// dirty the DB: row + prepared statement + advisory lock + LISTEN
await live.query(`INSERT INTO users(user_id, org_id, data) VALUES('u-dirty','org-x','{}'::jsonb)`);
await live.query(`PREPARE dirty_stmt AS SELECT 1`);
await live.query(`SELECT pg_advisory_lock(424242)`);
await live.query(`LISTEN dirty_channel`);
await live.query('DISCARD ALL');
await live.query('DROP SCHEMA public CASCADE');
await live.query('CREATE SCHEMA public');
await PostgresGraphRepository.create(pgliteConnectable(live));
// C1: data gone
c.c1_dataGone = (await live.query(`SELECT 1 FROM users WHERE user_id='u-dirty'`)).rows.length === 0;
// C2: sequence restart - insert into a bigserial table, expect seq 1
await live.query(`INSERT INTO auth_audit(phone, kind) VALUES('p','k')`);
c.c2_seqRestart = (await live.query(`SELECT seq FROM auth_audit`)).rows[0]?.['seq'];
// C3: prepared state / locks / notifies
c.c3_preparedGone = (await live.query(`SELECT count(*)::int AS n FROM pg_prepared_statements`)).rows[0]?.['n'] === 0;
c.c3_advisoryLocksGone = (await live.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory'`)).rows[0]?.['n'] === 0;
c.c3_listenersGone = (await live.query(`SELECT count(*)::int AS n FROM pg_listening_channels()`)).rows[0]?.['n'] === 0;
// C4: a second fresh instance boots while reused one is open (file-swap pattern)
const [other, bootMs] = await t(async () => new PGlite());
c.c4_secondBootMs = bootMs;
await other.close();
await live.close();
c.c4_closedCleanly = true;
j({ phase: 'C', ...c, rssMB: rss() });

const stats = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return { min: s[0], p50: s[Math.floor(s.length / 2)], max: s[s.length - 1], sum: Math.round(s.reduce((x, y) => x + y, 0)) }; };
j({ summary: true, A: stats(aTimes), B: stats(bTimes), rssMB: rss() });
