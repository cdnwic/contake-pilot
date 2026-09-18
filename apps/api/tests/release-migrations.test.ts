/** Release-migration runner gates (2026-09-18, hardened after QA FAIL of
 *  f9854cd6): hermetic PGlite proofs that
 *  - a fresh database is initialized explicitly and becomes boot-able;
 *  - re-runs are idempotent; history is forward-only (unknown/gap refuses);
 *  - EVERY step is one transaction: body AND version record commit or roll
 *    back together (partial DDL can never persist versionless);
 *  - applied-step integrity is enforced: stored version+name+digest must
 *    match the registry artifact digest, in the runner AND the boot gate;
 *  - cross-deployment runs are refused by the stamped identity;
 *  - function steps on the SA plug-in contract are applied and recorded;
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
  MIGRATIONS, EXPECTED_SCHEMA_VERSIONS, assertDirectDatabaseUrl, assertSchemaCurrent,
  runMigrations, stepDigest, type MigrationStep,
} from '../src/migrations/runner.js';

async function freshDb() {
  const pg = new PGlite();
  const conn = pgliteConnectable(pg);
  return { pg, conn };
}

const step = (version: string, name: string, sql: string): MigrationStep => ({
  version, name, description: `test step ${name}`, artifact: sql,
  up: async tx => { for (const st of sql.split(';').map(s => s.trim()).filter(Boolean)) await tx.query(st); },
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
    expect(r1.identity.deploymentLabel).toBe('staging');
    expect(r1.identity.instanceId).toMatch(/^[0-9a-f]{16}$/);
    for (const t of ['users', 'otp_codes', 'otp_requests', 'otp_verify_state', 'auth_audit', 'schema_migrations', 'contake_db_identity']) {
      const q = await conn.query(`SELECT to_regclass('${t}') AS r`);
      expect(q.rows[0]?.['r'], `table ${t}`).toBe(t);
    }
    await expect(assertSchemaCurrent(conn)).resolves.toBeUndefined();
    const r2 = await runMigrations(conn, { deployment: 'staging' });
    expect(r2.appliedNow).toEqual([]);
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

  it('QA stop-ship #1: a step that throws mid-DDL leaves NO partial DDL and NO version row', async () => {
    const { pg, conn } = await freshDb();
    const failing: MigrationStep = {
      version: '0001', name: 'partial-ddl', description: 'creates a table then throws',
      artifact: 'CREATE TABLE partial_leak(id int); THROW',
      up: async tx => {
        await tx.query('CREATE TABLE partial_leak(id int)');
        throw new Error('boom mid-DDL');
      },
    };
    await expect(runMigrations(conn, { deployment: 'staging', migrations: [failing] })).rejects.toThrow(/boom mid-DDL/);
    const t = await conn.query(`SELECT to_regclass('partial_leak') AS r`);
    expect(t.rows[0]?.['r']).toBeNull(); // DDL rolled back with the step tx
    const v = await conn.query(`SELECT count(*)::int AS n FROM schema_migrations`);
    expect(Number(v.rows[0]?.['n'])).toBe(0); // no versionless persistence, no orphaned version
    // A later good run on the same database proceeds cleanly.
    await runMigrations(conn, { deployment: 'staging' });
    await expect(assertSchemaCurrent(conn)).resolves.toBeUndefined();
    await pg.close();
  });

  it('QA stop-ship #1: a version-record collision rolls back the step body too', async () => {
    const { pg, conn } = await freshDb();
    const colliding: MigrationStep = {
      version: '0001', name: 'self-colliding', description: 'inserts its own version row inside up()',
      artifact: 'CREATE TABLE coll_leak(id int)',
      up: async tx => {
        await tx.query('CREATE TABLE coll_leak(id int)');
        await tx.query(`INSERT INTO schema_migrations(version, name, sha256, applied_by) VALUES('0001', 'squatter', 'x', 'test')`);
      },
    };
    await expect(runMigrations(conn, { deployment: 'staging', migrations: [colliding] })).rejects.toThrow(/collided inside its own transaction/);
    const t = await conn.query(`SELECT to_regclass('coll_leak') AS r`);
    expect(t.rows[0]?.['r']).toBeNull(); // step DDL rolled back
    const v = await conn.query(`SELECT version FROM schema_migrations`);
    expect(v.rows).toHaveLength(0); // the squatter row rolled back with it
    await pg.close();
  });

  it('QA stop-ship #2: edited applied history (name or digest) fails runner AND boot gate', async () => {
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

  it('QA stop-ship #2: the digest covers the actual artifact, not metadata', () => {
    const a = step('0001', 'x', 'CREATE TABLE a(id int)');
    const b = step('0001', 'x', 'CREATE TABLE b(id int)');
    const c = { ...a, description: 'edited description only' };
    expect(stepDigest(a)).not.toBe(stepDigest(b)); // artifact change -> digest change
    expect(stepDigest(a)).toBe(stepDigest(c)); // editable metadata is not the artifact
  });

  it('SA plug-in contract: a function step (migrateUsersPhone shape) is applied and recorded', async () => {
    const { pg, conn } = await freshDb();
    let called = 0;
    const saStep: MigrationStep = {
      version: '0002',
      name: 'users-phone-unique-index',
      description: 'test double matching the tx-scoped MigrationStep contract',
      artifact: 'CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(btrim(phone)) WHERE phone IS NOT NULL',
      up: async tx => {
        called += 1;
        // Legal inside the runner's transaction: advisory xact lock + index.
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
    const bad: MigrationStep[] = [step('0007', 'x', 'SELECT 1')];
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
