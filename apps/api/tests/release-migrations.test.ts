/** Release-migration runner gates (unified declarative redesign 2026-09-18,
 *  after QA FAILs of f9854cd6/9182487e/22267edb + security verdicts + TL
 *  reconciliation): hermetic PGlite proofs. Cross-session locking, real-PG
 *  DDL rollback and restart durability are proven by
 *  apps/api/evidence-realpg-release-migrations.mts (PGlite is
 *  single-connection). */
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgliteConnectable } from '../src/repo/postgres.js';
import {
  MIGRATIONS, EXPECTED_SCHEMA_VERSIONS, artifactStatements, assertDirectDatabaseUrl,
  assertSchemaCurrent, assertZeroCatalogDelta, buildAssertionQuery, canonicalArtifactSql,
  catalogSnapshot, requiredBootIdentity,
  runMigrations, stepDigest, validateAssertion, validateMigrationArtifact,
  verifyTargetPreconditions, type MigrationStep,
} from '../src/migrations/runner.js';

async function freshDb() {
  const pg = new PGlite();
  const conn = pgliteConnectable(pg);
  return { pg, conn };
}

const step = (version: string, name: string, sql: string, extra?: Partial<MigrationStep>): MigrationStep => ({
  version, name, description: `test step ${name}`, sql, ...extra,
});

describe('declarative artifact gate (real-parser AST allowlist)', () => {
  it('accepts declarative DDL+DML', () => {
    expect(() => validateMigrationArtifact(`CREATE TABLE t(id int); CREATE UNIQUE INDEX i ON t(btrim(id::text)); INSERT INTO t VALUES (1);`)).not.toThrow();
    expect(() => validateMigrationArtifact(`ALTER TABLE t ADD COLUMN x text; COMMENT ON TABLE t IS 'c'; DROP INDEX i; DELETE FROM t WHERE id = 1;`)).not.toThrow();
  });
  it('rejects transaction control by AST type, not spelling', () => {
    for (const bad of ['COMMIT', 'commit', 'BEGIN', 'START TRANSACTION', 'ROLLBACK', 'END', 'ABORT', 'PREPARE TRANSACTION \'x\'']) {
      expect(() => validateMigrationArtifact(bad), bad).toThrow(/ARTIFACT refusal|unparsable/);
    }
  });
  it('rejects DO/CALL/SELECT/function execution (TL: no code in artifacts)', () => {
    for (const bad of [
      `DO $$ BEGIN RAISE EXCEPTION 'x'; END $$`, `CALL do_thing()`, 'SELECT 1',
      'SELECT pg_advisory_xact_lock(1)', // even the xact lock is runner-owned, not artifact SQL
      'CREATE TABLE t(id int); SELECT 1',
    ]) {
      expect(() => validateMigrationArtifact(bad), bad).toThrow(/ARTIFACT refusal/);
    }
  });
  it('rejects session advisory locks through quoting/schema/comment disguise', () => {
    for (const bad of [
      'SELECT pg_advisory_unlock(841000001)', 'SELECT "pg_advisory_unlock"(1)',
      'SELECT pg_catalog.pg_advisory_unlock(1)', '/* x */ SELECT pg_advisory_lock(1) -- y',
      'SELECT pg_advisory_unlock_all()', 'SELECT pg_try_advisory_lock(1)',
    ]) {
      expect(() => validateMigrationArtifact(bad), bad).toThrow(/ARTIFACT refusal/);
    }
  });
  it('unparseable text fails closed (SAVEPOINT/SET/LOCK syntax unsupported)', () => {
    for (const bad of ['SAVEPOINT sp', 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'LOCK TABLE users']) {
      expect(() => validateMigrationArtifact(bad), bad).toThrow(/ARTIFACT refusal - unparsable/);
    }
  });
  it('semantic layer: schema-qualified UDF, code/object-bearing statements, CTEs, subqueries all refused', () => {
    // QA escape class: schema-qualified UDF with an allowlisted leaf name
    expect(() => validateMigrationArtifact(`INSERT INTO users(user_id) VALUES (attacker.lower('x'))`)).toThrow(/non-pg_catalog schema/);
    expect(() => validateMigrationArtifact(`CREATE UNIQUE INDEX i ON users(public.btrim(phone))`)).toThrow(/non-pg_catalog schema/);
    expect(() => validateMigrationArtifact(`CREATE UNIQUE INDEX i ON attacker.users(btrim(phone))`)).toThrow(/controlled schema/);
    // code/object-bearing statement types
    for (const bad of [
      `CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
      `CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'`,
      `CREATE TRIGGER t BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION f()`,
      `CREATE OPERATOR public.=== (LEFTARG = text, RIGHTARG = text, FUNCTION = f)`,
      `CREATE CAST (text AS int) WITH FUNCTION f(text) AS ASSIGNMENT`,
      `CREATE RULE r AS ON INSERT TO users DO ALSO NOTHING`,
      `CREATE AGGREGATE a(text)(SFUNC = textcat, STYPE = text)`,
      `CREATE TYPE mood AS ENUM ('sad','ok')`,
      `CREATE PROCEDURE p() LANGUAGE sql AS 'SELECT 1'`,
      `DO $$ BEGIN RAISE NOTICE 'x'; END $$`,
      `CALL p()`,
    ]) {
      expect(() => validateMigrationArtifact(bad), bad).toThrow(/ARTIFACT refusal/);
    }
    // mutating CTEs and unneeded subqueries (recursively closed shapes)
    expect(() => validateMigrationArtifact(`WITH d AS (DELETE FROM users RETURNING *) SELECT 1`)).toThrow(/ARTIFACT refusal/);
    expect(() => validateMigrationArtifact(`WITH x AS (SELECT 1) INSERT INTO users(user_id) SELECT * FROM x`)).toThrow(/ARTIFACT refusal/);
    expect(() => validateMigrationArtifact(`INSERT INTO users(user_id) VALUES ((SELECT max(user_id) FROM users))`)).toThrow(/subquery/);
    expect(() => validateMigrationArtifact(`UPDATE users SET org_id = 'o1' WHERE user_id IN (SELECT user_id FROM channels)`)).toThrow(/subquery/);
    // ALTER action closure: OWNER refused
    expect(() => validateMigrationArtifact(`ALTER TABLE users OWNER TO postgres`)).toThrow(/ARTIFACT refusal/);
    // declarative shapes still pass (unqualified built-ins canonically pg_catalog)
    expect(() => validateMigrationArtifact(`CREATE UNIQUE INDEX i ON users(btrim(phone)) WHERE phone IS NOT NULL`)).not.toThrow();
    expect(() => validateMigrationArtifact(`CREATE TABLE t(id int DEFAULT 1, created timestamptz DEFAULT now())`)).not.toThrow();
    expect(() => validateMigrationArtifact(`INSERT INTO users(user_id, org_id, phone, data) VALUES ('u','o','p','{}')`)).not.toThrow();
  });

  it('named runner-generated guards: strict objects, qualified SQL generated by the runner only', () => {
    expect(buildAssertionQuery({ kind: 'table-empty', table: 'users' }))
      .toBe('SELECT 1 AS violation FROM "public"."users" LIMIT 1');
    expect(buildAssertionQuery({ kind: 'no-duplicates', table: 'users', column: 'phone', normalize: 'btrim' }))
      .toBe('SELECT 1 AS violation FROM "public"."users" WHERE "phone" IS NOT NULL GROUP BY pg_catalog.btrim("phone") HAVING pg_catalog.count(*) > 1 LIMIT 1');
    expect(buildAssertionQuery({ kind: 'no-nulls', table: 'users', column: 'phone' }))
      .toBe('SELECT 1 AS violation FROM "public"."users" WHERE "phone" IS NULL LIMIT 1');
    expect(() => validateAssertion({ kind: 'table-empty', table: 'users; DROP TABLE users' } as never)).toThrow(/invalid assertion/);
    expect(() => validateAssertion({ kind: 'no-duplicates', table: 'users', column: 'phone",1);--' } as never)).toThrow(/invalid assertion/);
    expect(() => validateAssertion({ kind: 'nope', table: 'users' } as never)).toThrow(/unknown assertion kind/);
    // STRICT runtime validation (security closure): exact own-key sets,
    // exact enums/booleans, canonical identifiers
    expect(() => validateAssertion({ kind: 'table-empty', table: 'users', extra: 1 } as never)).toThrow(/unexpected key/);
    expect(() => validateAssertion({ kind: 'no-nulls', table: 'users', column: 'phone', normalize: 'none' } as never)).toThrow(/unexpected key/);
    expect(() => validateAssertion({ kind: 'no-duplicates', table: 'users', column: 'phone', normalize: 'BTRIM' } as never)).toThrow(/exactly 'btrim' or 'none'/);
    expect(() => validateAssertion({ kind: 'no-duplicates', table: 'users', column: 'phone', skipNulls: 'yes' } as never)).toThrow(/exact boolean/);
    expect(() => validateAssertion({ kind: 'no-duplicates', table: 'Users', column: 'phone' } as never)).toThrow(/invalid assertion/);
    expect(() => validateAssertion({ kind: 'no-duplicates', table: 'public.users', column: 'phone' } as never)).toThrow(/invalid assertion/);
    expect(() => validateAssertion(null as never)).toThrow(/must be an object/);
  });

  it('CTL-DDL-CONFINEMENT: every non-transactional statement class refused', () => {
    for (const bad of [
      `CREATE INDEX CONCURRENTLY i ON users(phone)`,
      `DROP INDEX CONCURRENTLY users_phone_unique`,
      `VACUUM users`,
      `REINDEX TABLE users`,
      `ALTER SYSTEM SET work_mem = '64MB'`,
      `CREATE DATABASE rogue`,
      `DROP DATABASE contake`,
      `CALL p()`,
      `DO $$ BEGIN NULL; END $$`,
    ]) {
      expect(() => validateMigrationArtifact(bad), bad).toThrow(/ARTIFACT refusal/);
    }
  });

  it('CTL-DDL-CONFINEMENT: catalog diff catches every persisting code/privilege/ownership class; post-rollback catalog exactly equal', async () => {
    const { pg, conn } = await freshDb();
    await runMigrations(conn, { deployment: 'staging' });
    await conn.query(`CREATE SEQUENCE public.demo_seq`);
    const baseline = await catalogSnapshot(conn);
    const rogueBatches: [string, string[]][] = [
      ['SECURITY DEFINER function', [`CREATE FUNCTION public.sd() RETURNS int SECURITY DEFINER LANGUAGE sql AS 'SELECT 1'`]],
      ['plain function', [`CREATE FUNCTION public.pl() RETURNS int LANGUAGE sql AS 'SELECT 1'`]],
      ['trigger', [`CREATE FUNCTION public.tf() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'`, `CREATE TRIGGER tr BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.tf()`]],
      ['rule', [`CREATE RULE rr AS ON INSERT TO public.users DO ALSO NOTHING`]],
      ['operator', [`CREATE FUNCTION public.oef(text, text) RETURNS boolean LANGUAGE sql AS 'SELECT true'`, `CREATE OPERATOR public.=== (LEFTARG = text, RIGHTARG = text, FUNCTION = public.oef)`]],
      ['cast', [`CREATE FUNCTION public.cf(text) RETURNS int LANGUAGE sql AS 'SELECT 1'`, `CREATE CAST (text AS int) WITH FUNCTION public.cf(text) AS ASSIGNMENT`]],
      ['ACL grant', [`GRANT SELECT ON public.users TO PUBLIC`]],
      ['default ACL', [`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC`]],
      ['role setting (config drift)', [`ALTER ROLE CURRENT_USER SET work_mem = '64MB'`]],
      ['policy', [`CREATE POLICY pol ON public.users USING (true)`]],
      ['sequence value (non-transactional)', [`SELECT nextval('public.demo_seq')`]],
    ];
    for (const [label, batch] of rogueBatches) {
      await conn.query('BEGIN');
      const before = await catalogSnapshot(conn);
      for (const q of batch) await conn.query(q);
      const after = await catalogSnapshot(conn);
      expect(() => assertZeroCatalogDelta(before, after, 'rogue'), label).toThrow(/CATALOG DELTA refusal/);
      await conn.query('ROLLBACK');
      if (label === 'sequence value (non-transactional)') {
        // nextval NEVER rolls back (condition 6): detection holds here; the
        // runner-level restore is proven separately below. Re-baseline.
        const drift = JSON.stringify(await catalogSnapshot(conn));
        expect(drift).not.toBe(JSON.stringify(baseline));
        await conn.query(`SELECT setval('public.demo_seq', 1, false)`);
      }
      // condition 5: post-rollback catalog equality is EXACT (canonical serialization)
      expect(JSON.stringify(await catalogSnapshot(conn)), label).toBe(JSON.stringify(baseline));
    }
    // benign step keeps zero diff (no false positive on legal DDL)
    await conn.query('BEGIN');
    const b0 = await catalogSnapshot(conn);
    await conn.query(`CREATE TABLE public.benign(id int)`);
    const a0 = await catalogSnapshot(conn);
    expect(() => assertZeroCatalogDelta(b0, a0, 'benign')).not.toThrow();
    await conn.query('ROLLBACK');
    await pg.close();
  });

  it('CTL-DDL-CONFINEMENT condition 6: artifact nextval on a pre-existing sequence is refused AND actively restored', async () => {
    const { pg, conn } = await freshDb();
    await runMigrations(conn, { deployment: 'staging' });
    await conn.query(`CREATE SEQUENCE public.demo_seq`);
    await conn.query(`CREATE TABLE public.t(id bigint)`);
    const greedy = step('0002', 'greedy', `INSERT INTO public.t(id) VALUES (pg_catalog.nextval('public.demo_seq'))`);
    await expect(runMigrations(conn, { deployment: 'staging', migrations: [...MIGRATIONS, greedy] })).rejects.toThrow(/CATALOG DELTA refusal/);
    const v = await conn.query(`SELECT count(*)::int AS n FROM public.t`);
    expect(Number(v.rows[0]?.['n'])).toBe(0);
    const sq = await conn.query(`SELECT is_called AS ic FROM public.demo_seq`);
    expect(sq.rows[0]?.['ic']).toBe(false); // actively restored, not merely detected
    await pg.close();
  });

  it('digest binds the canonical QUALIFIED serialization actually executed; parse-serialize-reparse is stable', () => {
    const canon = canonicalArtifactSql('CREATE TABLE IF NOT EXISTS t(id int)');
    // identifiers canonically fully qualified: relations to public, calls to pg_catalog
    expect(canon).toContain('public');
    expect(canonicalArtifactSql('CREATE UNIQUE INDEX i ON users(btrim(phone)) WHERE phone IS NOT NULL')).toContain('pg_catalog');
    expect(canonicalArtifactSql('CREATE TABLE IF NOT EXISTS public.t(id int)')).toBe(canon);
    expect(canonicalArtifactSql('CREATE TABLE IF NOT EXISTS t (id bigint)')).not.toBe(canon);
    for (const m of MIGRATIONS) {
      const once = canonicalArtifactSql(m.sql);
      expect(canonicalArtifactSql(once)).toBe(once);
    }
    expect(stepDigest(step('0001', 'x', 'CREATE TABLE a(id int)'))).toBe(stepDigest(step('0001', 'x', 'CREATE  TABLE  public.a(id  int)')));
  });
});

describe('release-migration runner', () => {
  it('boot gate fails closed before any initialization', async () => {
    const { pg, conn } = await freshDb();
    await expect(assertSchemaCurrent(conn)).rejects.toThrow(/never initialized|fail-closed/);
    await pg.close();
  });

  it('initializes explicitly; boot gate passes; re-run is a no-op', async () => {
    const { pg, conn } = await freshDb();
    const r1 = await runMigrations(conn, { deployment: 'staging' });
    expect(r1.appliedNow).toEqual([...EXPECTED_SCHEMA_VERSIONS]);
    expect(r1.stampedNow).toBe(true);
    for (const t of ['users', 'otp_codes', 'auth_audit', 'schema_migrations', 'contake_db_identity']) {
      const q = await conn.query(`SELECT to_regclass('${t}') AS r`);
      expect(q.rows[0]?.['r'], `table ${t}`).toBe(t);
    }
    await expect(assertSchemaCurrent(conn)).resolves.toBeUndefined();
    const r2 = await runMigrations(conn, { deployment: 'staging' });
    expect([r2.appliedNow, r2.stampedNow]).toEqual([[], false]);
    await pg.close();
  });

  it('adopts a pre-migration database as a no-op baseline (IF NOT EXISTS)', async () => {
    const { pg, conn } = await freshDb();
    const { GRAPH_DDL } = await import('../src/repo/postgres.js');
    for (const stmt of GRAPH_DDL.split(';').map(s => s.trim()).filter(Boolean)) await conn.query(stmt);
    const r = await runMigrations(conn, { deployment: 'production-pilot' });
    expect(r.appliedNow).toEqual(['0001']);
    await expect(assertSchemaCurrent(conn)).resolves.toBeUndefined();
    await pg.close();
  });

  it('pre-mutation target binding: pin and deployment verified BEFORE any write', async () => {
    const { pg, conn } = await freshDb();
    // Wrong deployment label on an UNSTAMPED db: fine (first run). Wrong PIN
    // on a STAMPED db must refuse with zero writes.
    await runMigrations(conn, { deployment: 'staging' });
    const stamped = await conn.query(`SELECT instance_id FROM contake_db_identity`);
    const iid = String(stamped.rows[0]!['instance_id']);
    await expect(verifyTargetPreconditions(conn, { deployment: 'staging', expectInstanceId: 'wrong-pin' })).rejects.toThrow(/INSTANCE BINDING refusal/);
    await expect(verifyTargetPreconditions(conn, { deployment: 'production-pilot' })).rejects.toThrow(/CROSS-DEPLOYMENT refusal/);
    await expect(verifyTargetPreconditions(conn, { deployment: 'staging', expectInstanceId: iid })).resolves.toEqual(
      { firstRun: false, identity: { deploymentLabel: 'staging', instanceId: iid } },
    );
    // runMigrations with a wrong pin refuses too (defense in depth, pre-step).
    await expect(runMigrations(conn, { deployment: 'staging', expectInstanceId: 'wrong-pin' })).rejects.toThrow(/INSTANCE BINDING refusal/);
    // Fresh DB + supplied pin: refused BEFORE any write (TOFU requires an
    // omitted pin + attended verification).
    const { pg: pg2, conn: conn2 } = await freshDb();
    await expect(verifyTargetPreconditions(conn2, { deployment: 'staging' })).resolves.toEqual({ firstRun: true });
    await expect(verifyTargetPreconditions(conn2, { deployment: 'staging', expectInstanceId: '0123456789abcdef' })).rejects.toThrow(/INSTANCE BINDING refusal/);
    await expect(runMigrations(conn2, { deployment: 'staging', expectInstanceId: '0123456789abcdef' })).rejects.toThrow(/INSTANCE BINDING refusal/);
    const sm = await conn2.query(`SELECT to_regclass('schema_migrations') AS r`);
    expect(sm.rows[0]?.['r']).toBeNull(); // zero writes
    await pg2.close();
    await pg.close();
  });

  it('runtime boot: EVERY PG boot requires validated deployment + instance identity', async () => {
    const { pg, conn } = await freshDb();
    const r = await runMigrations(conn, { deployment: 'staging' });
    const iid = r.identity.instanceId;
    // missing/malformed instance id fails closed for ANY deployment shape
    expect(() => requiredBootIdentity('staging', undefined)).toThrow(/CONTAKE_DB_INSTANCE_ID/);
    expect(() => requiredBootIdentity('production-pilot', undefined)).toThrow(/CONTAKE_DB_INSTANCE_ID/);
    expect(() => requiredBootIdentity('dev', 'not-hex')).toThrow(/CONTAKE_DB_INSTANCE_ID/);
    expect(requiredBootIdentity('staging', iid)).toEqual({ deployment: 'staging', instanceId: iid });
    await expect(assertSchemaCurrent(conn, undefined, { deployment: 'staging', instanceId: iid })).resolves.toBeUndefined();
    await expect(assertSchemaCurrent(conn, undefined, { deployment: 'production-pilot', instanceId: iid })).rejects.toThrow(/DEPLOYMENT refusal/);
    await expect(assertSchemaCurrent(conn, undefined, { deployment: 'staging', instanceId: '0123456789abcdef' })).rejects.toThrow(/INSTANCE refusal/);
    await pg.close();
  });

  it('forward-only: unknown/gapped history refuses; boot gate flags it', async () => {
    const { pg, conn } = await freshDb();
    await runMigrations(conn, { deployment: 'staging' });
    await conn.query(`INSERT INTO schema_migrations(version, name, sha256, applied_by) VALUES('0099', 'foreign', 'x', 'test')`);
    await expect(runMigrations(conn, { deployment: 'staging' })).rejects.toThrow(/FORWARD-ONLY/);
    await expect(assertSchemaCurrent(conn)).rejects.toThrow(/unknown=\[0099\]/);
    await pg.close();
  });

  it('edited applied history (name or digest) fails runner AND boot gate', async () => {
    const { pg, conn } = await freshDb();
    await runMigrations(conn, { deployment: 'staging' });
    await conn.query(`UPDATE schema_migrations SET name = 'renamed' WHERE version = '0001'`);
    await expect(runMigrations(conn, { deployment: 'staging' })).rejects.toThrow(/INTEGRITY refusal/);
    await conn.query(`UPDATE schema_migrations SET name = 'init-schema', sha256 = 'deadbeef' WHERE version = '0001'`);
    await expect(assertSchemaCurrent(conn)).rejects.toThrow(/INTEGRITY refusal/);
    await pg.close();
  });

  it('digest binds the exact artifact text AND declared primitives', () => {
    const a = step('0001', 'x', 'CREATE TABLE a(id int)');
    expect(stepDigest(a)).not.toBe(stepDigest(step('0001', 'x', 'CREATE TABLE b(id int)')));
    expect(stepDigest(a)).not.toBe(stepDigest({ ...a, xactLockKey: 7 }));
    expect(stepDigest(a)).not.toBe(stepDigest({ ...a, assertions: [{ kind: 'table-empty', table: 'a' }] }));
    expect(stepDigest(a)).toBe(stepDigest({ ...a, description: 'edited metadata only' }));
  });

  it('implementation-only edit of an applied artifact fails rerun AND boot', async () => {
    const { pg, conn } = await freshDb();
    const decl = { version: '0002', name: 'add-flags', description: 'd' };
    const implA = step(decl.version, decl.name, `ALTER TABLE users ADD COLUMN IF NOT EXISTS flags text`);
    const r = await runMigrations(conn, { deployment: 'staging', migrations: [...MIGRATIONS, implA] });
    expect(r.appliedNow).toEqual(['0001', '0002']);
    const implB = step(decl.version, decl.name, `ALTER TABLE users ADD COLUMN IF NOT EXISTS flags varchar`);
    await expect(runMigrations(conn, { deployment: 'staging', migrations: [...MIGRATIONS, implB] })).rejects.toThrow(/INTEGRITY refusal/);
    await expect(assertSchemaCurrent(conn, [...MIGRATIONS, implA])).resolves.toBeUndefined();
    await pg.close();
  });

  it('a failing artifact statement rolls back the whole step (no partial DDL, no version)', async () => {
    const { pg, conn } = await freshDb();
    const failing = step('0001', 'partial', `CREATE TABLE partial_leak(id int); CREATE TABLE partial_leak(id int)`);
    await expect(runMigrations(conn, { deployment: 'staging', migrations: [failing] })).rejects.toThrow();
    const t = await conn.query(`SELECT to_regclass('partial_leak') AS r`);
    expect(t.rows[0]?.['r']).toBeNull();
    const v = await conn.query(`SELECT count(*)::int AS n FROM schema_migrations`);
    expect(Number(v.rows[0]?.['n'])).toBe(0);
    await runMigrations(conn, { deployment: 'staging' });
    await expect(assertSchemaCurrent(conn)).resolves.toBeUndefined();
    await pg.close();
  });

  it('a version-record collision rolls back the artifact DML too', async () => {
    const { pg, conn } = await freshDb();
    const squat = step('0001', 'squatter', `INSERT INTO schema_migrations(version, name, sha256, applied_by) VALUES('0001', 'squatter', 'x', 'test')`);
    await expect(runMigrations(conn, { deployment: 'staging', migrations: [squat] })).rejects.toThrow(/collided inside its own transaction|CATALOG DELTA refusal/);
    const v = await conn.query(`SELECT count(*)::int AS n FROM schema_migrations`);
    expect(Number(v.rows[0]?.['n'])).toBe(0);
    // condition 6: the squatter's nextval was actively RESTORED after rollback
    const sq = await conn.query(`SELECT is_called AS ic FROM public.schema_migrations_seq_seq`);
    expect(sq.rows[0]?.['ic']).toBe(false);
    await pg.close();
  });

  it('guard primitives: assertion hard-fails inside the tx and rolls the step back', async () => {
    const { pg, conn } = await freshDb();
    await runMigrations(conn, { deployment: 'staging' });
    await conn.query(`INSERT INTO users(user_id, org_id, phone, data) VALUES('u1', 'o1', '+972555111111', '{}')`);
    const guarded = step('0002', 'guarded-index', `CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(btrim(phone)) WHERE phone IS NOT NULL`, {
      xactLockKey: 4242,
      lockTables: ['users'],
      assertions: [{ kind: 'table-empty', table: 'users' }],
    });
    await expect(runMigrations(conn, { deployment: 'staging', migrations: [...MIGRATIONS, guarded] })).rejects.toThrow(/ASSERTION refusal - guard 'table-empty'/);
    const idx = await conn.query(`SELECT to_regclass('users_phone_unique') AS r`);
    expect(idx.rows[0]?.['r']).toBeNull(); // artifact never applied
    const v = await conn.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version = '0002'`);
    expect(Number(v.rows[0]?.['n'])).toBe(0);
    await pg.close();
  });

  it('SA-shaped declarative step (locks + guards + canonical index) applies and is recorded', async () => {
    const { pg, conn } = await freshDb();
    const sa = step('0002', 'users-phone-unique-index', `CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(btrim(phone)) WHERE phone IS NOT NULL`, {
      xactLockKey: 123456,
      lockTables: ['users'],
      assertions: [{ kind: 'no-duplicates', table: 'users', column: 'phone', normalize: 'btrim' }],
    });
    const r = await runMigrations(conn, { deployment: 'staging', migrations: [...MIGRATIONS, sa] });
    expect(r.appliedNow).toEqual(['0001', '0002']);
    const idx = await conn.query(`SELECT to_regclass('users_phone_unique') AS r`);
    expect(idx.rows[0]?.['r']).toBe('users_phone_unique');
    await expect(assertSchemaCurrent(conn, [...MIGRATIONS, sa])).resolves.toBeUndefined();
    // duplicate normalized phones would block a rerun-shaped step on another db
    const { pg: pg2, conn: conn2 } = await freshDb();
    await runMigrations(conn2, { deployment: 'staging' });
    await conn2.query(`INSERT INTO users(user_id, org_id, phone, data) VALUES('a', 'o', '+972555111111', '{}'), ('b', 'o', ' +972555111111 ', '{}')`);
    await expect(runMigrations(conn2, { deployment: 'staging', migrations: [...MIGRATIONS, sa] })).rejects.toThrow(/ASSERTION refusal - guard 'no-duplicates'/);
    await pg2.close();
    await pg.close();
  });

  it('rejects a non-sequential registry and invalid primitive declarations', async () => {
    const { pg, conn } = await freshDb();
    await expect(runMigrations(conn, { deployment: 'staging', migrations: [step('0007', 'x', 'SELECT 1')] })).rejects.toThrow(/strictly sequential/);
    await expect(runMigrations(conn, { deployment: 'staging', migrations: [step('0001', 'x', 'CREATE TABLE t(id int)', { lockTables: ['evil; DROP TABLE users'] })] })).rejects.toThrow(/invalid lockTables/);
    await pg.close();
  });

  it('role separation: pooled endpoints are refused; descriptors carry no credentials', () => {
    expect(() => assertDirectDatabaseUrl('postgresql://u:SECRET@ep-cool-pooler.eu-central-1.aws.neon.tech/contake')).toThrow(/POOLED/);
    const d = assertDirectDatabaseUrl('postgresql://u:SECRET@ep-cool.eu-central-1.aws.neon.tech/contake');
    expect([d.host, d.database]).toEqual(['ep-cool.eu-central-1.aws.neon.tech', 'contake']);
    expect(JSON.stringify(d)).not.toContain('SECRET');
  });
});
