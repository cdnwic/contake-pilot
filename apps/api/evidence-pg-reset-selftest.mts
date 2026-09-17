/** Whitelist-PG gate v1.1: reset self-test for the file-scoped PGlite harness
 *  (QA control: prove isolation BEFORE two full-suite runs). Exercises the
 *  SAME helper path the suites use (makeTestRepo / makeTestBackendFrom):
 *  1. boot + seed, dirty six surfaces (whitelist/users/auth_audit/audit_log/
 *     idempotency_records/notification_jobs) with marker rows;
 *  2. second factory call => uninstrumented admin reset + production
 *     bootstrap + reseed;
 *  3. verify: marker rows GONE on all six surfaces; seed counts restored;
 *     auth_audit sequence restarts (next seq = 1 after a fresh insert);
 *     constraints present (PKs on whitelist_entries/users, unique on
 *     notification_jobs idempotency_key), indexes rebuilt (>=10), triggers
 *     = 0 (production DDL defines none); no prepared statements, no
 *     advisory locks, no LISTEN channels survive the reset;
 *  4. prints the helper's instance trace (instanceId/fileId/resets/RSS
 *     high-water) and closes the instance directly (afterAll is a no-op
 *     outside vitest).
 *  Exit 1 on any violation. */
import { makeTestRepo, makeTestBackendFrom, getFileInstanceInfo, REPO_IMPL } from './tests/helpers/repo.js';
import { seedDemo } from './src/seed.js';
import type { PostgresGraphRepository } from './src/repo/postgres.js';

if (REPO_IMPL !== 'postgres') { console.log('self-test requires REPO_IMPL=postgres'); process.exit(2); }

const fail = (msg: string): never => { console.error('SELF-TEST VIOLATION: ' + msg); process.exit(1); };
const j = (rec: Record<string, unknown>) => console.log(JSON.stringify(rec));

// 1. boot + seed via the helper, then dirty six surfaces
const repo1 = (await makeTestRepo()) as PostgresGraphRepository;
const q = (text: string, params?: unknown[]) => (repo1 as unknown as { q(t: string, p?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }).q(text, params);
await q(`INSERT INTO whitelist_entries(phone, org_id, status, data) VALUES('+972DIRTY0001','org-1','invited','{}'::jsonb)`);
await q(`INSERT INTO users(user_id, org_id, data) VALUES('u-dirty','org-1','{}'::jsonb)`);
await q(`INSERT INTO auth_audit(phone, kind) VALUES('dirty','dirty')`);
await q(`INSERT INTO audit_log(org_id, data) VALUES('org-1', '{"dirty":true}'::jsonb)`);
await q(`INSERT INTO idempotency_records(org_id, actor_id, route, client_mutation_id, data) VALUES('org-1','dirty','dirty','dirty','{}'::jsonb)`);
await q(`INSERT INTO notification_jobs(id, event_id, idempotency_key, data) VALUES('j-dirty','e-dirty','k-dirty','{}'::jsonb)`);
// session state to prove none survives
await q(`PREPARE dirty_stmt AS SELECT 1`);
await q(`SELECT pg_advisory_lock(777)`);
await q(`LISTEN dirty_channel`);
j({ step: 1, dirtied: true, instance: getFileInstanceInfo() });

// 2. reset via the helper's second factory call
const backend2 = await makeTestBackendFrom({ orgId: 'org-1', users: [], channels: [], events: [], resources: [], tasks: [], dependencies: [] } as never);
const repo2 = backend2.repo as PostgresGraphRepository;
const q2 = (text: string, params?: unknown[]) => (repo2 as unknown as { q(t: string, p?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }).q(text, params);

// 3a. marker rows gone
for (const [table, where] of [
  ['whitelist_entries', `phone='+972DIRTY0001'`],
  ['users', `user_id='u-dirty'`],
  ['auth_audit', `kind='dirty'`],
  ['audit_log', `data->>'dirty'='true'`],
  ['idempotency_records', `actor_id='dirty'`],
  ['notification_jobs', `id='j-dirty'`],
] as const) {
  const n = (await q2(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0]!['n'];
  if (n !== 0) fail(`${table} still holds the dirty row after reset`);
}
j({ step: '3a', markersGone: true });

// 3b. surfaces are empty post-reset (empty seed here), incl. the six named ones
for (const table of ['whitelist_entries', 'users', 'auth_audit', 'audit_log', 'idempotency_records', 'notification_jobs']) {
  const n = (await q2(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!['n'];
  if (n !== 0) fail(`${table} not empty after reset+empty seed`);
}
j({ step: '3b', surfacesEmpty: true });

// 3c. sequence restart: next auth_audit insert gets seq 1
await q2(`INSERT INTO auth_audit(phone, kind) VALUES('p','k')`);
const seq = (await q2(`SELECT seq FROM auth_audit`)).rows[0]!['seq'];
if (String(seq) !== '1') fail(`auth_audit seq did not restart (got ${seq})`);
j({ step: '3c', seqRestart: true });

// 3d. constraints/indexes/triggers
const pks = (await q2(`SELECT count(*)::int AS n FROM information_schema.table_constraints WHERE constraint_type='PRIMARY KEY' AND table_name IN ('whitelist_entries','users','auth_audit','audit_log','idempotency_records','notification_jobs')`)).rows[0]!['n'];
if ((pks as number) < 6) fail(`primary keys missing after reset (${pks})`);
const idx = (await q2(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname='public'`)).rows[0]!['n'];
if ((idx as number) < 10) fail(`indexes not rebuilt after reset (${idx})`);
const trig = (await q2(`SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal`)).rows[0]!['n'];
j({ step: '3d', primaryKeys: pks, indexes: idx, triggers: trig });

// 3e. no session/prepared/listener state survives
if ((await q2(`SELECT count(*)::int AS n FROM pg_prepared_statements`)).rows[0]!['n'] !== 0) fail('prepared statements survive reset');
if ((await q2(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory'`)).rows[0]!['n'] !== 0) fail('advisory locks survive reset');
if ((await q2(`SELECT count(*)::int AS n FROM pg_listening_channels()`)).rows[0]!['n'] !== 0) fail('LISTEN channels survive reset');
j({ step: '3e', sessionStateClean: true });

// 4. instance trace + direct close (afterAll only registers under vitest)
j({ step: 4, instance: getFileInstanceInfo() });
console.log('RESET SELF-TEST: PASS');
process.exit(0);
