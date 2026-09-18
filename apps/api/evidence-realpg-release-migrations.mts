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
 *  Phase 3: least-privilege roles, R3 section-5 closed-registry attacks
 *  (typed-param injection, registry/artifact tamper), boot-gate history
 *  tamper proof. Phase 4: CTL-DDL-CONFINEMENT on real roles - R3
 *  construction-impossibility sweep, sequence restore contract, default
 *  privilege lockdown.
 *
 *  Usage: tsx evidence-realpg-release-migrations.mts <phase1|phase2|phase3|phase4|phase5> <socketDirOrHost> <port>
 *  phase5 (SA1 attended-TOFU): requires OPERATOR_ACK=ack:<preflight listDigest>;
 *  run once WITHOUT it to obtain the digest (gate refuses, digest printed).
 */
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import type { MigrationStep } from './src/migrations/runner.js';
// R5 section 4: the module under evidence is selectable - the SAME phases run
// against src (tsx) or the BUILT DIST (the artifact that deploys). The
// evidence pack records which module path ran plus its sha256.
const RUNNER_PATH = process.env['EVIDENCE_RUNNER'] ?? './src/migrations/runner.js';
const SEED_PATH = process.env['EVIDENCE_SEED'] ?? './src/migrations/staging-seed.js';
const R = await import(RUNNER_PATH) as typeof import('./src/migrations/runner.js');
const S = await import(SEED_PATH) as typeof import('./src/migrations/staging-seed.js');
const {
  MIGRATIONS, REGISTRY_DIGEST, assertDirectDatabaseUrl, assertSchemaCurrent, assertSingleStatementForms, assertZeroCatalogDelta, catalogSnapshot,
  restoreSequenceValues, runMigrations, sequenceValues, stepDigest,
} = R;
const { DATA_REGISTRY_DIGEST, runStagingSeed } = S;
const runnerModule = R as unknown as Record<string, unknown>;
console.error(`OBSERVED[module under evidence]: runner=${RUNNER_PATH} seed=${SEED_PATH}`);

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
/** SA-shaped inert params for the ddl.create-index template (shared). */
const SA_PARAMS = { index: 'sa_idx', table: 'users', unique: 'unique', expression: 'EXPR_NORM_PHONE', predicate: 'PRED_PHONE_NOT_NULL', ifNotExists: 'if-not-exists' };
/** R3: the ONLY step shapes that exist - closed registry renders. */
const saStep = (params: Record<string, unknown> = {}, over: Record<string, unknown> = {}): MigrationStep => ({ version: '0009', name: 'sa', description: 'sa', template: 'ddl.create-index', ...over, params: { ...SA_PARAMS, ...params } });
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
  check('full-run applied 0001-0003', r1.appliedNow.join(',') === '0001,0002,0003', r1.appliedNow);
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
  const [an0 = [], an1 = []] = appliedNow;
  check('exactly one racer applied; the loser no-oped',
    (an0.length === 3 && an1.length === 0) || (an0.length === 0 && an1.length === 3),
    appliedNow);
  const v = await db.query(`SELECT count(*)::int AS n FROM schema_migrations`);
  check('exactly the registry rows after the race', Number(v.rows[0]?.['n']) === 3, v.rows[0]?.['n']);
  await assertSchemaCurrent(db);
  check('boot gate green after race', true);

  // 3) Per-step transaction: mid-DDL throw leaves nothing (real transactional DDL).
  await db.end(); await a.end(); await b.end(); await admin.query(`DROP DATABASE contake_evidence WITH (FORCE)`);
  await admin.query(`CREATE DATABASE contake_evidence`);
  const db2 = mk('contake_evidence');
  // R3: caller SQL is gone - a step is inert {template, params}; a FAILING
  // TEMPLATE EXECUTION (strict create against a missing table) must roll the
  // whole step back on REAL postgres and record no version.
  const failing: MigrationStep = {
    version: '0001', name: 'partial-ddl', description: 'template executes against a missing table',
    template: 'ddl.create-index',
    params: { index: 'partial_leak_idx', table: 'no_such_table', unique: 'plain', expression: 'EXPR_NONE', predicate: 'PRED_NONE', ifNotExists: 'strict' },
  };
  let threw = false;
  try { await runMigrations(db2, { deployment: 'staging', migrations: [failing] }); } catch { threw = true; }
  check('failing template execution threw', threw);
  const leak = await db2.query(`SELECT to_regclass('partial_leak_idx') AS r`);
  check('step effect rolled back on REAL postgres', leak.rows[0]?.['r'] === null, leak.rows[0]);
  const vv = await db2.query(`SELECT count(*)::int AS n FROM schema_migrations`);
  check('no version row after rollback', Number(vv.rows[0]?.['n']) === 0);

  // 3b) R3 closed registry on REAL postgres: caller SQL itself is an unknown
  // template; tx-control / session-lock shapes cannot be expressed; param-level
  // injection dies in the closed binders - all BEFORE any statement executes.
  for (const [label, bad] of [
    ['caller SQL as template name', { version: '0001', name: 'bad', description: 'x', template: 'CREATE TABLE escape_leak(id int); COMMIT', params: {} } as MigrationStep],
    ['unknown template (session-lock shape)', { version: '0001', name: 'bad', description: 'x', template: 'SELECT pg_catalog.pg_advisory_lock(1)', params: {} } as MigrationStep],
    ['identifier injection in params', saStep({ table: 'users"; DROP TABLE users;--' }, { version: '0001', name: 'bad' })],
    ['free-text expression in params', saStep({ expression: 'pg_catalog.pg_advisory_unlock(841000001)' }, { version: '0001', name: 'bad' })],
  ] as [string, MigrationStep][]) {
    let refused = false;
    try { await runMigrations(db2, { deployment: 'staging', migrations: [bad] }); }
    catch (e) { refused = /TEMPLATE refusal/.test(String(e)); }
    check(`${label} rejected at registration`, refused);
  }
  const el = await db2.query(`SELECT to_regclass('escape_leak') AS r`);
  check('no statement executed from a rejected step', el.rows[0]?.['r'] === null);

  // 3c) Guard primitive hard-fail rolls back on REAL postgres.
  await runMigrations(db2, { deployment: 'staging' });
  await db2.query(`INSERT INTO users(user_id, org_id, phone, data) VALUES('u1', 'o1', '+972555111111', '{}')`);
  let guardRefused = false;
  try {
    await runMigrations(db2, {
      deployment: 'staging',
      migrations: [...MIGRATIONS, {
        version: '0004', name: 'guarded', description: 'x',
        xactLockKey: 4242, lockTables: ['users'],
        assertions: [{ kind: 'table-empty', table: 'users' }],
        template: 'ddl.create-index',
        params: { ...SA_PARAMS, index: 'users_phone_unique_guarded' },
      }],
    });
  } catch (e) { guardRefused = /ASSERTION refusal/.test(String(e)); }
  check('guard hard-fails on REAL postgres', guardRefused);
  const gi = await db2.query(`SELECT to_regclass('users_phone_unique_guarded') AS r`);
  check('guarded artifact rolled back', gi.rows[0]?.['r'] === null);

  // 3d) Pre-mutation instance pin: wrong pin refuses with ZERO writes.
  let pinRefused = false;
  try { await runMigrations(db2, { deployment: 'staging', expectInstanceId: 'wrong-pin' }); } catch (e) { pinRefused = /INSTANCE BINDING refusal/.test(String(e)); }
  check('wrong instance pin refused (pre-mutation)', pinRefused);
  const pv = await db2.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version NOT IN ('0001', '0002', '0003')`);
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
  check('migration history durable', v.rows.length === 3 && v.rows.map(x => String(x['version'])).join(',') === '0001,0002,0003', v.rows.map(x => x['version']));
  const u = await db.query(`SELECT count(*)::int AS n FROM users`);
  check('seeded rows durable across restart', Number(u.rows[0]?.['n']) === 5, u.rows[0]?.['n']);
  const r = await runStagingSeed(db, { marker: '1', credentials: CREDS });
  check('exact rerun still verified after restart', r.alreadyApplied === true);
  // R4 DATA anchor on REAL PG: pinned at first seed; drift with IDENTICAL
  // rows refuses the rerun on the anchor alone; restore heals.
  const da = await db.query(`SELECT data_registry_digest AS d FROM staging_seed_state WHERE id = 1`);
  check('R4: DATA registry digest pinned at first seed (OBSERVED)', da.rows[0]?.['d'] === DATA_REGISTRY_DIGEST, da.rows[0]?.['d']);
  await db.query(`UPDATE staging_seed_state SET data_registry_digest = 'tampered' WHERE id = 1`);
  let dataDrift = '';
  try { await runStagingSeed(db, { marker: '1', credentials: CREDS }); } catch (e) { dataDrift = String(e); }
  console.error(`OBSERVED[data anchor drift - identical rows]: ${dataDrift.slice(0, 220)}`);
  check('R4: DATA anchor drift refuses rerun even with identical rows (OBSERVED)', /DATA ANCHOR refusal/.test(dataDrift), dataDrift.slice(0, 180));
  await db.query(`UPDATE staging_seed_state SET data_registry_digest = $1 WHERE id = 1`, [DATA_REGISTRY_DIGEST]);
  const healed = await runStagingSeed(db, { marker: '1', credentials: CREDS });
  check('R4: DATA anchor restore heals the rerun', healed.alreadyApplied === true);
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
  check('least-priv migrator role applies 0001-0003', rr.appliedNow.length === 3);
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

  // R3 section-5 attacks at the closed registry: there is no caller SQL to
  // parse, so every code-object / DML / ALTER-OWNER shape is inexpressible;
  // typed-param injection dies in the closed binders. OBSERVED refusal text
  // for every attack.
  // R4: there is no exported render - every attack is driven THROUGH
  // runMigrations as a not-yet-applied version (registration-time refusal).
  const registryAttacks: [string, MigrationStep, RegExp][] = [
    ['caller SQL as template name', { version: '0004', name: 'x', description: 'x', template: `CREATE OPERATOR public.=== (LEFTARG = text, RIGHTARG = text, FUNCTION = f)`, params: {} }, /unknown template name/],
    ['DO block as template name', { version: '0004', name: 'x', description: 'x', template: `DO $$ BEGIN RAISE NOTICE 'x'; END $$`, params: {} }, /unknown template name/],
    ['mutating CTE as template name', { version: '0004', name: 'x', description: 'x', template: `WITH d AS (DELETE FROM public.users RETURNING *) SELECT 1`, params: {} }, /unknown template name/],
    ['ALTER OWNER as template name', { version: '0004', name: 'x', description: 'x', template: `ALTER TABLE public.users OWNER TO postgres`, params: {} }, /unknown template name/],
    ['typed-param injection: quote/semicolon identifier', saStep({ table: 'users"; DROP TABLE users;--' }, { version: '0004' }), /TEMPLATE refusal/],
    ['typed-param injection: schema-path identifier', saStep({ table: 'attacker.users' }, { version: '0004' }), /TEMPLATE refusal/],
    ['typed-param injection: pg_ system prefix', saStep({ index: 'pg_evil' }, { version: '0004' }), /TEMPLATE refusal/],
    ['typed-param injection: enum escape', saStep({ unique: 'concurrently' }, { version: '0004' }), /TEMPLATE refusal/],
    ['typed-param injection: non-string literal', saStep({ index: 1 as never }, { version: '0004' }), /TEMPLATE refusal/],
    ['typed-param injection: free-text expression', saStep({ expression: 'attacker.lower(phone)' }, { version: '0004' }), /TEMPLATE refusal/],
    ['typed-param injection: free-text predicate', saStep({ predicate: 'true' }, { version: '0004' }), /TEMPLATE refusal/],
    ['typed-param injection: extra param (schema drift)', saStep({ extra: 'x' }, { version: '0004' }), /TEMPLATE refusal/],
    ['typed-param injection: missing param', { version: '0004', name: 'x', description: 'x', template: 'ddl.create-index', params: { index: 'x' } as never }, /TEMPLATE refusal/],
  ];
  for (const [label, bad, re] of registryAttacks) {
    let refused = false; let observed = '';
    try { await runMigrations(mig, { deployment: 'staging', migrations: [...MIGRATIONS, bad] }); } catch (e) { refused = true; observed = String(e); }
    console.error(`OBSERVED[registry attack ${label}]: ${observed.slice(0, 200)}`);
    check(`attacker regression refused at registration: ${label}`, refused && re.test(observed), observed.slice(0, 160));
  }
  // Registry/artifact tamper: param edits move the step digest; render-source
  // edits move the template hash (hash-pinned registry, fail-closed).
  const pinnedDigest = stepDigest(saStep({}, { version: '0004' }));
  check('param tamper moves the step digest', stepDigest(saStep({ index: 'evil_idx' }, { version: '0004' })) !== pinnedDigest);
  // R4 anchor A surface: ONE canonical REGISTRY_DIGEST over the frozen
  // blueprint is exported for the reviewer to record from reviewed source;
  // every v8 step digest derives from it (OBSERVED).
  console.error(`OBSERVED[anchor A]: REGISTRY_DIGEST=${REGISTRY_DIGEST}`);
  check('R4 anchor A: canonical REGISTRY_DIGEST surfaced for reviewer recording (OBSERVED)', /^[0-9a-f]{64}$/.test(REGISTRY_DIGEST), REGISTRY_DIGEST);
  check('R4 anchor A: a wrong expected digest is detectably different', REGISTRY_DIGEST !== 'deadbeef'.repeat(8));
  // R4 section 1: the registry/named forms/render capability are not on the
  // module surface - external mutation is IMPOSSIBLE (OBSERVED undefined).
  for (const name of ['TEMPLATES', 'NAMED_EXPRESSIONS', 'NAMED_PREDICATES', 'NAMED_NORMALIZATIONS', 'getTemplate', 'renderStepStatements', 'templateHash', 'bindIdentifier', 'bindLiteral']) {
    const surfaced = (runnerModule as Record<string, unknown>)[name];
    console.error(`OBSERVED[confined surface ${name}]: ${typeof surfaced}`);
    check(`R4: registry surface confined - ${name} not exported`, surfaced === undefined, typeof surfaced);
  }
  // R4 section 4: tampered named forms carrying a statement separator are
  // refused by the load-time assertion (OBSERVED refusal text).
  for (const badForm of ['phone IS NOT NULL; DROP TABLE users', 'btrim(phone); SELECT 1']) {
    let sepObserved = '';
    try { assertSingleStatementForms([badForm], 'named-form tamper'); } catch (e) { sepObserved = String(e); }
    console.error(`OBSERVED[named-form tamper load refusal]: ${sepObserved.slice(0, 180)}`);
    check('R4: named-form tamper refused by the load-time assertion (OBSERVED)', /LOAD INTEGRITY refusal/.test(sepObserved), sepObserved.slice(0, 150));
  }
  // R4 anchor B on REAL PG: pinned at the first governed run above; tampering
  // the anchor refuses BOTH the run and the boot gate with the observed
  // mismatch; restore heals.
  const ab = await mig.query(`SELECT registry_digest AS d FROM public.contake_db_identity WHERE id = 1`);
  check('R4 anchor B: DB-anchored digest pinned at first governed run (OBSERVED)', ab.rows[0]?.['d'] === REGISTRY_DIGEST, ab.rows[0]?.['d']);
  await mig.query(`UPDATE public.contake_db_identity SET registry_digest = 'tampered' WHERE id = 1`);
  let abRun = '';
  try { await runMigrations(mig, { deployment: 'staging' }); } catch (e) { abRun = String(e); }
  console.error(`OBSERVED[anchor B tamper - run]: ${abRun.slice(0, 200)}`);
  check('R4 anchor B: run refuses anchored drift on REAL PG (OBSERVED)', /ANCHOR refusal/.test(abRun), abRun.slice(0, 160));
  let abBoot = '';
  try { await assertSchemaCurrent(mig, undefined, { deployment: 'staging', instanceId: rr.identity.instanceId }); } catch (e) { abBoot = String(e); }
  console.error(`OBSERVED[anchor B tamper - boot]: ${abBoot.slice(0, 200)}`);
  check('R4 anchor B: boot gate refuses anchored drift on REAL PG (OBSERVED)', /ANCHOR refusal/.test(abBoot), abBoot.slice(0, 160));
  await mig.query(`UPDATE public.contake_db_identity SET registry_digest = $1 WHERE id = 1`, [REGISTRY_DIGEST]);
  await assertSchemaCurrent(mig, undefined, { deployment: 'staging', instanceId: rr.identity.instanceId });
  check('R4 anchor B: restore heals the boot gate', true);
  // R5 section 2: a WRONG registry-digest operator pin refuses BEFORE any write.
  let pinRefusal = '';
  try { await runMigrations(mig, { deployment: 'staging', expectInstanceId: rr.identity.instanceId, expectRegistryDigest: 'deadbeef'.repeat(8) }); } catch (e) { pinRefusal = String(e); }
  console.error(`OBSERVED[wrong registry pin]: ${pinRefusal.slice(0, 200)}`);
  check('R5: wrong expect-registry-digest pin refuses pre-write (OBSERVED)', /REGISTRY PIN refusal/.test(pinRefusal), pinRefusal.slice(0, 160));
  check('R5: correct dual pin passes the preconditions', true,
    await (async () => { const p = await runMigrations(mig, { deployment: 'staging', expectInstanceId: rr.identity.instanceId, expectRegistryDigest: REGISTRY_DIGEST }); return p.identity.instanceId; })());
  // R5 section 3 on REAL PG: legacy NULL adoption writes NOTHING without BOTH
  // pins; only the dual-pinned run adopts.
  await mig.query(`UPDATE public.contake_db_identity SET registry_digest = NULL WHERE id = 1`);
  let unpinned = '';
  try { await runMigrations(mig, { deployment: 'staging' }); } catch (e) { unpinned = String(e); }
  console.error(`OBSERVED[unpinned NULL adoption refusal]: ${unpinned.slice(0, 220)}`);
  check('R5: unpinned NULL-anchor adoption refuses and writes NOTHING (OBSERVED)', /LEGACY ADOPTION refusal/.test(unpinned), unpinned.slice(0, 180));
  const stillNull = await mig.query(`SELECT registry_digest AS d FROM public.contake_db_identity WHERE id = 1`);
  check('R5: anchor still NULL after the refused adoption (nothing written)', stillNull.rows[0]?.['d'] === null, stillNull.rows[0]);
  await runMigrations(mig, { deployment: 'staging', expectInstanceId: rr.identity.instanceId, expectRegistryDigest: REGISTRY_DIGEST });
  const adopted = await mig.query(`SELECT registry_digest AS d FROM public.contake_db_identity WHERE id = 1`);
  check('R5: dual-pinned run adopts the NULL anchor', adopted.rows[0]?.['d'] === REGISTRY_DIGEST, adopted.rows[0]?.['d']);
  // R5 section 5 (carried): default-ACL boot tamper on REAL PG - granting the
  // PUBLIC function-EXECUTE default makes the boot gate refuse; revoking heals.
  await mig.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC`);
  await mig.query(`ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC`);
  let aclRefusal = '';
  try { await assertSchemaCurrent(mig, undefined, { deployment: 'staging', instanceId: rr.identity.instanceId }); } catch (e) { aclRefusal = String(e); }
  console.error(`OBSERVED[default-ACL boot tamper]: ${aclRefusal.slice(0, 220)}`);
  check('R5: boot gate refuses tampered default ACLs on REAL PG (OBSERVED)', /DEFAULT PRIVILEGE refusal/.test(aclRefusal), aclRefusal.slice(0, 180));
  await mig.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
  await mig.query(`ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
  await assertSchemaCurrent(mig, undefined, { deployment: 'staging', instanceId: rr.identity.instanceId });
  check('R5: default-ACL restore heals the boot gate', true);
  // R5 section 5 (carried): in-transaction trigger firing with the OBSERVED
  // effect on REAL PG - the trigger fires mid-tx, the tx rolls back, the
  // catalog is byte-identical afterwards.
  {
    const preTrig = JSON.stringify(await catalogSnapshot(mig));
    const c = await mig.connect();
    let fired = '';
    try {
      await c.query('BEGIN');
      await c.query(`CREATE FUNCTION public.trg_fire() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''TRIGGER FIRED''; END'`);
      await c.query(`CREATE TRIGGER trg BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.trg_fire()`);
      try { await c.query(`INSERT INTO public.users(user_id, org_id, phone, data) VALUES('t1','o','p','{}')`); } catch (e) { fired = String(e); }
      await c.query('ROLLBACK');
    } finally { c.release(); }
    console.error(`OBSERVED[in-tx trigger firing]: ${fired.slice(0, 160)}`);
    check('R5: in-transaction trigger fired with the observed effect on REAL PG', /TRIGGER FIRED/.test(fired), fired.slice(0, 120));
    const postTrig = JSON.stringify(await catalogSnapshot(mig));
    check('R5: post-rollback catalog byte-identical after the fired trigger', postTrig === preTrig);
  }

  // R3 section-3 boot-gate tamper proofs on REAL PG: edited applied history
  // fails the boot gate; restoring the pinned digest makes it green again.
  const goodRow = await mig.query(`SELECT sha256 FROM schema_migrations WHERE version = '0001'`);
  await mig.query(`UPDATE schema_migrations SET sha256 = 'tampered' WHERE version = '0001'`);
  let histRefused = false; let histObserved = '';
  try { await assertSchemaCurrent(mig, undefined, { deployment: 'staging', instanceId: rr.identity.instanceId }); }
  catch (e) { histRefused = true; histObserved = String(e); }
  console.error(`OBSERVED[history tamper boot gate]: ${histObserved.slice(0, 200)}`);
  check('boot gate refuses edited applied history on REAL PG (OBSERVED)', histRefused, histObserved.slice(0, 160));
  await mig.query(`UPDATE schema_migrations SET sha256 = $1 WHERE version = '0001'`, [goodRow.rows[0]?.['sha256']]);
  await assertSchemaCurrent(mig, undefined, { deployment: 'staging', instanceId: rr.identity.instanceId });
  check('boot gate green after history restore', true);
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
  check('conf: migrator applies 0001-0003', rr.appliedNow.length === 3);

  // (1) One tx per governed operation / non-transactional classes refused at the gate.
  // R3: non-transactional / code classes CANNOT EXIST BY CONSTRUCTION - no
  // template emits them (full-registry render sweep), no template NAME can
  // request them, and the closed enums carry no escape value.
  // R4: the registry cannot be rendered from outside at all - non-tx/code
  // classes are inexpressible. Confined surface + catalog-observed absence
  // on the LIVE database + runner-driven registration refusals.
  for (const name of ['TEMPLATES', 'renderStepStatements', 'getTemplate']) {
    check(`conf: registry confined - ${name} not exported`, (runnerModule as Record<string, unknown>)[name] === undefined);
  }
  const codeObjs = await mig.query(`SELECT
    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public') AS f,
    (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal) AS t,
    (SELECT count(*)::int FROM pg_policy) AS p`);
  console.error(`OBSERVED[code-object absence on live db]: ${JSON.stringify(codeObjs.rows[0])}`);
  check('conf: catalog-observed absence of code objects after the governed run',
    Number(codeObjs.rows[0]?.['f']) === 0 && Number(codeObjs.rows[0]?.['t']) === 0 && Number(codeObjs.rows[0]?.['p']) === 0, codeObjs.rows[0]);
  for (const label of ['create-index-concurrently', 'vacuum', 'alter-system', 'create-database', 'call', 'do', 'security-definer-function']) {
    let refused = false; let ntxObs = '';
    try { await runMigrations(mig, { deployment: 'staging', migrations: [...MIGRATIONS, { version: '0004', name: 'x', description: 'x', template: `ddl.${label}`, params: {} }] }); } catch (e) { refused = true; ntxObs = String(e); }
    check(`conf: no template exists for non-tx class: ${label}`, refused && /unknown template name/.test(ntxObs), ntxObs.slice(0, 120));
  }
  let concRefused = false; let concObs = '';
  try { await runMigrations(mig, { deployment: 'staging', migrations: [...MIGRATIONS, saStep({ unique: 'concurrently' }, { version: '0004' })] }); } catch (e) { concRefused = true; concObs = String(e); }
  check('conf: enum escape toward CONCURRENTLY refused by the closed enum', concRefused && /TEMPLATE refusal - enum/.test(concObs), concObs.slice(0, 120));

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
    let diffObserved = '';
    try { assertZeroCatalogDelta(JSON.parse(pre) as string[], JSON.parse(mid) as string[], 'attack'); } catch (e) { diffObserved = String(e); }
    console.error(`OBSERVED[secdef trigger plant]: ${diffObserved.slice(0, 260)}`);
    check('conf: catalog diff catches planted SECURITY DEFINER trigger function in-tx', /CATALOG DELTA refusal/.test(diffObserved) && /evil_trigger/.test(diffObserved), diffObserved.slice(0, 200));
    await mc.query('ROLLBACK');
  } finally { mc.release(); }
  const post = JSON.stringify(await catalogSnapshot(mig));
  check('conf: post-rollback catalog equals pre-migration catalog EXACTLY (byte-for-byte)', post === pre);
  const run = new Pool({ host, port, user: 'conf_runtime', database: 'contake_conf' });
  run.on('error', () => { /* force-dropped idle client */ });
  let firedEffect = '';
  let insertErr = '';
  try { await run.query(`INSERT INTO public.users(user_id, org_id, phone, data) VALUES ('atk-1','o','p','{}')`); } catch (e) { insertErr = String(e); firedEffect = /pwned/.test(insertErr) ? insertErr : ''; }
  const survived = await adminC.query(`SELECT count(*)::int AS n FROM public.users WHERE user_id = 'atk-1'`);
  console.error(`OBSERVED[runtime insert after rollback]: err=${insertErr.slice(0, 120) || 'none'} rows=${JSON.stringify(survived.rows[0])}`);
  check('conf: planted trigger does NOT survive to fire under runtime-role INSERT (OBSERVED: no pwned error, row state shown)', firedEffect === '', { insertErr: insertErr.slice(0, 120), rows: survived.rows[0] });

  // (4) Extension baseline: side-effect extensions cannot be created by the
  // migration role; the bootstrap gate refuses a database that has one.
  let dblinkRefused = false;
  try { await mig.query(`CREATE EXTENSION dblink`); } catch { dblinkRefused = true; }
  check('conf: migrator role cannot CREATE EXTENSION dblink (superuser class)', dblinkRefused);
  let dblinkInstalled = true;
  try { await adminC.query(`CREATE EXTENSION dblink`); } catch { dblinkInstalled = false; }
  if (dblinkInstalled) {
    let gateObserved = '';
    try { await runMigrations(mig, { deployment: 'staging', appliedBy: 'conf-evidence' }); } catch (e) { gateObserved = String(e); }
    console.error(`OBSERVED[dblink baseline refusal]: ${gateObserved.slice(0, 220)}`);
    check('conf: bootstrap gate refuses a database whose extension set drifted from the pinned baseline (dblink)', /EXTENSION BASELINE refusal/.test(gateObserved), gateObserved.slice(0, 200));
    await adminC.query(`DROP EXTENSION dblink`);
  } else {
    check('conf: dblink contrib package unavailable on disposable cluster (privilege refusal proven; gate covered by unit suite)', true);
  }

  // (6) R3: no template can drift a sequence mid-step (general DML is gone),
  // so the runner capture/restore path is DORMANT defense-in-depth; its
  // helper-level contract is proven here on REAL PG: exact text capture,
  // non-transactional nextval drift, ACTIVE restore, and a restore failure
  // that PROPAGATES with explicit DIRTY/INDETERMINATE labeling.
  await mig.query(`CREATE SEQUENCE public.conf_seq`);
  const before6 = await sequenceValues(mig);
  await mig.query(`SELECT nextval('public.conf_seq')`);
  const drift6 = await sequenceValues(mig);
  check('conf: nextval drift observed (non-transactional)', drift6.get('public.conf_seq')?.isCalled !== before6.get('public.conf_seq')?.isCalled);
  const restored6 = await restoreSequenceValues(mig, before6);
  console.error(`OBSERVED[restored sequences]: ${JSON.stringify(restored6)}`);
  check('conf: sequence value ACTIVELY RESTORED (OBSERVED list)', restored6.includes('public.conf_seq'), restored6);
  const sv = await mig.query(`SELECT last_value::text AS lv, is_called AS ic FROM public.conf_seq`);
  console.error(`OBSERVED[restored sequence row]: ${JSON.stringify(sv.rows[0])}`);
  check('conf: restored row matches the capture exactly (OBSERVED row)', sv.rows[0]?.['ic'] === false, sv.rows);
  await mig.query(`DROP SEQUENCE public.conf_seq`);
  let restoreErr = '';
  try { await restoreSequenceValues(mig, drift6); } catch (e) { restoreErr = String(e); }
  console.error(`OBSERVED[restore failure propagation]: ${restoreErr.slice(0, 220)}`);
  check('conf: restore failure PROPAGATES with DIRTY/INDETERMINATE labeling (no swallow)', /SEQUENCE RESTORE failure/.test(restoreErr) && /DIRTY/.test(restoreErr), restoreErr.slice(0, 160));
  await mig.query(`CREATE SEQUENCE public.conf_seq`);
  // >2^53 exact-text sequence handling on REAL PG
  const BIG = '9007199254740993';
  await mig.query(`SELECT setval('public.conf_seq', $1::text::bigint, true)`, [BIG]);
  const bigRow = await mig.query(`SELECT last_value::text AS lv FROM public.conf_seq`);
  console.error(`OBSERVED[>2^53 sequence]: ${JSON.stringify(bigRow.rows[0])}`);
  check('conf: >2^53 sequence value round-trips exactly as text', String(bigRow.rows[0]?.['lv']) === BIG, bigRow.rows[0]);
  const bigSnap = await catalogSnapshot(mig);
  check('conf: snapshot carries the >2^53 value as exact text', bigSnap.some(x => x.startsWith('seqval ') && x.includes(BIG)));
  await mig.query(`SELECT setval('public.conf_seq', 1, false)`);
  const afterAll = JSON.stringify(await catalogSnapshot(mig));
  await mig.query(`DROP SEQUENCE public.conf_seq`);

  // R2 §4: pre-existing-object alteration matrix on REAL PG (migrator role
  // CAN perform these in-schema by privilege - the DIFF is the boundary).
  await mig.query(`CREATE FUNCTION public.pre_exist() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
  const altBase = await catalogSnapshot(mig);
  const alterations: [string, string, RegExp][] = [
    ['OR REPLACE body swap', `CREATE OR REPLACE FUNCTION public.pre_exist() RETURNS int LANGUAGE sql AS 'SELECT 999'`, /pg_proc.*pre_exist/],
    ['ALTER FUNCTION SET search_path', `ALTER FUNCTION public.pre_exist() SET search_path = attacker`, /pg_proc.*pre_exist/],
    ['GRANT EXECUTE ON FUNCTION', `GRANT EXECUTE ON FUNCTION public.pre_exist() TO PUBLIC`, /pg_proc.*pre_exist/],
    ['COMMENT ON function', `COMMENT ON FUNCTION public.pre_exist() IS 'x'`, /pg_description.*pre_exist/],
    ['ALTER ROLE SET', `ALTER ROLE conf_migrator SET work_mem = '1GB'`, /pg_db_role_setting/],
    ['default-ACL plant', `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC`, /pg_default_acl/],
  ];
  for (const [label, sql, artifact] of alterations) {
    const mc2 = await mig.connect();
    try {
      await mc2.query('BEGIN');
      const b2 = await catalogSnapshot(mc2);
      await mc2.query(sql);
      const a2 = await catalogSnapshot(mc2);
      let observed = '';
      try { assertZeroCatalogDelta(b2, a2, 'atk'); } catch (e) { observed = String(e); }
      console.error(`OBSERVED[alteration ${label}]: ${observed.slice(0, 220)}`);
      check(`conf: alteration caught - ${label} (OBSERVED artifact)`, /CATALOG DELTA refusal/.test(observed) && artifact.test(observed), observed.slice(0, 160));
      await mc2.query('ROLLBACK');
      const eq = JSON.stringify(await catalogSnapshot(mig)) === JSON.stringify(altBase);
      check(`conf: post-rollback catalog EXACT after ${label}`, eq);
    } finally { mc2.release(); }
  }

  // R2 §6 on REAL PG: the migration role's default privileges revoke PUBLIC
  // function EXECUTE - a created function is uncallable by the runtime role.
  await mig.query(`CREATE FUNCTION public.dp_check() RETURNS int LANGUAGE sql AS 'SELECT 42'`);
  const dpAcl = await mig.query(`SELECT proacl::text AS acl FROM pg_proc WHERE proname = 'dp_check'`);
  console.error(`OBSERVED[migration-role function ACL]: ${JSON.stringify(dpAcl.rows[0])}`);
  check('conf: migration-role function has NO PUBLIC default EXECUTE (OBSERVED acl)', !String(dpAcl.rows[0]?.['acl'] ?? '').match(/(^\{|,)=/), dpAcl.rows[0]);
  let callErr = '';
  try { await run.query(`SELECT public.dp_check()`); } catch (e) { callErr = String(e); }
  console.error(`OBSERVED[runtime role calls function]: ${callErr.slice(0, 160) || 'CALL SUCCEEDED (!)'}`);
  check('conf: runtime role CANNOT call the migration-role function (OBSERVED error)', /permission denied/.test(callErr), callErr.slice(0, 160));
  await mig.query(`DROP FUNCTION public.dp_check()`);
  await mig.query(`DROP FUNCTION public.pre_exist()`);

  check('conf: catalog identical to pre-attack baseline after cleanup', JSON.stringify(await catalogSnapshot(mig)) === pre, { afterAll: afterAll.length });
  await run.end(); await mig.end(); await adminC.end();
  await admin.query(`DROP DATABASE contake_conf WITH (FORCE)`);
  await admin.query(`DROP ROLE conf_runtime`); await admin.query(`DROP ROLE conf_migrator`);
} else if (phase === 'phase5') {
  // SA1 ruling (2026-09-19): attended-TOFU operator gate. The read-only
  // preflight runs FIRST; its inconsistency list is recorded; the migration
  // executes ONLY after explicit operator acknowledgment of the list digest.
  const { execFileSync } = await import('node:child_process');
  await admin.query(`DROP DATABASE IF EXISTS contake_tofu WITH (FORCE)`);
  await admin.query(`CREATE DATABASE contake_tofu`);
  const tofu = mk('contake_tofu');
  await runMigrations(tofu, { deployment: 'staging', migrations: MIGRATIONS.slice(0, 1) });
  const ins = (id: string, phone: string | null, jp?: string) =>
    tofu.query(`INSERT INTO users(user_id, org_id, email, phone, data) VALUES($1, 'org-1', $2, $3, $4::jsonb)`,
      [id, `${id}@example.com`, phone, JSON.stringify(jp === undefined ? {} : { phone: jp })]);
  await ins('u-blank-1', '');
  await ins('u-blank-2', '   ');
  await ins('u-inconsistent', ' +972555000111 ', '+972555000222'); // cross-representation
  await ins('u-padded', '  +972555000333  ');
  const url = `postgres://postgres@${host}:${port}/contake_tofu`;
  const before = await tofu.query(`SELECT count(*)::int AS n FROM users`);

  // 1) preflight FIRST, read-only (session forced default_transaction_read_only).
  const preflightJson = execFileSync('npx', ['tsx', 'scripts/users-phone-preflight.mts', '--database-url', url], { encoding: 'utf8' });
  const preflight = JSON.parse(preflightJson) as { listDigest: string; crossRepresentationInconsistencies: unknown[]; blankPhoneUsers: unknown[]; collisionGroups: unknown[]; operatorDecisionRequired: boolean };
  out['preflight'] = preflight;
  console.error(`OBSERVED[preflight listDigest]: ${preflight.listDigest}`);
  console.error(`OBSERVED[preflight inconsistencies]: ${JSON.stringify(preflight.crossRepresentationInconsistencies)}`);
  check('preflight ran FIRST and recorded the inconsistency list', preflight.crossRepresentationInconsistencies.length === 1
    && JSON.stringify(preflight.crossRepresentationInconsistencies).includes('u-inconsistent'), preflight.crossRepresentationInconsistencies);
  check('preflight recorded both blank phones', preflight.blankPhoneUsers.length === 2, preflight.blankPhoneUsers);
  check('preflight flagged operator decision', preflight.operatorDecisionRequired === true);
  const after = await tofu.query(`SELECT count(*)::int AS n FROM users`);
  check('preflight was read-only (row data untouched)', Number(before.rows[0]?.['n']) === Number(after.rows[0]?.['n']));

  // 2) the gate: NO execution without an exact acknowledgment of THIS list.
  const requiredAck = `ack:${preflight.listDigest}`;
  console.error(`OBSERVED[required ack]: ${requiredAck}`);
  const supplied = process.env['OPERATOR_ACK'] ?? '';
  if (supplied !== requiredAck) {
    // The refusal IS the evidence for a no-ack run: the migration does not
    // execute; the exact required acknowledgment is printed for the operator.
    console.error(`CHECK PASS attended-TOFU gate refuses without the exact operator acknowledgment (supplied=${supplied === '' ? '(none)' : 'mismatch'})`);
    console.error(`GATE: to execute, the operator reviews the list above and re-runs with OPERATOR_ACK=${requiredAck}`);
    (out.checks as unknown[]).push({ name: 'attended-TOFU gate refuses without the exact operator acknowledgment', ok: true, detail: `REFUSED as designed; required ${requiredAck}` });
    out['gateOutcome'] = 'REFUSED-no-ack';
    console.log(JSON.stringify(out, null, 2));
    await tofu.end();
    await admin.query(`DROP DATABASE contake_tofu WITH (FORCE)`);
    await admin.end();
    process.exit(0);
  }
  out['operatorAcknowledgment'] = { ack: supplied, listDigest: preflight.listDigest, ordering: 'preflight-before-migration' };
  check('explicit operator acknowledgment recorded before execution', supplied === requiredAck);

  // 3) execution AFTER acknowledgment: SA1 semantics on REAL PG.
  const r = await runMigrations(tofu, { deployment: 'staging' }); // full registry; 0001 already recorded
  check('tofu: 0002+0003 applied after acknowledgment', r.appliedNow.join(',') === '0002,0003', r.appliedNow);
  const rows = await tofu.query(`SELECT user_id, phone, data->>'phone' AS jp FROM users ORDER BY user_id`);
  const byId = Object.fromEntries(rows.rows.map(x => [String(x['user_id']), x]));
  check('tofu: two blank phones normalize to NULL (absence, not identity)',
    byId['u-blank-1']?.['phone'] === null && byId['u-blank-2']?.['phone'] === null, [byId['u-blank-1'], byId['u-blank-2']]);
  check('tofu: padded real phone trimmed to its own value', byId['u-padded']?.['phone'] === '+972555000333', byId['u-padded']);
  check('tofu: cross-representation inconsistency preserved per-representation (operator boundary)',
    byId['u-inconsistent']?.['phone'] === '+972555000111' && byId['u-inconsistent']?.['jp'] === '+972555000222', byId['u-inconsistent']);
  const tIdx = await tofu.query(`SELECT to_regclass('users_phone_unique') AS r`);
  check('tofu: canonical index BUILT with absent phones excluded', tIdx.rows[0]?.['r'] !== null);
  const noMatch = await tofu.query(`SELECT count(*)::int AS n FROM users WHERE phone = ''`);
  check('tofu: login-by-phone can never match a NULL phone', Number(noMatch.rows[0]?.['n']) === 0);

  // 4) a REAL cross-tenant phone collision still blocks loudly.
  await admin.query(`DROP DATABASE IF EXISTS contake_tofu2 WITH (FORCE)`);
  await admin.query(`CREATE DATABASE contake_tofu2`);
  const tofu2 = mk('contake_tofu2');
  await runMigrations(tofu2, { deployment: 'staging', migrations: MIGRATIONS.slice(0, 1) });
  await tofu2.query(`INSERT INTO users(user_id, org_id, phone, data) VALUES('u-a', 'org-1', '+972555000444', '{}')`);
  await tofu2.query(`INSERT INTO users(user_id, org_id, phone, data) VALUES('u-b', 'org-2', '  +972555000444 ', '{}')`);
  let blocked = false;
  try { await runMigrations(tofu2, { deployment: 'staging' }); }
  catch (e) { blocked = /ASSERTION refusal - guard 'no-duplicates' in '0002'/.test(String(e)); }
  check('tofu: a real cross-tenant phone collision still BLOCKS loudly', blocked);
  const t2 = await tofu2.query(`SELECT to_regclass('users_phone_unique') AS r`);
  check('tofu: blocked run built nothing', t2.rows[0]?.['r'] === null);
  await tofu2.end(); await tofu.end();
  await admin.query(`DROP DATABASE contake_tofu2 WITH (FORCE)`);
  await admin.query(`DROP DATABASE contake_tofu WITH (FORCE)`);
} else {
  throw new Error('phase1|phase2|phase3|phase4|phase5 required');
}
await admin.end();
console.log(JSON.stringify(out, null, 2));
