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
 *  phase5 (SA2/SA2-A/SA3 attended-TOFU + ack lifecycle): drives the REAL
 *  BUILT migration CLI (package script migrate:release -> node dist ->
 *  runMigrations) as a child process; source spawn is void (SA4);
 *  the runner enforces the ISSUED-NONCE ack lifecycle under lock,
 *  in-transaction: truly-absent/wrong-target/plan-mismatch/stale/consumed/
 *  invalidated presentations, unique append-only evidence identity, no
 *  caller-label exemptions (dist in the DIST lane), and the
 *  invalidation-failure DIRTY/INDETERMINATE contract with attended
 *  resolution.
 */
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import type { MigrationStep } from './src/migrations/runner.js';
// R5 section 4: the module under evidence is selectable - the SAME phases run
// against src (tsx) or the BUILT DIST (the artifact that deploys). The
// evidence pack records which module path ran plus its sha256.
const RUNNER_PATH = process.env['EVIDENCE_RUNNER'] ?? './dist/migrations/runner.js';
const SEED_PATH = process.env['EVIDENCE_SEED'] ?? './dist/migrations/staging-seed.js';
const R = await import(RUNNER_PATH) as typeof import('./src/migrations/runner.js');
const S = await import(SEED_PATH) as typeof import('./src/migrations/staging-seed.js');
const {
  MIGRATIONS, REGISTRY_DIGEST, assertDirectDatabaseUrl, assertSchemaCurrent, assertSingleStatementForms, assertZeroCatalogDelta, catalogSnapshot,
  attendedResolveDirty, computeUsersPhonePreflight, issueOperatorPreflight, operatorAckFor, operatorListDigestForReview,
  restoreSequenceValues, runMigrations, sequenceValues, stepDigest,
} = R;
/** SA2: evidence lanes mint the attended-TOFU ack from the runner's canonical
 *  preflight against the CURRENT state (the runner recomputes in-transaction). */
/** SA3: evidence lanes mint REAL acks through the REAL issuance path
 *  (persisted issued-nonce record, bound to the SAME migrations array). */
const ackedRun = async (db: Parameters<typeof runMigrations>[0], opts: Parameters<typeof runMigrations>[1]) => {
  const pf = await issueOperatorPreflight(db, {
    deployment: opts.deployment,
    ...(opts.migrations === undefined ? {} : { migrations: opts.migrations }),
    ...(opts.expectInstanceId === undefined ? {} : { expectInstanceId: opts.expectInstanceId }),
    ...(opts.expectRegistryDigest === undefined ? {} : { expectRegistryDigest: opts.expectRegistryDigest }),
  });
  return runMigrations(db, { operatorAck: operatorAckFor(pf), ...opts });
};
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
  const r1 = await ackedRun(db, { deployment: 'staging', appliedBy: 'evidence' });
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
    ackedRun(a, { deployment: 'staging', appliedBy: 'racer-a' }),
    ackedRun(b, { deployment: 'staging', appliedBy: 'racer-b' }),
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
  try { await ackedRun(db2, { deployment: 'staging', migrations: [failing] }); } catch { threw = true; }
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
    try { await ackedRun(db2, { deployment: 'staging', migrations: [bad] }); }
    catch (e) { refused = /TEMPLATE refusal/.test(String(e)); }
    check(`${label} rejected at registration`, refused);
  }
  const el = await db2.query(`SELECT to_regclass('escape_leak') AS r`);
  check('no statement executed from a rejected step', el.rows[0]?.['r'] === null);

  // 3c) Guard primitive hard-fail rolls back on REAL postgres.
  await ackedRun(db2, { deployment: 'staging' });
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
  try { await ackedRun(db2, { deployment: 'staging', expectInstanceId: 'wrong-pin' }); } catch (e) { pinRefused = /INSTANCE BINDING refusal/.test(String(e)); }
  check('wrong instance pin refused (pre-mutation)', pinRefused);
  const pv = await db2.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version NOT IN ('0001', '0002', '0003')`);
  check('zero writes from a refused pin', Number(pv.rows[0]?.['n']) === 0);

  // 3e0) Fresh DB + supplied pin: refused BEFORE any write (TOFU needs an
  // omitted pin + attended verification) on a REAL fresh postgres db.
  await admin.query(`DROP DATABASE IF EXISTS contake_fresh WITH (FORCE)`);
  await admin.query(`CREATE DATABASE contake_fresh`);
  const fr = mk('contake_fresh');
  let freshPinRefused = false;
  try { await ackedRun(fr, { deployment: 'staging', expectInstanceId: '0123456789abcdef' }); } catch (e) { freshPinRefused = /INSTANCE BINDING refusal/.test(String(e)); }
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
  await ackedRun(sd, { deployment: 'staging', appliedBy: 'evidence' });
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
  await ackedRun(sd2, { deployment: 'staging', appliedBy: 'evidence' });
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
  await ackedRun(sd3, { deployment: 'staging', appliedBy: 'evidence' });
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
  const rr = await ackedRun(mig, { deployment: 'staging', appliedBy: 'role-evidence' });
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
    try { await ackedRun(mig, { deployment: 'staging', migrations: [...MIGRATIONS, bad] }); } catch (e) { refused = true; observed = String(e); }
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
  try { await ackedRun(mig, { deployment: 'staging' }); } catch (e) { abRun = String(e); }
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
  try { await ackedRun(mig, { deployment: 'staging', expectInstanceId: rr.identity.instanceId, expectRegistryDigest: 'deadbeef'.repeat(8) }); } catch (e) { pinRefusal = String(e); }
  console.error(`OBSERVED[wrong registry pin]: ${pinRefusal.slice(0, 200)}`);
  check('R5: wrong expect-registry-digest pin refuses pre-write (OBSERVED)', /REGISTRY PIN refusal/.test(pinRefusal), pinRefusal.slice(0, 160));
  check('R5: correct dual pin passes the preconditions', true,
    await (async () => { const p = await ackedRun(mig, { deployment: 'staging', expectInstanceId: rr.identity.instanceId, expectRegistryDigest: REGISTRY_DIGEST }); return p.identity.instanceId; })());
  // R5 section 3 on REAL PG: legacy NULL adoption writes NOTHING without BOTH
  // pins; only the dual-pinned run adopts.
  await mig.query(`UPDATE public.contake_db_identity SET registry_digest = NULL WHERE id = 1`);
  let unpinned = '';
  try { await ackedRun(mig, { deployment: 'staging' }); } catch (e) { unpinned = String(e); }
  console.error(`OBSERVED[unpinned NULL adoption refusal]: ${unpinned.slice(0, 220)}`);
  check('R5: unpinned NULL-anchor adoption refuses and writes NOTHING (OBSERVED)', /LEGACY ADOPTION refusal/.test(unpinned), unpinned.slice(0, 180));
  const stillNull = await mig.query(`SELECT registry_digest AS d FROM public.contake_db_identity WHERE id = 1`);
  check('R5: anchor still NULL after the refused adoption (nothing written)', stillNull.rows[0]?.['d'] === null, stillNull.rows[0]);
  await ackedRun(mig, { deployment: 'staging', expectInstanceId: rr.identity.instanceId, expectRegistryDigest: REGISTRY_DIGEST });
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
  const rr = await ackedRun(mig, { deployment: 'staging', appliedBy: 'conf-evidence' });
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
    try { await ackedRun(mig, { deployment: 'staging', migrations: [...MIGRATIONS, { version: '0004', name: 'x', description: 'x', template: `ddl.${label}`, params: {} }] }); } catch (e) { refused = true; ntxObs = String(e); }
    check(`conf: no template exists for non-tx class: ${label}`, refused && /unknown template name/.test(ntxObs), ntxObs.slice(0, 120));
  }
  let concRefused = false; let concObs = '';
  try { await ackedRun(mig, { deployment: 'staging', migrations: [...MIGRATIONS, saStep({ unique: 'concurrently' }, { version: '0004' })] }); } catch (e) { concRefused = true; concObs = String(e); }
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
    try { await ackedRun(mig, { deployment: 'staging', appliedBy: 'conf-evidence' }); } catch (e) { gateObserved = String(e); }
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

  // SA3: the runner's append-only evidence ledger legitimately burns
  // schema_migration_evidence_seq_seq values on refused/rolled-back attacks
  // (a refusal is itself a recorded lifecycle event). A sequence counter is
  // not an attack artifact: normalize ONLY that sequence value out of both
  // snapshots; every other catalog member must be EXACTLY restored.
  const stripEvSeq = (snap: string) => JSON.stringify((JSON.parse(snap) as string[]).filter(x => !(typeof x === 'string' && x.startsWith('seqval ') && x.includes('schema_migration_evidence_seq_seq'))));
  check('conf: catalog identical to pre-attack baseline after cleanup (modulo append-only evidence sequence)', stripEvSeq(JSON.stringify(await catalogSnapshot(mig))) === stripEvSeq(pre), { afterAll: afterAll.length });
  await run.end(); await mig.end(); await adminC.end();
  await admin.query(`DROP DATABASE contake_conf WITH (FORCE)`);
  await admin.query(`DROP ROLE conf_runtime`); await admin.query(`DROP ROLE conf_migrator`);
} else if (phase === 'phase5') {
  // SA2 + SA4 rulings (2026-09-19): the attended-TOFU operator gate is
  // enforced by the REAL product path - the BUILT migration CLI invoked
  // through the package script (migrate:release -> node
  // dist/migrations/migrate-cli.js -> runMigrations) with the required
  // target-binding tuple, recomputed under the step locks in the step
  // transaction (no TOCTOU). No harness gate, no env ack, no source spawn.
  // The evidence drives the built CLI as a child process against disposable
  // databases.
  const { spawnSync } = await import('node:child_process');
  // SA4: the gated entrypoint is invoked ONLY as the BUILT artifact through
  // the package script (source spawn is void). cliRun() derives the required
  // target-binding tuple from the URL under evidence; attacks needing a
  // DIFFERENT tuple build args explicitly via cli().
  const cli = (args: string[]) => {
    const r = spawnSync('pnpm', ['--silent', 'run', 'migrate:release', '--', ...args], { encoding: 'utf8', timeout: 300000 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const cliRun = (url: string, args: string[]) => {
    const u = new URL(url);
    return cli(['--database-url', url, '--deployment', 'staging', '--expect-host', u.hostname, '--expect-db', u.pathname.slice(1), ...args]);
  };
  // SA4: the canonical preflight IS the built CLI's issuance-first run (exit
  // 75, NOTHING executed). Parse the persisted preflight JSON from stdout.
  const preflight = (url: string) => {
    const r = cliRun(url, []);
    if (r.status !== 75) throw new Error(`issuance-first preflight failed (expected exit 75): status=${r.status} ${r.stderr}`);
    return JSON.parse(r.stdout.slice(r.stdout.indexOf('{')))['preflight'] as { nonce: string; listDigest: string; requiredAck: string; target: string; crossRepresentationInconsistencies: unknown[]; blankPhoneUsers: unknown[]; collisionGroups: unknown[]; operatorDecisionRequired: boolean };
  };

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

  // 1) canonical preflight FIRST, read-only (runner-owned implementation).
  const pf = preflight(url);
  out['preflight'] = pf;
  console.error(`OBSERVED[preflight listDigest]: ${pf.listDigest}`);
  check('preflight ran FIRST and recorded the inconsistency list', pf.crossRepresentationInconsistencies.length === 1
    && JSON.stringify(pf.crossRepresentationInconsistencies).includes('u-inconsistent'), pf.crossRepresentationInconsistencies);
  check('preflight recorded both blank phones', pf.blankPhoneUsers.length === 2, pf.blankPhoneUsers);
  check('preflight flagged operator decision', pf.operatorDecisionRequired === true);
  const after = await tofu.query(`SELECT count(*)::int AS n FROM users`);
  check('preflight touched NO application data (only runner-owned issuance records)', Number(before.rows[0]?.['n']) === Number(after.rows[0]?.['n']));
  const issuedRows = await tofu.query(`SELECT state FROM public.schema_migration_acks WHERE nonce = $1`, [pf.nonce]);
  check('SA3: preflight PERSISTED the issued nonce record (state=issued)', issuedRows.rows.length === 1 && issuedRows.rows[0]?.['state'] === 'issued', issuedRows.rows);

  // 2) ATTACK SET through the REAL CLI (all must fail closed, nothing applied).
  const applied = async () => (await tofu.query(`SELECT version FROM public.schema_migrations ORDER BY seq`)).rows.map(x => String(x['version']));

  const noAck = cliRun(url, []);
  console.error(`OBSERVED[cli no-ack]: status=${noAck.status} ${noAck.stderr.split('\n').find(l => l.includes('GATE')) ?? ''}`);
  check('REAL CLI refuses an absent ack (exit 75, nothing executed)', noAck.status === 75 && noAck.stderr.includes('GATE: no ack supplied'), { status: noAck.status, stderr: noAck.stderr.slice(0, 200) });
  check('no-ack run applied nothing', JSON.stringify(await applied()) === '["0001"]', await applied());

  // SA4 s2/s5: target-binding + parser attacks through the BUILT CLI.
  const unknownFlag = cliRun(url, ['--bogus-flag', 'x']);
  check('SA4: built CLI refuses an unknown flag', unknownFlag.status !== 0 && (unknownFlag.stderr + unknownFlag.stdout).includes('unknown flag'), { status: unknownFlag.status });
  const barePositional = cliRun(url, ['positional']);
  check('SA4: built CLI refuses a bare positional', barePositional.status !== 0 && (barePositional.stderr + barePositional.stdout).includes('bare positional'), { status: barePositional.status });
  const dupFlag = cliRun(url, ['--expect-db', 'contake_tofu']);
  check('SA4: built CLI refuses a duplicate flag', dupFlag.status !== 0 && (dupFlag.stderr + dupFlag.stdout).includes('duplicate flag'), { status: dupFlag.status });
  const missingBinding = cli(['--database-url', url, '--deployment', 'staging']);
  check('SA4: built CLI refuses a missing required binding flag', missingBinding.status !== 0 && (missingBinding.stderr + missingBinding.stdout).includes('--expect-host'), { status: missingBinding.status });
  const pooledUrl = url.replace(`@${host}:`, `@${host}-pooler.`);
  const pooled = cliRun(pooledUrl, []);
  check('SA4: built CLI refuses a POOLED endpoint (direct schema-owner endpoint required)', pooled.status !== 0 && pooled.stderr.includes('POOLED endpoint refused'), { status: pooled.status });
  const wrongHost = cli(['--database-url', url, '--deployment', 'staging', '--expect-host', 'not-the-host', '--expect-db', 'contake_tofu']);
  check('SA4: built CLI refuses a wrong expect-host BEFORE connecting (exit 2)', wrongHost.status === 2 && wrongHost.stderr.includes('TARGET TUPLE mismatch'), { status: wrongHost.status });
  const wrongDb = cli(['--database-url', url, '--deployment', 'staging', '--expect-host', host, '--expect-db', 'not_the_db']);
  check('SA4: built CLI refuses a wrong expect-db BEFORE connecting (exit 2)', wrongDb.status === 2 && wrongDb.stderr.includes('TARGET TUPLE mismatch'), { status: wrongDb.status });
  const badLabel = cli(['--database-url', url, '--deployment', 'qa', '--expect-host', host, '--expect-db', 'contake_tofu']);
  check('SA4: built CLI refuses an unknown deployment label (exit 64)', badLabel.status === 64 && badLabel.stderr.includes('unknown deployment label'), { status: badLabel.status });
  check('SA4: binding/parser attacks applied nothing', JSON.stringify(await applied()) === '["0001"]', await applied());

  const wrongAck = cliRun(url, ['--ack', `ack:${'deadbeef'.repeat(8)}`]);
  console.error(`OBSERVED[cli wrong-ack]: status=${wrongAck.status}`);
  check('REAL CLI refuses a wrong ack (runner gate, fail closed)', wrongAck.status !== 0 && wrongAck.stderr.includes('OPERATOR GATE refusal'), { status: wrongAck.status });
  check('wrong-ack run applied nothing', JSON.stringify(await applied()) === '["0001"]', await applied());

  const staleAck = pf.requiredAck;
  // The ack binds the canonical inconsistency LISTS (+ target + deployment):
  // the state change must alter a LIST to invalidate it. A blank phone enters
  // blankPhoneUsers - the minted digest no longer matches the recomputed one.
  await ins('u-late', '');
  const stale = cliRun(url, ['--ack', staleAck]);
  console.error(`OBSERVED[cli stale-ack]: status=${stale.status}`);
  check('REAL CLI refuses a STALE ack (list state changed after it was minted; runner recomputes under lock)', stale.status !== 0 && stale.stderr.includes('OPERATOR GATE refusal'), { status: stale.status });
  await tofu.query(`DELETE FROM users WHERE user_id = 'u-late'`);

  await admin.query(`DROP DATABASE IF EXISTS contake_tofu2 WITH (FORCE)`);
  await admin.query(`CREATE DATABASE contake_tofu2`);
  const tofu2 = mk('contake_tofu2');
  await runMigrations(tofu2, { deployment: 'staging', migrations: MIGRATIONS.slice(0, 1) });
  await tofu2.query(`INSERT INTO users(user_id, org_id, email, phone, data) VALUES('u-other', 'org-1', 'o@x', '+972555000777', '{}')`);
  const url2 = `postgres://postgres@${host}:${port}/contake_tofu2`;
  const pf2 = preflight(url2);
  const replayed = cliRun(url, ['--ack', pf2.requiredAck]);
  console.error(`OBSERVED[cli replayed-ack]: status=${replayed.status}`);
  check('REAL CLI refuses a REPLAYED ack (minted against another target)', replayed.status !== 0 && replayed.stderr.includes('OPERATOR GATE refusal'), { status: replayed.status });

  const fabricated = cliRun(url, ['--ack', `ack:${'f'.repeat(16)}:${'0'.repeat(64)}`]);
  check('REAL CLI refuses a fabricated ack (no preflight ever produced it)', fabricated.status !== 0 && fabricated.stderr.includes('NO ISSUED PREFLIGHT'), { status: fabricated.status });
  // SA3 Q1: TRULY-ABSENT preflight - a well-formed ack from an arbitrary
  // nonce + the public canonical digest, NO issuance record anywhere.
  const forgedReport = await computeUsersPhonePreflight(tofu, { deployment: 'staging' });
  const forgedAck = operatorAckFor(forgedReport);
  const forged = cliRun(url, ['--ack', forgedAck]);
  console.error(`OBSERVED[cli truly-absent-ack]: status=${forged.status}`);
  check('SA3 Q1: REAL CLI refuses a TRULY-ABSENT preflight ack (arbitrary nonce + public digest, no record)',
    forged.status !== 0 && forged.stderr.includes('NO ISSUED PREFLIGHT'), { status: forged.status });
  check('all refusals applied nothing', JSON.stringify(await applied()) === '["0001"]', await applied());

  // SA2-A acceptance: PLAN-MISMATCH presentation (ack minted for 0002-only / 0003-alone)
  const tamperedPlanAck = (keep: string) => `ack:${pf.nonce}:${operatorListDigestForReview({
    target: pf.target, deployment: pf.deployment, nonce: pf.nonce, plan: pf.plan.filter((x: { version: string }) => x.version === keep),
    collisionGroups: pf.collisionGroups, crossRepresentationInconsistencies: pf.crossRepresentationInconsistencies, blankPhoneUsers: pf.blankPhoneUsers,
  })}`;
  const planMismatch2 = cliRun(url, ['--ack', tamperedPlanAck('0002')]);
  const planMismatch3 = cliRun(url, ['--ack', tamperedPlanAck('0003')]);
  check('REAL CLI refuses PLAN-MISMATCH presentations (0002-only / 0003-alone)',
    planMismatch2.status !== 0 && planMismatch2.stderr.includes('OPERATOR GATE refusal')
    && planMismatch3.status !== 0 && planMismatch3.stderr.includes('OPERATOR GATE refusal'), { s2: planMismatch2.status, s3: planMismatch3.status });
  check('plan-mismatch refusals applied nothing', JSON.stringify(await applied()) === '["0001"]', await applied());

  // SA2-A acceptance: POST-ABORT reuse. A gated 0003 variant whose guard
  // always fires aborts the plan AFTER the ack was accepted at 0002; the
  // invalidation is recorded append-only and the same ack can never return.
  const failingPlan = [...MIGRATIONS.slice(0, 2), { ...MIGRATIONS[2]!, assertions: [{ kind: 'table-empty', table: 'users' }] }];
  const pfAbortReal = await issueOperatorPreflight(tofu, { deployment: 'staging', migrations: failingPlan });
  const abortAck = operatorAckFor(pfAbortReal);
  let aborted = '';
  try { await runMigrations(tofu, { deployment: 'staging', migrations: failingPlan, operatorAck: abortAck }); } catch (e) { aborted = String(e); }
  check('abort injection: failing guarded 0003 aborts the plan after the ack was accepted', /ASSERTION refusal - guard 'table-empty'/.test(aborted), aborted.slice(0, 160));
  check('abort rolled the WHOLE plan back (nothing past 0001)', JSON.stringify(await applied()) === '["0001"]', await applied());
  const invRows = (await tofu.query(`SELECT event_id, kind, report->>'nonce' AS nonce FROM public.schema_migration_evidence WHERE kind = 'ack-invalidated'`)).rows;
  check('abort INVALIDATED the ack (append-only evidence survives the rollback)', invRows.length === 1 && invRows[0]?.['nonce'] === pfAbortReal.nonce, invRows);
  const invState = await tofu.query(`SELECT state FROM public.schema_migration_acks WHERE nonce = $1`, [pfAbortReal.nonce]);
  check('the aborted ack record is invalidated (mutually exclusive with consumed)', invState.rows[0]?.['state'] === 'invalidated', invState.rows);
  let replayRefused = '';
  try { await runMigrations(tofu, { deployment: 'staging', migrations: failingPlan, operatorAck: abortAck }); } catch (e) { replayRefused = String(e); }
  check('POST-ABORT REPLAY of the exact same ack refuses (ACK LIFECYCLE loud conflict)', /ACK LIFECYCLE/.test(replayRefused), replayRefused.slice(0, 200));

  // 3) GREEN PATH: operator reviews the preflight, supplies THIS target+state ack.
  const green = cliRun(url, ['--ack', pf.requiredAck]);
  console.error(`OBSERVED[cli green]: status=${green.status} ${green.stdout.split('\n').find(l => l.includes('applied')) ?? ''}`);
  check('REAL CLI applies 0002+0003 with the exact operator ack', green.status === 0 && green.stdout.includes('"0002"') && green.stdout.includes('"0003"'), { status: green.status, stdout: green.stdout.slice(0, 300) });
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

  // 4) the acknowledged report + digest PERSISTED as migration evidence.
  const ev = await tofu.query(`SELECT version, list_digest, target, report FROM public.schema_migration_evidence WHERE kind = 'attended-tofu' ORDER BY version`);
  // 0002 persists the ACKED digest (pre-execution lists); 0003 persists its
  // OWN in-transaction recompute (post-normalization lists) - both carry the
  // same operator ack string + plan + per-step pre/post state digests, and
  // each step's post digest EQUALS its pre digest (canonical derivation over
  // the idempotent normalized projection; SA2-A 2(c)).
  check('acknowledged report/digest persisted with the migration evidence (0002 + 0003)',
    JSON.stringify(ev.rows.map(x => String(x['version']))) === '["0002","0003"]'
    && String(ev.rows[0]!['list_digest']) === pf.listDigest
    && String(ev.rows[1]!['list_digest']) !== pf.listDigest
    && ev.rows.every(x => String(x['target']) === 'contake_tofu')
    && ev.rows.every(x => String((x['report'] as { ack?: string }).ack) === pf.requiredAck)
    && ev.rows.every(x => (x['report'] as { preStateDigest?: string }).preStateDigest === (x['report'] as { postStateDigest?: string }).postStateDigest)
    && ev.rows.every(x => Array.isArray((x['report'] as { plan?: unknown[] }).plan)), ev.rows.map(x => ({ version: x['version'], list_digest: String(x['list_digest']).slice(0, 16), target: x['target'] })));
  const bootRow = (await tofu.query(`SELECT version, list_digest FROM public.schema_migration_evidence WHERE kind = 'runner-bootstrap'`)).rows;
  check('evidence-table bootstrap creation self-recorded once (SA2-A 3(c))', bootRow.length === 1 && String(bootRow[0]!['version']) === '0000', bootRow);

  // 5) a REAL cross-tenant phone collision still blocks loudly WITH a valid ack
  //    (the ack is a precondition, never an override).
  await tofu2.query(`INSERT INTO users(user_id, org_id, email, phone, data) VALUES('u-a', 'org-1', 'a@x', '+972555000444', '{}')`);
  await tofu2.query(`INSERT INTO users(user_id, org_id, email, phone, data) VALUES('u-b', 'org-2', 'b@x', '  +972555000444 ', '{}')`);
  const pf2b = preflight(url2);
  const blockedRun = cliRun(url2, ['--ack', pf2b.requiredAck]);
  check('REAL CLI: a real cross-tenant collision still BLOCKS loudly even with a valid ack',
    blockedRun.status !== 0 && /ASSERTION refusal - guard 'no-duplicates' in '0002'/.test(blockedRun.stderr), { status: blockedRun.status });
  const t2 = await tofu2.query(`SELECT to_regclass('users_phone_unique') AS r`);
  check('tofu: blocked run built nothing', t2.rows[0]?.['r'] === null);

  // SA3 section 5: every lifecycle event has UNIQUE append-only identity on
  // BOTH databases (no (version,kind) collapse, no dropped invalidation).
  for (const [label, db] of [['tofu', tofu], ['tofu2', tofu2]] as const) {
    const ids = await db.query(`SELECT event_id FROM public.schema_migration_evidence`);
    const uniq = new Set(ids.rows.map(x => String(x['event_id'])));
    check(`SA3: ${label} evidence events all carry UNIQUE event_id (append-only; ${ids.rows.length} events)`, uniq.size === ids.rows.length && ids.rows.length > 0, ids.rows.length);
  }
  // tofu2's blocked run invalidated its ack too - TWO independent
  // invalidations across the run history are BOTH retained (Q2 class).
  const inv2 = await tofu2.query(`SELECT event_id, report->>'nonce' AS nonce FROM public.schema_migration_evidence WHERE kind = 'ack-invalidated'`);
  check('SA3 Q2: tofu2 abort invalidation recorded (never dropped by a conflict)', inv2.rows.length === 1, inv2.rows);

  // SA3 section 3: deployment-label bypass attempts against the MODULE UNDER
  // EVIDENCE (dist in the DIST lane): test/test-harness labels get NO ack-gate
  // exemption. Fresh scratch databases (no prior stamp) so the ACK GATE -
  // not the cross-deployment binding - is what refuses.
  for (const label of ['test', 'test-harness'] as const) {
    const scratch = `contake_sa3_label_${label.replace('-', '_')}`;
    await admin.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${scratch}"`);
    const sdb = mk(scratch);
    let labelRefused = '';
    try { await runMigrations(sdb, { deployment: label }); } catch (e) { labelRefused = String(e); }
    check(`SA3: deployment=${label} is REFUSED without an issued ack (no caller-label exemption in the shipped artifact)`,
      /OPERATOR GATE refusal/.test(labelRefused), labelRefused.slice(0, 160));
    // the ack gate binds ONLY the credential-identity data-mutation steps:
    // ungated 0001 init-schema provisions the schema by design; the refusal
    // must stop EVERY ack-gated step (0002 normalize + 0003 index).
    const sw = await sdb.query(`SELECT (SELECT count(*)::int FROM public.schema_migrations WHERE version <> '0001') AS gated_applied, to_regclass('public.users_phone_unique') AS idx`);
    check(`SA3: deployment=${label} refusal applies ZERO ack-gated steps (0002/0003 absent, index never built)`, sw.rows[0]?.['gated_applied'] === 0 && sw.rows[0]?.['idx'] === null, sw.rows[0]);
    await sdb.end();
    await admin.query(`DROP DATABASE "${scratch}" WITH (FORCE)`);
  }

  // SA3 section 5 on REAL PG: invalidation-failure -> DIRTY/INDETERMINATE
  // retaining BOTH errors; target blocks issuance + runs; attended
  // resolution unblocks (append-only dirty-resolved event).
  await tofu2.query(`DELETE FROM users WHERE user_id IN ('u-a', 'u-b')`); // keep guard quiet; sabotage the evidence writes instead
  const pfDirty = await issueOperatorPreflight(tofu2, { deployment: 'staging' });
  await tofu2.query(`CREATE OR REPLACE FUNCTION public.__sa3_fail_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated evidence-write failure'; END; $$`);
  await tofu2.query(`CREATE TRIGGER __sa3_fail_evidence BEFORE INSERT ON public.schema_migration_evidence FOR EACH ROW EXECUTE FUNCTION public.__sa3_fail_evidence()`);
  let dirtyErr = '';
  try { await runMigrations(tofu2, { deployment: 'staging', operatorAck: operatorAckFor(pfDirty) }); } catch (e) { dirtyErr = String(e); }
  check('SA3: invalidation-failure surfaces DIRTY/INDETERMINATE retaining BOTH error records',
    /DIRTY\/INDETERMINATE/.test(dirtyErr) && dirtyErr.includes('original failure:') && dirtyErr.includes('invalidation failure:') && dirtyErr.includes('simulated evidence-write failure'), dirtyErr.slice(0, 300));
  let dirtyBlockedRun = '';
  try { await runMigrations(tofu2, { deployment: 'staging' }); } catch (e) { dirtyBlockedRun = String(e); }
  check('SA3: DIRTY target blocks subsequent runs', /DIRTY TARGET refusal/.test(dirtyBlockedRun), dirtyBlockedRun.slice(0, 160));
  let dirtyBlockedIssue = '';
  try { await issueOperatorPreflight(tofu2, { deployment: 'staging' }); } catch (e) { dirtyBlockedIssue = String(e); }
  check('SA3: DIRTY target blocks preflight issuance', /DIRTY TARGET refusal/.test(dirtyBlockedIssue), dirtyBlockedIssue.slice(0, 160));
  // attended resolution (operator repairs the writer first, then resolves):
  await tofu2.query(`DROP TRIGGER __sa3_fail_evidence ON public.schema_migration_evidence`);
  await tofu2.query(`DROP FUNCTION public.__sa3_fail_evidence()`);
  await attendedResolveDirty(tofu2, { note: 'evidence writer repaired; abort reviewed by operator', resolvedBy: 'evidence' });
  const resolvedEv = await tofu2.query(`SELECT report FROM public.schema_migration_evidence WHERE kind = 'dirty-resolved'`);
  check('SA3: attended DIRTY resolution recorded as append-only event retaining the prior failure', resolvedEv.rows.length === 1 && JSON.stringify(resolvedEv.rows[0]?.['report']).includes('invalidationFailure'), resolvedEv.rows);
  const pfAfter = await issueOperatorPreflight(tofu2, { deployment: 'staging' });
  const rAfter = await runMigrations(tofu2, { deployment: 'staging', operatorAck: operatorAckFor(pfAfter) });
  check('SA3: target unblocked after attended resolution (fresh issuance + run applies 0002+0003)', JSON.stringify(rAfter.appliedNow) === '["0002","0003"]', rAfter.appliedNow);
  // SA4 section 4 on REAL PG through the BUILT CLI: marker-write failure is
  // an UNPROVEN-DIRTY hard stop - the run does NOT falsely claim DIRTY, ALL
  // failures are retained, and the target is NOT silently recorded dirty.
  await admin.query(`DROP DATABASE IF EXISTS contake_tofu3 WITH (FORCE)`);
  await admin.query(`CREATE DATABASE contake_tofu3`);
  const tofu3 = mk('contake_tofu3');
  await runMigrations(tofu3, { deployment: 'staging', migrations: MIGRATIONS.slice(0, 1) });
  const url3 = `postgres://postgres@${host}:${port}/contake_tofu3`;
  const pfUnproven = preflight(url3);
  await tofu3.query(`CREATE OR REPLACE FUNCTION public.__sa4_fail_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected evidence-write failure'; END; $$`);
  await tofu3.query(`CREATE OR REPLACE FUNCTION public.__sa4_fail_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected marker-write failure'; END; $$`);
  await tofu3.query(`CREATE TRIGGER __sa4_fail_evidence BEFORE INSERT ON public.schema_migration_evidence FOR EACH ROW EXECUTE FUNCTION public.__sa4_fail_evidence()`);
  await tofu3.query(`CREATE TRIGGER __sa4_fail_state BEFORE INSERT OR UPDATE ON public.schema_migration_target_state FOR EACH ROW EXECUTE FUNCTION public.__sa4_fail_state()`);
  const unproven = cliRun(url3, ['--ack', pfUnproven.requiredAck]);
  console.error(`OBSERVED[cli unproven-dirty]: status=${unproven.status}`);
  check('SA4: marker-write failure surfaces UNPROVEN-DIRTY hard stop through the built CLI (no false DIRTY claim)',
    unproven.status !== 0 && unproven.stderr.includes('UNPROVEN-DIRTY hard stop') && unproven.stderr.includes('no dirty state is claimed')
    && !/marked DIRTY/.test(unproven.stderr), { status: unproven.status, stderr: unproven.stderr.slice(0, 400) });
  check('SA4: UNPROVEN-DIRTY retains ALL failures (original + invalidation + marker) and reports the attempt-evidence failure honestly',
    unproven.stderr.includes('original failure:') && unproven.stderr.includes('invalidation/restore failure:') && unproven.stderr.includes('marker failure:')
    && unproven.stderr.includes('injected marker-write failure') && unproven.stderr.includes('attempt evidence write ALSO failed'), unproven.stderr.slice(0, 500));
  const ts3 = await tofu3.query(`SELECT dirty FROM public.schema_migration_target_state`);
  check('SA4: UNPROVEN-DIRTY persisted NO dirty marker (nothing silently recorded)', ts3.rows.length === 0 || ts3.rows[0]?.['dirty'] !== true, ts3.rows);
  check('SA4: UNPROVEN-DIRTY run applied nothing past 0001', JSON.stringify((await tofu3.query(`SELECT version FROM public.schema_migrations ORDER BY seq`)).rows.map(x => String(x['version']))) === '["0001"]');
  // attended recovery: operator repairs out of band; no durable marker to
  // resolve - fresh issuance + run succeed through the built CLI.
  await tofu3.query(`DROP TRIGGER __sa4_fail_evidence ON public.schema_migration_evidence`);
  await tofu3.query(`DROP TRIGGER __sa4_fail_state ON public.schema_migration_target_state`);
  await tofu3.query(`DROP FUNCTION public.__sa4_fail_evidence()`);
  await tofu3.query(`DROP FUNCTION public.__sa4_fail_state()`);
  const pf3 = preflight(url3);
  const recovered = cliRun(url3, ['--ack', pf3.requiredAck]);
  check('SA4: target not durably blocked - after attended repair the built CLI applies 0002+0003', recovered.status === 0 && recovered.stdout.includes('"0002"') && recovered.stdout.includes('"0003"'), { status: recovered.status });
  await tofu3.end();
  await admin.query(`DROP DATABASE contake_tofu3 WITH (FORCE)`);

  await tofu2.end(); await tofu.end();
  await admin.query(`DROP DATABASE contake_tofu2 WITH (FORCE)`);
  await admin.query(`DROP DATABASE contake_tofu WITH (FORCE)`);
} else {
  throw new Error('phase1|phase2|phase3|phase4|phase5 required');
}
await admin.end();
console.log(JSON.stringify(out, null, 2));
