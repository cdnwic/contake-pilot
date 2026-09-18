/** Release-migration runner gates (2026-09-18): hermetic PGlite proofs that
 *  - a fresh database is initialized explicitly and becomes boot-able;
 *  - re-runs are idempotent; history is forward-only (unknown/gap refuses);
 *  - cross-deployment runs are refused by the stamped identity;
 *  - the boot gate fails closed on missing/unknown/mismatched versions;
 *  - function steps on the SA plug-in contract (migrateUsersPhone shape) are
 *    applied and recorded through the same runner;
 *  - pooled endpoints are refused for schema work. */
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgliteConnectable } from '../src/repo/postgres.js';
import {
  MIGRATIONS, EXPECTED_SCHEMA_VERSIONS, assertDirectDatabaseUrl, assertSchemaCurrent, runMigrations,
  type MigrationStep,
} from '../src/migrations/runner.js';

async function freshDb() {
  const pg = new PGlite();
  const conn = pgliteConnectable(pg);
  return { pg, conn };
}

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
    // Simulate the legacy boot: schema exists, no migration tables.
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

  it('SA plug-in contract: a function step (migrateUsersPhone shape) is applied and recorded', async () => {
    const { pg, conn } = await freshDb();
    let called = 0;
    const saStep: MigrationStep = {
      version: '0002',
      name: 'users-phone-unique-index',
      description: 'test double matching the migrateUsersPhone (conn) => Promise contract',
      up: async c => {
        called += 1;
        await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(btrim(phone)) WHERE phone IS NOT NULL`);
      },
    };
    const r = await runMigrations(conn, { deployment: 'staging', migrations: [...MIGRATIONS, saStep] });
    expect(r.appliedNow).toEqual(['0001', '0002']);
    expect(called).toBe(1);
    await expect(assertSchemaCurrent(conn, ['0001', '0002'])).resolves.toBeUndefined();
    // The default expectation (main build without the SA step) must fail closed
    // against a database that carries the extra version.
    await expect(assertSchemaCurrent(conn)).rejects.toThrow(/unknown=\[0002\]/);
    await pg.close();
  });

  it('rejects a non-sequential registry', async () => {
    const { pg, conn } = await freshDb();
    const bad: MigrationStep[] = [{ version: '0007', name: 'x', description: 'x', up: async () => {} }];
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
