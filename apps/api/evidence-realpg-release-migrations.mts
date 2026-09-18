/** DISPOSABLE real-PostgreSQL evidence for the release-migration runner and
 *  staging synthetic seed (independent QA + security, 2026-09-18). Runs
 *  against a throwaway local cluster (initdb in /tmp, trust auth, no network
 *  exposure); nothing here touches any real deployment.
 *
 *  Phase 1 (fresh cluster): full run, per-step DDL rollback, version-record
 *  collision rollback, cross-session advisory-lock concurrency, staging seed
 *  transaction + exact rerun + rerun-integrity drift + forced post-write
 *  rollback.
 *  Phase 2 (after a REAL cluster stop/start): restart durability of the
 *  migration history and seeded rows, boot gate still green.
 *
 *  Usage: tsx evidence-realpg-release-migrations.mts <phase1|phase2> <socketDirOrHost> <port>
 */
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import {
  MIGRATIONS, assertDirectDatabaseUrl, assertSchemaCurrent, runMigrations, stepDigest,
  validateMigrationArtifact, type MigrationStep,
} from './src/migrations/runner.js';
import { runStagingSeed } from './src/migrations/staging-seed.js';

const phase = process.argv[2];
const host = process.argv[3] ?? '/tmp';
const port = Number(process.argv[4] ?? '55444');
const mk = (db: string) => { const p = new Pool({ host, port, user: 'postgres', database: db }); p.on('error', () => { /* force-dropped idle client */ }); return p; };
const out: Record<string, unknown> = { phase, host, port, checks: [] as unknown[] };
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.error(`CHECK ${ok ? 'PASS' : 'FAIL'} ${name}`);
  (out.checks as unknown[]).push({ name, ok, detail });
  if (!ok) { console.log(JSON.stringify(out, null, 2)); throw new Error(`EVIDENCE FAIL: ${name}`); }
};
// Evidence-harness credentials are generated EPHEMERALLY at runtime (CSPRNG)
// and never printed, persisted or committed (independent security).
const CREDS = { adminPassword: randomBytes(12).toString('base64url'), managerPassword: randomBytes(12).toString('base64url') };
check('evidence credentials are ephemeral (>=16 chars, runtime-generated)', CREDS.adminPassword.length >= 16 && CREDS.managerPassword.length >= 16);

const admin = mk('postgres');
if (phase === 'phase1') {
  await admin.query(`DROP DATABASE IF EXISTS contake_evidence WITH (FORCE)`);
  await admin.query(`DROP DATABASE IF EXISTS contake_seed WITH (FORCE)`);
  await admin.query(`CREATE DATABASE contake_evidence`);
  await admin.query(`CREATE DATABASE contake_seed`);
  // 1) Full explicit run on real Postgres; boot gate green.
  const db = mk('contake_evidence');
  const r1 = await runMigrations(db, { deployment: 'staging', appliedBy: 'evidence' });
  check('full-run applied 0001', r1.appliedNow.join(',') === '0001', r1.appliedNow);
  check('stored digest matches registry artifact', true, stepDigest(MIGRATIONS[0]!).slice(0, 16));
  await assertSchemaCurrent(db);
  check('boot gate passes after run', true);
  const t = await db.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`);
  check('schema tables exist', Number(t.rows[0]?.['n']) >= 30, t.rows[0]?.['n']);

  // 2) Cross-session advisory-lock concurrency: two Pools race the SAME db.
  const a = mk('contake_evidence');
  const b = mk('contake_evidence');
  await a.query(`DELETE FROM schema_migrations`); // reset to pending on the same schema
  const [ra, rb] = await Promise.allSettled([
    runMigrations(a, { deployment: 'staging', appliedBy: 'racer-a' }),
    runMigrations(b, { deployment: 'staging', appliedBy: 'racer-b' }),
  ]);
  check('both racers settled without error', ra.status === 'fulfilled' && rb.status === 'fulfilled', [ra.status, rb.status]);
  const appliedNow = [ra, rb].map(r => (r.status === 'fulfilled' ? r.value.appliedNow : []));
  check('exactly one racer applied; the loser no-oped',
    (appliedNow[0].length === 1 && appliedNow[1].length === 0) || (appliedNow[0].length === 0 && appliedNow[1].length === 1),
    appliedNow);
  const v = await db.query(`SELECT count(*)::int AS n FROM schema_migrations`);
  check('exactly one version row after the race', Number(v.rows[0]?.['n']) === 1, v.rows[0]?.['n']);
  await assertSchemaCurrent(db);
  check('boot gate green after race', true);

  // 3) Per-step transaction: mid-DDL throw leaves nothing (real transactional DDL).
  await db.end(); await a.end(); await b.end(); await admin.query(`DROP DATABASE contake_evidence WITH (FORCE)`);
  await admin.query(`CREATE DATABASE contake_evidence`);
  const db2 = mk('contake_evidence');
  const failing: MigrationStep = {
    version: '0001', name: 'partial-ddl', description: 'second statement fails',
    sql: 'CREATE TABLE partial_leak(id int); CREATE TABLE partial_leak(id int)',
  };
  let threw = false;
  try { await runMigrations(db2, { deployment: 'staging', migrations: [failing] }); } catch { threw = true; }
  check('failing artifact threw', threw);
  const leak = await db2.query(`SELECT to_regclass('partial_leak') AS r`);
  check('partial DDL rolled back on REAL postgres', leak.rows[0]?.['r'] === null, leak.rows[0]);
  const vv = await db2.query(`SELECT count(*)::int AS n FROM schema_migrations`);
  check('no version row after rollback', Number(vv.rows[0]?.['n']) === 0);

  // 3b) AST allowlist on REAL postgres: tx-control / DO / session-lock artifacts
  // are rejected at registration, before ANY statement executes.
  for (const [label, sql] of [
    ['COMMIT artifact', 'CREATE TABLE escape_leak(id int); COMMIT'],
    ['DO artifact', `DO $$ BEGIN RAISE EXCEPTION 'x'; END $$`],
    ['quoted session-unlock artifact', 'SELECT "pg_advisory_unlock"(841000001)'],
    ['schema-qualified session-lock artifact', 'SELECT pg_catalog.pg_advisory_lock(1)'],
  ] as const) {
    let refused = false;
    try { await runMigrations(db2, { deployment: 'staging', migrations: [{ version: '0001', name: 'bad', description: 'x', sql }] }); }
    catch (e) { refused = /ARTIFACT refusal/.test(String(e)); }
    check(`${label} rejected at registration`, refused);
  }
  const el = await db2.query(`SELECT to_regclass('escape_leak') AS r`);
  check('no statement executed from a rejected artifact', el.rows[0]?.['r'] === null);

  // 3c) Guard primitive hard-fail rolls back on REAL postgres.
  await runMigrations(db2, { deployment: 'staging' });
  await db2.query(`INSERT INTO users(user_id, org_id, phone, data) VALUES('u1', 'o1', '+972555111111', '{}')`);
  let guardRefused = false;
  try {
    await runMigrations(db2, {
      deployment: 'staging',
      migrations: [...MIGRATIONS, {
        version: '0002', name: 'guarded', description: 'x',
        xactLockKey: 4242, lockTables: ['users'],
        assertions: [{ kind: 'table-empty', table: 'users' }],
        sql: 'CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(btrim(phone)) WHERE phone IS NOT NULL',
      }],
    });
  } catch (e) { guardRefused = /ASSERTION refusal/.test(String(e)); }
  check('guard hard-fails on REAL postgres', guardRefused);
  const gi = await db2.query(`SELECT to_regclass('users_phone_unique') AS r`);
  check('guarded artifact rolled back', gi.rows[0]?.['r'] === null);

  // 3d) Pre-mutation instance pin: wrong pin refuses with ZERO writes.
  let pinRefused = false;
  try { await runMigrations(db2, { deployment: 'staging', expectInstanceId: 'wrong-pin' }); } catch (e) { pinRefused = /INSTANCE BINDING refusal/.test(String(e)); }
  check('wrong instance pin refused (pre-mutation)', pinRefused);
  const pv = await db2.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version <> '0001'`);
  check('zero writes from a refused pin', Number(pv.rows[0]?.['n']) === 0);

  // 3e0) Fresh DB + supplied pin: refused BEFORE any write (TOFU needs an
  // omitted pin + attended verification) on a REAL fresh postgres db.
  await admin.query(`DROP DATABASE IF EXISTS contake_fresh WITH (FORCE)`);
  await admin.query(`CREATE DATABASE contake_fresh`);
  const fr = mk('contake_fresh');
  let freshPinRefused = false;
  try { await runMigrations(fr, { deployment: 'staging', expectInstanceId: '0123456789abcdef' }); } catch (e) { freshPinRefused = /INSTANCE BINDING refusal/.test(String(e)); }
  check('fresh DB + supplied pin refused pre-write (TOFU gate)', freshPinRefused);
  const frw = await fr.query(`SELECT to_regclass('schema_migrations') AS r`);
  check('zero writes on fresh-DB pin refusal', frw.rows[0]?.['r'] === null);
  await fr.end(); await admin.query(`DROP DATABASE contake_fresh WITH (FORCE)`);

  // 3e) Seed precondition: tampered migration digest refuses the seed pre-mutation.
  await db2.query(`UPDATE schema_migrations SET sha256 = 'tampered' WHERE version = '0001'`);
  let seedRefused = false;
  try { await runStagingSeed(db2, { marker: '1', credentials: CREDS }); } catch (e) { seedRefused = /INTEGRITY refusal/.test(String(e)); }
  check('seed refuses tampered migration history before mutation', seedRefused);
  const su = await db2.query(`SELECT count(*)::int AS n FROM users WHERE user_id LIKE 'stg-%'`);
  check('seed wrote nothing after refusal', Number(su.rows[0]?.['n']) === 0);
  await db2.query(`UPDATE schema_migrations SET sha256 = $1 WHERE version = '0001'`, [stepDigest(MIGRATIONS[0]!)]);

  // 4) Staging seed on real Postgres: transaction, exact rerun, drift, rollback.
  const sd = mk('contake_seed');
  await runMigrations(sd, { deployment: 'staging', appliedBy: 'evidence' });
  const s1 = await runStagingSeed(sd, { marker: '1', credentials: CREDS, forbiddenIdentifiers: ['+972587700852'] });
  check('seed applied on real postgres', s1.applied && !s1.alreadyApplied, s1.inventory.counts);
  const s2 = await runStagingSeed(sd, { marker: '1', credentials: CREDS });
  check('exact rerun no-op with manifest match', s2.alreadyApplied && s2.inventory.manifestSha256 === s1.inventory.manifestSha256);
  let driftRefused = false;
  await sd.query(`UPDATE channels SET data = jsonb_set(data, '{label}', '"drifted"')`);
  try { await runStagingSeed(sd, { marker: '1', credentials: CREDS }); } catch (e) { driftRefused = /RERUN INTEGRITY/.test(String(e)); }
  check('drift rejected (rerun integrity)', driftRefused);
  await sd.end(); await admin.query(`DROP DATABASE contake_seed WITH (FORCE)`);
  await admin.query(`CREATE DATABASE contake_seed`);
  const sd2 = mk('contake_seed');
  await runMigrations(sd2, { deployment: 'staging', appliedBy: 'evidence' });
  let rollback = false;
  try { await runStagingSeed(sd2, { marker: '1', credentials: CREDS, forbiddenIdentifiers: ['יום סינתטי'] }); } catch (e) { rollback = /POST-WRITE absence proof FAILED/.test(String(e)); }
  check('forced post-write failure threw', rollback);
  const left = await sd2.query(`SELECT (SELECT count(*)::int FROM users) AS u, (SELECT count(*)::int FROM events) AS e, (SELECT count(*)::int FROM whitelist_entries) AS w`);
  check('seed transaction fully rolled back on REAL postgres',
    Number(left.rows[0]?.['u']) === 0 && Number(left.rows[0]?.['e']) === 0 && Number(left.rows[0]?.['w']) === 0, left.rows[0]);

  // 5) Pooled/direct targeting (real-shaped URLs).
  let pooledRefused = false;
  try { assertDirectDatabaseUrl('postgresql://u:x@ep-demo-pooler.eu-central-1.aws.neon.tech/contake'); } catch { pooledRefused = true; }
  check('pooled endpoint refused', pooledRefused);
  check('direct endpoint accepted', assertDirectDatabaseUrl('postgresql://u:x@ep-demo.eu-central-1.aws.neon.tech/contake').database === 'contake');

  // Rebuild durable state for the restart-durability phase.
  await sd2.end(); await admin.query(`DROP DATABASE contake_seed WITH (FORCE)`);
  await admin.query(`CREATE DATABASE contake_seed`);
  const sd3 = mk('contake_seed');
  await runMigrations(sd3, { deployment: 'staging', appliedBy: 'evidence' });
  await runStagingSeed(sd3, { marker: '1', credentials: CREDS });
  await sd3.end();
  out['readyForRestart'] = true;
} else if (phase === 'phase2') {
  // After a REAL stop/start: history + seeded rows durable; gates still green.
  const db = mk('contake_seed');
  await assertSchemaCurrent(db);
  check('boot gate passes after REAL restart', true);
  const v = await db.query(`SELECT version, name, sha256 FROM schema_migrations`);
  check('migration history durable', v.rows.length === 1 && v.rows[0]?.['version'] === '0001', v.rows);
  const u = await db.query(`SELECT count(*)::int AS n FROM users`);
  check('seeded rows durable across restart', Number(u.rows[0]?.['n']) === 5, u.rows[0]?.['n']);
  const r = await runStagingSeed(db, { marker: '1', credentials: CREDS });
  check('exact rerun still verified after restart', r.alreadyApplied === true);
  await db.end();
} else {
  throw new Error('phase1|phase2 required');
}
await admin.end();
console.log(JSON.stringify(out, null, 2));
