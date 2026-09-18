/** Staging-only synthetic seed gates (2026-09-18): hermetic PGlite proofs that
 *  - the explicit marker, staging identity stamp, and empty-DB freshness are
 *    all fail-closed gates;
 *  - generated data is synthetic (CSPRNG, .invalid emails, +972-555 phones),
 *    fixture-free and production-identifier-free, with explicit absence proofs;
 *  - re-runs are idempotent no-ops; dirty databases are refused;
 *  - credentials never appear in the non-secret inventory;
 *  - env-supplied pre-vaulted credentials are used without being echoed;
 *  - the whole seed is one transaction (a failed proof rolls back everything). */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgliteConnectable, type Connectable } from '../src/repo/postgres.js';
import { computeUsersPhonePreflight, operatorAckFor, runMigrations } from '../src/migrations/runner.js';
import {
  assertNoForbidden, DATA_REGISTRY_DIGEST, deriveFixtureIdentifiers, deriveForbiddenIdentifiers, runStagingSeed,
} from '../src/migrations/staging-seed.js';
import { hashPasswordPure } from '../src/auth.js';
import { scryptSync, timingSafeEqual } from 'node:crypto';

/** Pre-vaulted test credentials (generated per-file, never hardcoded). */
const CREDS = {
  adminPassword: `test-admin-${Math.random().toString(36).slice(2)}-pw`,
  managerPassword: `test-manager-${Math.random().toString(36).slice(2)}-pw`,
};

const verifyPassword = (password: string, stored: string): boolean => {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  return timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(password, salt, 32));
};

/** File-scoped PGlite (gate-box memory discipline, same as tests/helpers):
 *  ONE instance per file, hard schema reset between tests. */
let filePg: PGlite | undefined;
let fileConn: Connectable | undefined;
afterAll(async () => {
  const pg = filePg;
  filePg = undefined;
  fileConn = undefined;
  if (pg) await pg.close();
});
async function stagingDb(deployment = 'staging') {
  if (!filePg) {
    filePg = new PGlite();
    fileConn = pgliteConnectable(filePg);
  }
  const conn = fileConn!;
  await conn.query('DROP SCHEMA public CASCADE');
  await conn.query('CREATE SCHEMA public');
  await runMigrations(conn, { deployment, operatorAck: operatorAckFor(await computeUsersPhonePreflight(conn, { deployment })) });
  return { pg: { close: async () => {} }, conn };
}

describe('fixture/production denylist derivation', () => {
  it('derives the public fixture identifiers from the seed modules themselves', () => {
    const ids = deriveFixtureIdentifiers();
    for (const expected of ['org-1', 'org-camp-demo', 'cd-ev1', 'u-admin', 'admin@camp.local', '+972500000001', '+972500100021']) {
      expect(ids, expected).toContain(expected);
    }
    expect(ids.length).toBeGreaterThan(100);
  });

  it('derives env-supplied production identifiers (never hardcoded)', () => {
    const ids = deriveForbiddenIdentifiers({
      CONTAKE_SUPER_ADMIN_PHONES: '+972111111111, +13470000000',
      CONTAKE_FORBIDDEN_IDENTIFIERS: 'prod-org-1',
    } as NodeJS.ProcessEnv);
    expect(ids.sort()).toEqual(['+13470000000', '+972111111111', 'prod-org-1']);
  });

  it('assertNoForbidden throws on any intersection', () => {
    expect(() => assertNoForbidden(['a', 'b'], ['x'])).not.toThrow();
    expect(() => assertNoForbidden(['a', 'b'], ['b'])).toThrow(/collide/);
  });
});

describe('staging synthetic seed', () => {
  it('refuses without the explicit marker', async () => {
    const { pg, conn } = await stagingDb();
    await expect(runStagingSeed(conn, { marker: undefined })).rejects.toThrow(/CONTAKE_STAGING_SEED=1/);
    await expect(runStagingSeed(conn, { marker: 'true' })).rejects.toThrow(/CONTAKE_STAGING_SEED=1/);
    await pg.close();
  });

  it('refuses on a non-staging-stamped database', async () => {
    const { pg, conn } = await stagingDb('production-pilot');
    await expect(runStagingSeed(conn, { marker: '1', credentials: CREDS })).rejects.toThrow(/stamped 'production-pilot'/);
    await pg.close();
  });

  it('requires pre-vaulted credentials - there is NO generation/emission path', async () => {
    const { pg, conn } = await stagingDb();
    // @ts-expect-error credentials are required
    await expect(runStagingSeed(conn, { marker: '1' })).rejects.toThrow();
    await expect(runStagingSeed(conn, { marker: '1', credentials: { adminPassword: 'short', managerPassword: CREDS.managerPassword } }))
      .rejects.toThrow(/pre-vaulted admin credential/);
    await pg.close();
  });

  it('refuses a dirty database', async () => {
    const { pg, conn } = await stagingDb();
    await conn.query(`INSERT INTO users(user_id, org_id, data) VALUES('someone', 'somewhere', '{}')`);
    await expect(runStagingSeed(conn, { marker: '1', credentials: CREDS })).rejects.toThrow(/not empty/);
    await pg.close();
  });

  it('seeds a synthetic, fixture-free dataset with absence proofs and a secret-free inventory', async () => {
    const { pg, conn } = await stagingDb();
    const r = await runStagingSeed(conn, { marker: '1', credentials: CREDS, forbiddenIdentifiers: ['+972111111111'] });
    expect(r.applied).toBe(true);
    const inv = r.inventory;
    expect(inv.seedInstanceId).toMatch(/^stg-seed-[0-9a-f]{12}$/);
    expect(inv.orgId).toMatch(/^stg-org-[0-9a-f]{12}$/);
    for (const e of inv.emails) expect(e).toMatch(/@staging\.contake\.invalid$/);
    for (const p of [...inv.phones, ...inv.channelAddresses]) expect(p).toMatch(/^\+972555\d{6}$/);
    expect(inv.counts).toEqual({ users: 5, channels: 3, events: 1, resources: 5, tasks: 4, dependencies: 2, whitelist: 3 });
    expect(inv.absenceProof.collisions).toEqual([]);
    expect(inv.absenceProof.fixtureIdentifiersChecked).toBeGreaterThan(100);
    expect(inv.absenceProof.forbiddenIdentifiersChecked).toBe(1);
    // Nothing generated collides with the derived fixture set.
    const fixtures = new Set(deriveFixtureIdentifiers());
    for (const g of [inv.orgId, ...inv.userIds, ...inv.emails, ...inv.phones, ...inv.channelAddresses, ...inv.eventIds, ...inv.resourceIds, ...inv.taskIds, ...inv.dependencyIds]) {
      expect(fixtures.has(g), g).toBe(false);
    }
    // Pre-vaulted credentials: never inside the inventory; the result has no
    // secrets field at all (no emission path exists).
    const invJson = JSON.stringify(inv);
    expect(invJson).not.toContain(CREDS.adminPassword);
    expect(invJson).not.toContain(CREDS.managerPassword);
    expect('secrets' in r).toBe(false);
    // The seeded admin actually authenticates with the pre-vaulted credential.
    const u = await conn.query(`SELECT data FROM users WHERE user_id = $1`, [inv.userIds[0]]);
    const rec = u.rows[0]?.['data'] as { passwordHash?: string };
    expect(verifyPassword(CREDS.adminPassword, rec.passwordHash ?? '')).toBe(true);
    // Canonical rerun-integrity manifest: every seeded row digested AND every
    // other business table verified zero-row (full coverage).
    expect(inv.rowDigests).toHaveLength(23);
    expect(inv.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(inv.emptyTables.length).toBeGreaterThan(0);
    expect(inv.emptyTables).not.toContain('users');
    for (const t of ['schema_migrations', 'contake_db_identity', 'staging_seed_state']) {
      expect(inv.emptyTables).not.toContain(t); // explicit bookkeeping, not business tables
    }
    for (const t of inv.emptyTables) {
      const c = await conn.query(`SELECT count(*)::int AS n FROM "${t}"`);
      expect(Number(c.rows[0]?.['n']), `business table ${t} must be zero-row`).toBe(0);
    }
    // Whitelist: synthetic worker phones approved for OTP login.
    const wl = await conn.query(`SELECT phone, status FROM whitelist_entries ORDER BY phone`);
    expect(wl.rows).toHaveLength(3);
    for (const row of wl.rows) expect(row['status']).toBe('approved');
    await pg.close();
  });

  it('re-run is an idempotent no-op bound to the same seed instance', async () => {
    const { pg, conn } = await stagingDb();
    const r1 = await runStagingSeed(conn, { marker: '1', credentials: CREDS });
    const r2 = await runStagingSeed(conn, { marker: '1', credentials: CREDS });
    expect(r2.applied).toBe(false);
    expect(r2.alreadyApplied).toBe(true);
    expect(r2.seedInstanceId).toBe(r1.seedInstanceId);
    const n = await conn.query(`SELECT count(*)::int AS n FROM users`);
    expect(Number(n.rows[0]?.['n'])).toBe(5);
    expect(r2.inventory.manifestSha256).toBe(r1.inventory.manifestSha256);
    await pg.close();
  });

  it('rerun integrity: any drift from the seeded manifest is rejected as dirty/foreign', async () => {
    const { pg, conn } = await stagingDb();
    await runStagingSeed(conn, { marker: '1', credentials: CREDS });
    // Drift one seeded row outside the seed transaction.
    await conn.query(`UPDATE tasks SET data = jsonb_set(data, '{name}', '"mutated"')`);
    await expect(runStagingSeed(conn, { marker: '1', credentials: CREDS })).rejects.toThrow(/RERUN INTEGRITY/);
    await pg.close();
  });

  it('R4 DATA anchor: digest pinned at first seed; drift refuses rerun even with identical rows; NULL adopts once', async () => {
    const { pg, conn } = await stagingDb();
    await runStagingSeed(conn, { marker: '1', credentials: CREDS });
    const pinned = await conn.query(`SELECT data_registry_digest AS d FROM staging_seed_state WHERE id = 1`);
    console.log(`OBSERVED[data anchor pinned]: ${String(pinned.rows[0]?.['d'])}`);
    expect(pinned.rows[0]?.['d']).toBe(DATA_REGISTRY_DIGEST);
    // drift the anchor WITHOUT touching any row: the manifest stays
    // byte-identical, yet the rerun must refuse on the anchor alone.
    await conn.query(`UPDATE staging_seed_state SET data_registry_digest = 'tampered' WHERE id = 1`);
    let driftRefusal = '';
    try { await runStagingSeed(conn, { marker: '1', credentials: CREDS }); } catch (e) { driftRefusal = String(e); }
    console.log(`OBSERVED[data anchor drift - identical rows]: ${driftRefusal.slice(0, 200)}`);
    expect(driftRefusal).toMatch(/DATA ANCHOR refusal/);
    expect(driftRefusal).toMatch(/tampered/);
    // restore heals; the rerun is an idempotent no-op again
    await conn.query(`UPDATE staging_seed_state SET data_registry_digest = $1 WHERE id = 1`, [DATA_REGISTRY_DIGEST]);
    const r = await runStagingSeed(conn, { marker: '1', credentials: CREDS });
    expect(r.alreadyApplied).toBe(true);
    // pre-R4 database (NULL anchor): one rerun adopts, then stable
    await conn.query(`UPDATE staging_seed_state SET data_registry_digest = NULL WHERE id = 1`);
    const r2 = await runStagingSeed(conn, { marker: '1', credentials: CREDS });
    expect(r2.alreadyApplied).toBe(true);
    const adopted = await conn.query(`SELECT data_registry_digest AS d FROM staging_seed_state WHERE id = 1`);
    console.log(`OBSERVED[data anchor adopted]: ${String(adopted.rows[0]?.['d'])}`);
    expect(adopted.rows[0]?.['d']).toBe(DATA_REGISTRY_DIGEST);
    await pg.close();
  });

  it('full coverage: rows in a NON-seeded business table are refused as foreign state on rerun', async () => {
    const { pg, conn } = await stagingDb();
    await runStagingSeed(conn, { marker: '1', credentials: CREDS });
    // Foreign write into a business table the seed does not own.
    await conn.query(`INSERT INTO auth_audit(phone, kind, data) VALUES('+972555000000', 'foreign', '{}')`);
    await expect(runStagingSeed(conn, { marker: '1', credentials: CREDS })).rejects.toThrow(/FOREIGN STATE refusal/);
    await pg.close();
  });

  it('seed precondition: tampered migration history/digests refuse the seed BEFORE any mutation', async () => {
    const { pg, conn } = await stagingDb();
    await conn.query(`UPDATE schema_migrations SET sha256 = 'tampered' WHERE version = '0001'`);
    await expect(runStagingSeed(conn, { marker: '1', credentials: CREDS })).rejects.toThrow(/INTEGRITY refusal/);
    const st = await conn.query(`SELECT to_regclass('staging_seed_state') AS r`);
    expect(st.rows[0]?.['r']).toBeNull(); // nothing was written
    const u = await conn.query(`SELECT count(*)::int AS n FROM users`);
    expect(Number(u.rows[0]?.['n'])).toBe(0);
    await pg.close();
  });

  it('whole-row manifest: drift in an authoritative NON-data column is caught', async () => {
    const { pg, conn } = await stagingDb();
    await runStagingSeed(conn, { marker: '1', credentials: CREDS });
    // Drift users.phone (a relational column OUTSIDE the jsonb data payload).
    await conn.query(`UPDATE users SET phone = '+972555999999' WHERE user_id = (SELECT user_id FROM users LIMIT 1)`);
    await expect(runStagingSeed(conn, { marker: '1', credentials: CREDS })).rejects.toThrow(/RERUN INTEGRITY/);
    await pg.close();
  });

  it('full coverage: first run refuses a database with rows in ANY business table, not just seeded ones', async () => {
    const { pg, conn } = await stagingDb();
    await conn.query(`INSERT INTO auth_audit(phone, kind, data) VALUES('+972555000001', 'foreign', '{}')`);
    await expect(runStagingSeed(conn, { marker: '1', credentials: CREDS })).rejects.toThrow(/not empty/);
    await pg.close();
  });

  it('pre-vaulted credentials are used and never echoed anywhere', async () => {
    const { pg, conn } = await stagingDb();
    const r = await runStagingSeed(conn, {
      marker: '1',
      credentials: { adminPassword: CREDS.adminPassword, managerPassword: CREDS.managerPassword },
    });
    expect('secrets' in r).toBe(false);
    expect(JSON.stringify(r.inventory)).not.toContain(CREDS.adminPassword);
    expect(JSON.stringify(r.inventory)).not.toContain(CREDS.managerPassword);
    const u = await conn.query(`SELECT data FROM users WHERE user_id = $1`, [r.inventory.userIds[0]]);
    const rec = u.rows[0]?.['data'] as { passwordHash?: string };
    expect(verifyPassword(CREDS.adminPassword, rec.passwordHash ?? '')).toBe(true);
    await pg.close();
  });

  it('rolls back EVERYTHING when the post-write absence proof fails inside the transaction', async () => {
    const { pg, conn } = await stagingDb();
    // 'יום סינתטי' is the synthetic event NAME: it is written into events.data
    // but is not part of the pre-write identifier set, so the pre-write check
    // passes and the POST-WRITE scan is what fails - after all seed rows were
    // inserted. The single transaction must roll back every one of them.
    await expect(runStagingSeed(conn, { marker: '1', credentials: CREDS, forbiddenIdentifiers: ['יום סינתטי'] }))
      .rejects.toThrow(/POST-WRITE absence proof FAILED/);
    for (const t of ['users', 'channels', 'events', 'tasks', 'resources', 'dependencies', 'whitelist_entries']) {
      const n = await conn.query(`SELECT count(*)::int AS n FROM ${t}`);
      expect(Number(n.rows[0]?.['n']), t).toBe(0);
    }
    // Even the state table's CREATE rolled back with the failed transaction.
    const st = await conn.query(`SELECT to_regclass('staging_seed_state') AS r`);
    expect(st.rows[0]?.['r']).toBeNull();
    await pg.close();
  });

  it('two independent staging databases get disjoint synthetic identities (CSPRNG)', async () => {
    const mk = async () => {
      const pg = new PGlite();
      const conn = pgliteConnectable(pg);
      await runMigrations(conn, { deployment: 'staging', operatorAck: operatorAckFor(await computeUsersPhonePreflight(conn, { deployment: 'staging' })) });
      return { pg, conn };
    };
    const a = await mk();
    const b = await mk();
    const r1 = await runStagingSeed(a.conn, { marker: '1', credentials: CREDS });
    const r2 = await runStagingSeed(b.conn, { marker: '1', credentials: CREDS });
    expect(r1.inventory.orgId).not.toBe(r2.inventory.orgId);
    expect(r1.inventory.phones).not.toEqual(r2.inventory.phones);
    expect(r1.inventory.manifestSha256).not.toBe(r2.inventory.manifestSha256);
    await a.pg.close();
    await b.pg.close();
  });
});
