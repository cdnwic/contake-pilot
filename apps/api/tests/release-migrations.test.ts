/** Release-migration runner gates (2026-09-18, hardened after QA FAILs of
 *  f9854cd6 and 9182487e + security FAIL of 9182487e): hermetic PGlite proofs
 *  that
 *  - a fresh database is initialized explicitly and becomes boot-able;
 *  - re-runs are idempotent; history is forward-only (unknown/gap refuses);
 *  - EVERY step is one transaction: body AND version record commit or roll
 *    back together (partial DDL can never persist versionless);
 *  - digests are MECHANICALLY BOUND to the executed implementation: sql steps
 *    hash the exact executed text; fn steps hash the exact executed function
 *    source - an implementation-only edit is an integrity failure;
 *  - steps run on a RESTRICTED capability: transaction control and
 *    session-lock escape are mechanically rejected (case/whitespace/comment
 *    variants), and the rejection rolls the whole step back;
 *  - applied-step integrity is enforced in the runner AND the boot gate;
 *  - the runtime boot verifies the expected DEPLOYMENT against the stamped
 *    database identity before serving;
 *  - cross-deployment runs are refused by the stamped identity;
 *  - pooled endpoints are refused for schema work.
 *  Advisory-lock concurrency, real-Postgres DDL rollback, restart durability
 *  and real-PG seed transactions are proven by
 *  apps/api/evidence-realpg-release-migrations.mts against a disposable
 *  cluster (PGlite is single-connection and cannot prove cross-session
 *  locking). */
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgliteConnectable } from '../src/repo/postgres.js';
import {
  MIGRATIONS, EXPECTED_SCHEMA_VERSIONS, assertDirectDatabaseUrl, assertNoTransactionControl,
  assertSchemaCurrent, runMigrations, stepDigest, type MigrationStep,
} from '../src/migrations/runner.js';

async function freshDb() {
  const pg = new PGlite();
  const conn = pgliteConnectable(pg);
  return { pg, conn };
}

const sqlStep = (version: string, name: string, sql: string): MigrationStep => ({
  kind: 'sql', version, name, description: `test step ${name}`, sql,
});
const fnStep = (version: string, name: string, up: (tx: { query(t: string, p?: unknown[]): Promise<unknown> }) => Promise<void>): MigrationStep => ({
  kind: 'fn', version, name, description: `test step ${name}`, up: up as never,
});

describe('release-migration runner', () => {
  it('boot gate fails closed before any initialization', async () => {
    const { pg, conn } = await freshDb();
    await expect(assertSchemaCurrent(conn)).rejects.toThrow(/never initialized|fail-closed/);
    await pg.close();
  });

  it('initializes a fresh database explicitly; boot gate then passes; re-run is a no-op', async () => {
    const { pg, conn } = await freshDb();
    const r1 = await runMigrations(conn, { deployment: 'staging' });
    expect(r1.appliedNow).toEqual([...EXPECTED_SCHEMA_VERSIONS]);
    expect(r1.stampedNow).toBe(true);
    expect(r1.identity.deploymentLabel).toBe('staging');
    expect(r1.identity.instanceId).toMatch(/^[0-9a-f]{16}$/);
    for (const t of ['users', 'otp_codes', 'otp_requests', 'otp_verify_state', 'auth_audit', 'schema_migrations', 'contake_db_identity']) {
      const q = await conn.query(`SELECT to_regclass('${t}') AS r`);
      expect(q.rows[0]?.['r'], `table ${t}`).toBe(t);
    }
    await expect(assertSchemaCurrent(conn)).resolves.toBeUndefined();
    const r2 = await runMigrations(conn, { deployment: 'staging' });
    expect(r2.appliedNow).toEqual([]);
    expect(r2.stampedNow).toBe(false);
    expect(r2.identity.instanceId).toBe(r1.identity.instanceId);
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

  it('refuses a cross-deployment run against the stamped identity', async () => {
    const { pg, conn } = await freshDb();
    await runMigrations(conn, { deployment: 'staging' });
    await expect(runMigrations(conn, { deployment: 'production-pilot' })).rejects.toThrow(/CROSS-DEPLOYMENT/);
    await pg.close();
  });

  it('forward-only: unknown applied history refuses; boot gate flags unknown versions', async () => {
    const { pg, conn } = await freshDb();
    await runMigrations(conn, { deployment: 'staging' });
    await conn.query(`INSERT INTO schema_migrations(version, name, sha256, applied_by) VALUES('0099', 'foreign', 'x', 'test')`);
    await expect(runMigrations(conn, { deployment: 'staging' })).rejects.toThrow(/FORWARD-ONLY/);
    await expect(assertSchemaCurrent(conn)).rejects.toThrow(/unknown=\[0099\]/);
    await pg.close();
  });

  it('boot gate fails closed when a version is missing', async () => {
    const { pg, conn } = await freshDb();
    await runMigrations(conn, { deployment: 'staging' });
    await conn.query(`DELETE FROM schema_migrations WHERE version = '0001'`);
    await expect(assertSchemaCurrent(conn)).rejects.toThrow(/missing=\[0001\]/);
    await pg.close();
  });

  it('runtime boot verifies the expected deployment against the stamped identity', async () => {
    const { pg, conn } = await freshDb();
    await runMigrations(conn, { deployment: 'staging' });
    await expect(assertSchemaCurrent(conn, undefined, { deployment: 'staging' })).resolves.toBeUndefined();
    await expect(assertSchemaCurrent(conn, undefined, { deployment: 'production-pilot' })).rejects.toThrow(/DEPLOYMENT refusal/);
    await pg.close();
  });

  it('a step that throws mid-DDL leaves NO partial DDL and NO version row', async () => {
    const { pg, conn } = await freshDb();
    const failing = fnStep('0001', 'partial-ddl', async tx => {
      await tx.query('CREATE TABLE partial_leak(id int)');
      throw new Error('boom mid-DDL');
    });
    await expect(runMigrations(conn, { deployment: 'staging', migrations: [failing] })).rejects.toThrow(/boom mid-DDL/);
    const t = await conn.query(`SELECT to_regclass('partial_leak') AS r`);
    expect(t.rows[0]?.['r']).toBeNull(); // DDL rolled back with the step tx
    const v = await conn.query(`SELECT count(*)::int AS n FROM schema_migrations`);
    expect(Number(v.rows[0]?.['n'])).toBe(0);
    await runMigrations(conn, { deployment: 'staging' });
    await expect(assertSchemaCurrent(conn)).resolves.toBeUndefined();
    await pg.close();
  });

  it('a version-record collision rolls back the step body too', async () => {
    const { pg, conn } = await freshDb();
    const colliding = fnStep('0001', 'self-colliding', async tx => {
      await tx.query('CREATE TABLE coll_leak(id int)');
      await tx.query(`INSERT INTO schema_migrations(version, name, sha256, applied_by) VALUES('0001', 'squatter', 'x', 'test')`);
    });
    await expect(runMigrations(conn, { deployment: 'staging', migrations: [colliding] })).rejects.toThrow(/collided inside its own transaction/);
    const t = await conn.query(`SELECT to_regclass('coll_leak') AS r`);
    expect(t.rows[0]?.['r']).toBeNull();
    const v = await conn.query(`SELECT version FROM schema_migrations`);
    expect(v.rows).toHaveLength(0);
    await pg.close();
  });

  it('edited applied history (name or digest) fails runner AND boot gate', async () => {
    const { pg, conn } = await freshDb();
    await runMigrations(conn, { deployment: 'staging' });
    await conn.query(`UPDATE schema_migrations SET name = 'renamed' WHERE version = '0001'`);
    await expect(runMigrations(conn, { deployment: 'staging' })).rejects.toThrow(/INTEGRITY refusal/);
    await expect(assertSchemaCurrent(conn)).rejects.toThrow(/INTEGRITY refusal/);
    await conn.query(`UPDATE schema_migrations SET name = 'init-schema', sha256 = 'deadbeef' WHERE version = '0001'`);
    await expect(runMigrations(conn, { deployment: 'staging' })).rejects.toThrow(/INTEGRITY refusal/);
    await expect(assertSchemaCurrent(conn)).rejects.toThrow(/INTEGRITY refusal/);
    await pg.close();
  });

  it('digest is mechanically bound: sql text change flips it, metadata edit does not', () => {
    const a = sqlStep('0001', 'x', 'CREATE TABLE a(id int)');
    const b = sqlStep('0001', 'x', 'CREATE TABLE b(id int)');
    const c = { ...a, description: 'edited description only' };
    expect(stepDigest(a)).not.toBe(stepDigest(b)); // executed text change -> digest change
    expect(stepDigest(a)).toBe(stepDigest(c)); // editable metadata is not the artifact
  });

  it('digest is mechanically bound: fn implementation-only change with unchanged declaration flips it', () => {
    const decl = { kind: 'fn' as const, version: '0002', name: 'users-phone', description: 'same declaration' };
    const a: MigrationStep = { ...decl, up: async tx => { await tx.query('CREATE UNIQUE INDEX i1 ON users(phone)'); } };
    const b: MigrationStep = { ...decl, up: async tx => { await tx.query('CREATE UNIQUE INDEX i2 ON users(phone)'); } };
    expect(stepDigest(a)).not.toBe(stepDigest(b)); // the EXECUTED source is the digest input
  });

  it('implementation-only edit of an applied fn step fails the rerun and the boot gate', async () => {
    const { pg, conn } = await freshDb();
    const decl = { version: '0002', name: 'users-phone-unique-index', description: 'sa shape' };
    const implA: MigrationStep = { kind: 'fn', ...decl, up: async tx => { await tx.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(btrim(phone)) WHERE phone IS NOT NULL`); } };
    const r = await runMigrations(conn, { deployment: 'staging', migrations: [...MIGRATIONS, implA] });
    expect(r.appliedNow).toEqual(['0001', '0002']);
    // Same declaration, silently edited implementation body:
    const implB: MigrationStep = { kind: 'fn', ...decl, up: async tx => { await tx.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(phone) WHERE phone IS NOT NULL`); } };
    await expect(runMigrations(conn, { deployment: 'staging', migrations: [...MIGRATIONS, implB] })).rejects.toThrow(/INTEGRITY refusal/);
    await expect(assertSchemaCurrent(conn, [...MIGRATIONS, implB])).rejects.toThrow(/INTEGRITY refusal/);
    await expect(assertSchemaCurrent(conn, [...MIGRATIONS, implA])).resolves.toBeUndefined();
    await pg.close();
  });

  it('restricted capability: transaction control is rejected in case/whitespace/comment/multi-statement variants', () => {
    for (const bad of [
      'COMMIT', 'commit', 'CoMmIt', '  COMMIT  ', '/* sneaky */ COMMIT', '-- lead\nCOMMIT',
      'SELECT 1; COMMIT', 'BEGIN', 'START TRANSACTION', 'ROLLBACK', 'END;', 'SAVEPOINT sp1',
      'RELEASE SAVEPOINT sp1', 'PREPARE TRANSACTION \'x\'', 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
      '/* multi\nline */ rollback /* tail */',
    ]) {
      expect(() => assertNoTransactionControl(bad), JSON.stringify(bad)).toThrow(/TRANSACTION-CONTROL refusal/);
    }
    for (const good of [
      'CREATE TABLE t(id int)', 'SELECT pg_advisory_xact_lock(1)', "INSERT INTO t VALUES('commit')",
      'SELECT 1; SELECT 2', 'SELECT pg_try_advisory_xact_lock(2)',
    ]) {
      expect(() => assertNoTransactionControl(good), JSON.stringify(good)).not.toThrow();
    }
  });

  it('restricted capability: session-advisory-lock escape is rejected; xact-scoped stays legal', () => {
    for (const bad of [
      'SELECT pg_advisory_unlock(841000001)', 'select pg_advisory_unlock_all()', 'SELECT pg_advisory_lock(1)',
      '/*x*/ SELECT pg_try_advisory_lock(1)',
    ]) {
      expect(() => assertNoTransactionControl(bad), JSON.stringify(bad)).toThrow(/SESSION-LOCK refusal/);
    }
    expect(() => assertNoTransactionControl('SELECT pg_advisory_xact_lock(841000001)')).not.toThrow();
  });

  it('a step attempting COMMIT mid-DDL is rejected and NOTHING persists (no partial DDL/DML)', async () => {
    const { pg, conn } = await freshDb();
    const escaping = fnStep('0001', 'tx-escape', async tx => {
      await tx.query('CREATE TABLE escape_leak(id int)');
      await tx.query(`INSERT INTO escape_leak VALUES (1)`);
      await tx.query('COMMIT'); // mechanical rejection -> step rolls back
    });
    await expect(runMigrations(conn, { deployment: 'staging', migrations: [escaping] })).rejects.toThrow(/TRANSACTION-CONTROL refusal/);
    const t = await conn.query(`SELECT to_regclass('escape_leak') AS r`);
    expect(t.rows[0]?.['r']).toBeNull(); // no partial DDL
    const v = await conn.query(`SELECT count(*)::int AS n FROM schema_migrations`);
    expect(Number(v.rows[0]?.['n'])).toBe(0); // no version row
    await pg.close();
  });

  it('a step attempting to drop the runner session lock is rejected and rolled back', async () => {
    const { pg, conn } = await freshDb();
    const escaping = fnStep('0001', 'lock-escape', async tx => {
      await tx.query('CREATE TABLE lock_leak(id int)');
      await tx.query('SELECT pg_advisory_unlock(841000001)');
    });
    await expect(runMigrations(conn, { deployment: 'staging', migrations: [escaping] })).rejects.toThrow(/SESSION-LOCK refusal/);
    const t = await conn.query(`SELECT to_regclass('lock_leak') AS r`);
    expect(t.rows[0]?.['r']).toBeNull();
    await pg.close();
  });

  it('SA plug-in contract: a tx-scoped function step (migrateUsersPhone shape) is applied and recorded', async () => {
    const { pg, conn } = await freshDb();
    let called = 0;
    const saStep: MigrationStep = {
      kind: 'fn',
      version: '0002',
      name: 'users-phone-unique-index',
      description: 'test double matching the tx-scoped MigrationStep contract',
      up: async tx => {
        called += 1;
        // Legal inside the runner's transaction: advisory XACT lock + index.
        await tx.query(`SELECT pg_advisory_xact_lock(123456)`);
        await tx.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(btrim(phone)) WHERE phone IS NOT NULL`);
      },
    };
    const r = await runMigrations(conn, { deployment: 'staging', migrations: [...MIGRATIONS, saStep] });
    expect(r.appliedNow).toEqual(['0001', '0002']);
    expect(called).toBe(1);
    await expect(assertSchemaCurrent(conn, [...MIGRATIONS, saStep])).resolves.toBeUndefined();
    await expect(assertSchemaCurrent(conn)).rejects.toThrow(/unknown=\[0002\]/);
    await pg.close();
  });

  it('rejects a non-sequential registry', async () => {
    const { pg, conn } = await freshDb();
    const bad: MigrationStep[] = [sqlStep('0007', 'x', 'SELECT 1')];
    await expect(runMigrations(conn, { deployment: 'staging', migrations: bad })).rejects.toThrow(/strictly sequential/);
    await pg.close();
  });

  it('role separation: pooled endpoints are refused; direct descriptors carry no credentials', () => {
    expect(() => assertDirectDatabaseUrl('postgresql://u:SECRET@ep-cool-pooler.eu-central-1.aws.neon.tech/contake?sslmode=require')).toThrow(/POOLED/);
    const d = assertDirectDatabaseUrl('postgresql://u:SECRET@ep-cool.eu-central-1.aws.neon.tech/contake?sslmode=require');
    expect(d.host).toBe('ep-cool.eu-central-1.aws.neon.tech');
    expect(d.database).toBe('contake');
    expect(JSON.stringify(d)).not.toContain('SECRET');
    expect(() => assertDirectDatabaseUrl('http://example.com/x')).toThrow(/protocol/);
    expect(() => assertDirectDatabaseUrl('not a url')).toThrow(/valid URL/);
  });
});
