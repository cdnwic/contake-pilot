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
  MIGRATIONS, EXPECTED_SCHEMA_VERSIONS, assertDirectDatabaseUrl, assertSchemaCurrent,
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
  it('assertion primitives are single SELECTs, nothing else', () => {
    expect(() => validateAssertion({ name: 'no_dupes', query: 'SELECT phone FROM users GROUP BY btrim(phone) HAVING count(*) > 1' })).not.toThrow();
    expect(() => validateAssertion({ name: 'bad', query: 'DELETE FROM users' })).toThrow(/ASSERTION refusal/);
    expect(() => validateAssertion({ name: 'bad', query: 'SELECT 1; SELECT 2' })).toThrow(/ASSERTION refusal/);
    expect(() => validateAssertion({ name: 'bad', query: 'SELECT pg_advisory_unlock(1)' })).toThrow(/ASSERTION refusal/);
    expect(() => validateAssertion({ name: 'bad', query: 'SAVEPOINT sp' })).toThrow(/ASSERTION refusal/);
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
    // First run on a fresh db reports firstRun (TOFU operator gate).
    const { pg: pg2, conn: conn2 } = await freshDb();
    await expect(verifyTargetPreconditions(conn2, { deployment: 'staging' })).resolves.toEqual({ firstRun: true });
    await pg2.close();
    await pg.close();
  });

  it('runtime boot verifies deployment AND instance identity', async () => {
    const { pg, conn } = await freshDb();
    const r = await runMigrations(conn, { deployment: 'staging' });
    await expect(assertSchemaCurrent(conn, undefined, { deployment: 'staging', instanceId: r.identity.instanceId })).resolves.toBeUndefined();
    await expect(assertSchemaCurrent(conn, undefined, { deployment: 'production-pilot' })).rejects.toThrow(/DEPLOYMENT refusal/);
    await expect(assertSchemaCurrent(conn, undefined, { instanceId: 'nope' })).rejects.toThrow(/INSTANCE refusal/);
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
    expect(stepDigest(a)).not.toBe(stepDigest({ ...a, assertions: [{ name: 'g', query: 'SELECT 1 FROM a' }] }));
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
    await expect(runMigrations(conn, { deployment: 'staging', migrations: [squat] })).rejects.toThrow(/collided inside its own transaction/);
    const v = await conn.query(`SELECT count(*)::int AS n FROM schema_migrations`);
    expect(Number(v.rows[0]?.['n'])).toBe(0);
    await pg.close();
  });

  it('guard primitives: assertion hard-fails inside the tx and rolls the step back', async () => {
    const { pg, conn } = await freshDb();
    await runMigrations(conn, { deployment: 'staging' });
    await conn.query(`INSERT INTO users(user_id, org_id, phone, data) VALUES('u1', 'o1', '+972555111111', '{}')`);
    const guarded = step('0002', 'guarded-index', `CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(btrim(phone)) WHERE phone IS NOT NULL`, {
      xactLockKey: 4242,
      lockTables: ['users'],
      assertions: [
        { name: 'no_users_yet', query: `SELECT user_id FROM users` },
      ],
    });
    await expect(runMigrations(conn, { deployment: 'staging', migrations: [...MIGRATIONS, guarded] })).rejects.toThrow(/ASSERTION refusal - guard 'no_users_yet'/);
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
      assertions: [
        { name: 'no_duplicate_normalized_phones', query: `SELECT btrim(phone) AS p FROM users WHERE phone IS NOT NULL GROUP BY btrim(phone) HAVING count(*) > 1` },
      ],
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
    await expect(runMigrations(conn2, { deployment: 'staging', migrations: [...MIGRATIONS, sa] })).rejects.toThrow(/ASSERTION refusal - guard 'no_duplicate_normalized_phones'/);
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
