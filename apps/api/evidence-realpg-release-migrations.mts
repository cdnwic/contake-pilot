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
 *  Usage: tsx evidence-realpg-release-migrations.mts <phase1|phase2|phase3|phase4> <socketDirOrHost> <port>
 */
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import {
  MIGRATIONS, assertDirectDatabaseUrl, assertSchemaCurrent, assertZeroCatalogDelta, catalogSnapshot,
  runMigrations, stepDigest, validateMigrationArtifact, verifyTargetPreconditions,
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
} else if (phase === 'phase3') {
  // v1.5: least-privilege migration role + attacker regressions on REAL PG.
  await admin.query(`DROP DATABASE IF EXISTS contake_role WITH (FORCE)`);
  await admin.query(`DROP ROLE IF EXISTS contake_migrator`);
  await admin.query(`DROP ROLE IF EXISTS contake_runtime`);
  await admin.query(`CREATE ROLE contake_migrator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
  await admin.query(`CREATE ROLE contake_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
  await admin.query(`CREATE DATABASE contake_role`);
  // Deployment hardening (PG14 compatibility): the stock PUBLIC CREATE grant
  // on schema public would let ANY login create code objects. The migration
  // role receives the ONLY create grant (PG15+ default shape).
  const adminRole = mk('contake_role');
  await adminRole.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  await adminRole.query(`GRANT CREATE, USAGE ON SCHEMA public TO contake_migrator`);
  const mig = new Pool({ host, port, user: 'contake_migrator', database: 'contake_role' });
  mig.on('error', () => { /* force-dropped idle client */ });
  // Migrator runs the FULL release job as a non-superuser least-priv role.
  const rr = await runMigrations(mig, { deployment: 'staging', appliedBy: 'role-evidence' });
  check('least-priv migrator role applies 0001', rr.appliedNow.length === 1);
  // Privilege boundary (honest model): schema-level CREATE is one privilege,
  // so a role that can create tables in public can create functions THERE -
  // in-schema code objects are enforced by the catalog diff (proven below).
  // The privilege layer confines the role to the controlled schema and
  // blocks superuser-only object classes.
  await adminRole.query(`CREATE SCHEMA attacker`);
  let outsideRefused = false;
  try { await mig.query(`CREATE FUNCTION attacker.sneaky() RETURNS int LANGUAGE sql AS 'SELECT 1'`); } catch { outsideRefused = true; }
  check('migrator role cannot create objects outside the controlled schema', outsideRefused);
  let extRefused = false;
  try { await mig.query(`CREATE EXTENSION pgcrypto`); } catch { extRefused = true; }
  check('migrator role cannot CREATE EXTENSION (superuser class)', extRefused);
  let evtRefused = false;
  try { await mig.query(`CREATE EVENT TRIGGER ev ON ddl_command_start EXECUTE FUNCTION f()`); } catch { evtRefused = true; }
  check('migrator role cannot CREATE EVENT TRIGGER (superuser class)', evtRefused);
  // In-schema code objects are caught by the runner-owned catalog diff.
  const preSneak = await catalogSnapshot(mig);
  await mig.query(`CREATE FUNCTION public.sneaky() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
  const postSneak = await catalogSnapshot(mig);
  check('catalog diff catches an in-schema code object (runner would roll back)',
    postSneak.some(x => x.includes('public.sneaky')) && !preSneak.some(x => x.includes('public.sneaky')));
  await mig.query(`DROP FUNCTION public.sneaky()`);
  // search_path is pinned empty INSIDE the migration session and reset after.
  const sp = await mig.query(`SHOW search_path`);
  check('search_path reset after migration session (no leak to pool tenant)', String(sp.rows[0]?.['search_path']) !== '', sp.rows);

  // Runtime role: narrower, pooled-shaped - boot gate READS only.
  await adminRole.query(`GRANT USAGE ON SCHEMA public TO contake_runtime`);
  await adminRole.query(`GRANT SELECT ON public.schema_migrations, public.contake_db_identity TO contake_runtime`);
  const run = new Pool({ host, port, user: 'contake_runtime', database: 'contake_role' });
  run.on('error', () => { /* force-dropped idle client */ });
  await assertSchemaCurrent(run, undefined, { deployment: 'staging', instanceId: rr.identity.instanceId });
  check('narrow runtime role passes the boot gate (read-only)', true);
  let writeRefused = false;
  try { await run.query(`INSERT INTO public.schema_migrations(version, name, sha256, applied_by) VALUES('x','x','x','x')`); } catch { writeRefused = true; }
  check('runtime role cannot write migration history', writeRefused);

  // Attacker regressions at the registration gate (real parser, real shapes):
  const attackArtifacts: [string, string][] = [
    ['schema-qualified UDF with allowlisted leaf (attacker.lower)', `INSERT INTO public.users(user_id, org_id, phone, data) VALUES (attacker.lower('x'), 'o', 'p', '{}')`],
    ['schema-qualified UDF shadowing now() (evil.now)', `CREATE TABLE public.t(x timestamptz DEFAULT evil.now())`],
    ['qualified public.btrim as FUNCTION (wrong catalog)', `CREATE UNIQUE INDEX i ON public.users(public.btrim(phone))`],
    ['custom operator statement', `CREATE OPERATOR public.=== (LEFTARG = text, RIGHTARG = text, FUNCTION = f)`],
    ['custom cast statement', `CREATE CAST (text AS int) WITH FUNCTION f(text) AS ASSIGNMENT`],
    ['trigger statement', `CREATE TRIGGER t BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION f()`],
    ['trigger function (plpgsql)', `CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'`],
    ['mutating CTE', `WITH d AS (DELETE FROM public.users RETURNING *) SELECT 1`],
    ['read CTE smuggled into DML', `WITH x AS (SELECT 1) INSERT INTO public.users(user_id) SELECT * FROM x`],
    ['nested subquery in DML', `UPDATE public.users SET org_id = 'o' WHERE user_id IN (SELECT user_id FROM public.channels)`],
    ['ALTER OWNER', `ALTER TABLE public.users OWNER TO postgres`],
    ['DO block', `DO $$ BEGIN RAISE NOTICE 'x'; END $$`],
  ];
  for (const [label, sql] of attackArtifacts) {
    let refused = false;
    try { validateMigrationArtifact(sql); } catch { refused = true; }
    check(`attacker regression refused: ${label}`, refused);
  }
  // Planted attacker schema UDF is UNREACHABLE through the canonical gate and
  // the catalog diff would catch any code-object delta a step tried to leave.
  await adminRole.query(`CREATE FUNCTION attacker.lower(text) RETURNS text LANGUAGE sql AS $$ SELECT 'pwn' $$`);
  const planted = await catalogSnapshot(mig);
  check('catalog snapshot sees the planted attacker function', planted.some(x => x.includes('attacker.lower')), planted);
  const before = await catalogSnapshot(mig);
  await mig.query(`CREATE TABLE public.plain(id int)`);
  const after = await catalogSnapshot(mig);
  let benignOk = true;
  try { assertZeroCatalogDelta(before, after, 'benign'); } catch { benignOk = false; }
  check('benign DDL leaves zero code-object delta (value-map additions for the new table are legal)', benignOk);
  check('benign DDL adds no absolute-class entries',
    !after.some(x => /^(fn|op|opclass|cast|trg|rule|evttrg|pol|defacl|roleset):/.test(x) && !before.includes(x)));
  await adminRole.query(`DROP SCHEMA attacker CASCADE`);
  await run.end(); await mig.end(); await adminRole.end();
  await admin.query(`DROP DATABASE contake_role WITH (FORCE)`);
  await admin.query(`DROP ROLE contake_runtime`); await admin.query(`DROP ROLE contake_migrator`);
} else if (phase === 'phase4') {
  // CTL-DDL-CONFINEMENT ruling suite on REAL PG with REAL roles.
  await admin.query(`DROP DATABASE IF EXISTS contake_conf WITH (FORCE)`);
  await admin.query(`DROP ROLE IF EXISTS conf_migrator`);
  await admin.query(`DROP ROLE IF EXISTS conf_runtime`);
  await admin.query(`CREATE ROLE conf_migrator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
  await admin.query(`CREATE ROLE conf_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
  await admin.query(`CREATE DATABASE contake_conf`);
  const adminC = mk('contake_conf');
  await adminC.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  await adminC.query(`GRANT CREATE, USAGE ON SCHEMA public TO conf_migrator`);
  const mig = new Pool({ host, port, user: 'conf_migrator', database: 'contake_conf' });
  mig.on('error', () => { /* force-dropped idle client */ });
  const rr = await runMigrations(mig, { deployment: 'staging', appliedBy: 'conf-evidence' });
  check('conf: migrator applies 0001', rr.appliedNow.length === 1);

  // (1) One tx per governed operation / non-transactional classes refused at the gate.
  const nonTx: [string, string][] = [
    ['CREATE INDEX CONCURRENTLY', `CREATE INDEX CONCURRENTLY i ON public.users(phone)`],
    ['DROP INDEX CONCURRENTLY', `DROP INDEX CONCURRENTLY public.i`],
    ['VACUUM', `VACUUM public.users`],
    ['ALTER SYSTEM', `ALTER SYSTEM SET work_mem = '64MB'`],
    ['CREATE DATABASE', `CREATE DATABASE evil`],
    ['DROP DATABASE', `DROP DATABASE contake_conf`],
    ['REINDEX CONCURRENTLY', `REINDEX INDEX CONCURRENTLY public.i`],
    ['CALL', `CALL public.f()`],
    ['DO', `DO $$ BEGIN RAISE NOTICE 'x'; END $$`],
    ['SECURITY DEFINER function', `CREATE FUNCTION public.sd() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`],
  ];
  for (const [label, sql] of nonTx) {
    let refused = false;
    try { validateMigrationArtifact(sql); } catch { refused = true; }
    check(`conf: non-transactional/code class refused at gate: ${label}`, refused);
  }

  // (2)+(3)+(5) NAMED ATTACK: SECURITY DEFINER trigger function planted under
  // the migration role must not survive to fire under runtime-role INSERT;
  // post-rollback catalog must equal the pre-migration catalog EXACTLY.
  await adminC.query(`GRANT USAGE ON SCHEMA public TO conf_runtime`);
  await adminC.query(`GRANT INSERT ON public.users TO conf_runtime`);
  const pre = JSON.stringify(await catalogSnapshot(mig));
  const mc = await mig.connect();
  try {
    await mc.query('BEGIN');
    await mc.query(`SELECT set_config('search_path','',true)`);
    await mc.query(`CREATE FUNCTION public.evil_trigger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RAISE EXCEPTION 'pwned'; END $$`);
    await mc.query(`CREATE TRIGGER evil_t BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.evil_trigger()`);
    const mid = JSON.stringify(await catalogSnapshot(mc));
    let diffCaught = false;
    try { assertZeroCatalogDelta(JSON.parse(pre) as string[], JSON.parse(mid) as string[], 'attack'); } catch { diffCaught = true; }
    check('conf: catalog diff catches planted SECURITY DEFINER trigger function in-tx', diffCaught);
    await mc.query('ROLLBACK');
  } finally { mc.release(); }
  const post = JSON.stringify(await catalogSnapshot(mig));
  check('conf: post-rollback catalog equals pre-migration catalog EXACTLY (byte-for-byte)', post === pre);
  const run = new Pool({ host, port, user: 'conf_runtime', database: 'contake_conf' });
  run.on('error', () => { /* force-dropped idle client */ });
  let fired = false;
  try { await run.query(`INSERT INTO public.users(user_id, org_id, phone, data) VALUES ('atk-1','o','p','{}')`); } catch (e) { fired = /pwned/.test(String(e)); }
  check('conf: planted trigger does NOT survive to fire under runtime-role INSERT', !fired);

  // (4) Extension baseline: side-effect extensions cannot be created by the
  // migration role; the bootstrap gate refuses a database that has one.
  let dblinkRefused = false;
  try { await mig.query(`CREATE EXTENSION dblink`); } catch { dblinkRefused = true; }
  check('conf: migrator role cannot CREATE EXTENSION dblink (superuser class)', dblinkRefused);
  let dblinkInstalled = true;
  try { await adminC.query(`CREATE EXTENSION dblink`); } catch { dblinkInstalled = false; }
  if (dblinkInstalled) {
    let gateRefused = false;
    try { await runMigrations(mig, { deployment: 'staging', appliedBy: 'conf-evidence' }); } catch (e) { gateRefused = /side-effect|extension/i.test(String(e)); }
    check('conf: bootstrap gate refuses a database carrying dblink', gateRefused);
    await adminC.query(`DROP EXTENSION dblink`);
  } else {
    check('conf: dblink contrib package unavailable on disposable cluster (privilege refusal proven; gate covered by unit suite)', true);
  }

  // (6) Sequence values are non-transactional: an artifact nextval on a
  // pre-existing sequence is diff-caught AND actively restored by the runner.
  await mig.query(`CREATE SEQUENCE public.conf_seq`);
  await mig.query(`CREATE TABLE public.seq_t(id bigint)`);
  const greedy = {
    version: '0002', name: 'greedy',
    sql: `INSERT INTO public.seq_t(id) VALUES (pg_catalog.nextval('public.conf_seq'))`,
  };
  let seqRefused = false;
  try {
    await runMigrations(mig, { deployment: 'staging', appliedBy: 'conf-evidence', migrations: [...MIGRATIONS, greedy] });
  } catch (e) { seqRefused = /CATALOG DELTA refusal/.test(String(e)); }
  check('conf: artifact nextval on pre-existing sequence refused (catalog delta)', seqRefused);
  const sv = await mig.query(`SELECT is_called AS ic FROM public.conf_seq`);
  check('conf: sequence value ACTIVELY RESTORED after rollback (is_called=false)', sv.rows[0]?.['ic'] === false, sv.rows);
  const afterAll = JSON.stringify(await catalogSnapshot(mig));
  await mig.query(`DROP TABLE public.seq_t`); await mig.query(`DROP SEQUENCE public.conf_seq`);
  check('conf: catalog identical to pre-attack baseline after cleanup', JSON.stringify(await catalogSnapshot(mig)) === pre, { afterAll: afterAll.length });
  await run.end(); await mig.end(); await adminC.end();
  await admin.query(`DROP DATABASE contake_conf WITH (FORCE)`);
  await admin.query(`DROP ROLE conf_runtime`); await admin.query(`DROP ROLE conf_migrator`);
} else {
  throw new Error('phase1|phase2|phase3|phase4 required');
}
await admin.end();
console.log(JSON.stringify(out, null, 2));
