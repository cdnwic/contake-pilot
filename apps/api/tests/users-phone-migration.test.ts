/** users-phone preflight + FORWARD-ONLY migration (QA 21:06 + QA/security
 *  review 2026-09-18; narrowed SA v8 scope per TL 2026-09-18): preflight
 *  models EVERY distinct normalized identity (column + JSON); collisions OR
 *  column/JSON inconsistencies BLOCK normalization and index creation (never
 *  silently choose); normalization is ONE real transaction with proven
 *  rollback on injected later-row failure; the unique index is created only
 *  by the reviewed forward migration, never at bootstrap
 *  (preservation-first). The bespoke backup/restore CLI and its suites are
 *  OUT of this gate (architecture separation 2026-09-18): preserved in the
 *  remote lineage, closed-by-removal, owned by the separate infra track.
 *  PG lanes only. Synthetic phones. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTestRepo, REPO_IMPL } from './helpers/repo.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import type { Connectable } from '../src/repo/postgres.js';
import {
  createUsersPhoneIndex, MIGRATION_LOCK_KEY, migrateUsersPhone,
  normalizeUsersPhones, preflightUsersPhone, runUsersPhoneMigration, usersPhoneIndexExists,
} from '../src/services/phone-migration.js';

const pgOnly = REPO_IMPL === 'memory' ? describe.skip : describe;

let repo: GraphRepository | undefined;
let conn: Connectable;
let closeConn: (() => Promise<void>) | undefined;

beforeEach(async () => {
  if (REPO_IMPL === 'memory') return;
  if (REPO_IMPL === 'realpg') {
    repo = await makeTestRepo(); // hermetic schema reset + production DDL
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
    conn = pool as unknown as Connectable;
    closeConn = () => pool.end();
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const { pgliteConnectable, PostgresGraphRepository } = await import('../src/repo/postgres.js');
    const raw = new PGlite();
    conn = pgliteConnectable(raw);
    await PostgresGraphRepository.create(conn); // production DDL (NO phone index since v2)
    closeConn = () => raw.close();
  }
  // Simulate a PRE-INDEX legacy deployment in BOTH lanes.
  await conn.query(`DROP INDEX IF EXISTS users_phone_unique`);
});
afterEach(async () => { if (closeConn) await closeConn(); });

/** Insert a LEGACY (un-normalized) user row straight through SQL, bypassing
 *  the adapter's trim-at-the-boundary normalization. */
const insertLegacy = async (c: Connectable, userId: string, orgId: string, columnPhone: string | null, jsonPhone: string | null, extra: Record<string, unknown> = {}) => {
  const data = { userId, orgId, name: userId, role: 'admin', scopes: [], active: true, ...(jsonPhone !== null ? { phone: jsonPhone } : {}), ...extra };
  await c.query(`INSERT INTO users(user_id, org_id, email, phone, data) VALUES($1,$2,NULL,$3,$4)`,
    [userId, orgId, columnPhone, JSON.stringify(data)]);
};

pgOnly('bootstrap', () => {
  it('production DDL does NOT create users_phone_unique (preservation-first); the migration tool owns it', async () => {
    expect(await usersPhoneIndexExists(conn)).toBe(false);
  });
});

pgOnly('preflight identity modeling', () => {
  it('models ALL distinct normalized identities across column+JSON; a dual-identity row joins BOTH groups; usersWithPhone counts either representation', async () => {
    const baseline = await preflightUsersPhone(conn); // seeded demo rows vary by lane
    await insertLegacy(conn, 'u-dual', 'org-1', '+15550100011', ' +15550100012 ', {}); // two identities
    await insertLegacy(conn, 'u-col', 'org-1', ' +15550100011 ', null, {});             // column only
    await insertLegacy(conn, 'u-json', 'org-2', null, '+15550100013', {});              // JSON only
    const report = await preflightUsersPhone(conn);
    expect(report.usersWithPhone - baseline.usersWithPhone).toBe(3);
    expect(report.identities - baseline.identities).toBe(3); // +11, +12, +13
    const g11 = report.collisionGroups.find(g => g.normalizedPhone === '+15550100011');
    expect(g11?.members.map(m => m.userId).sort()).toEqual(['u-col', 'u-dual']); // dual-identity row collides via its column identity
    expect(report.operatorDecisionRequired).toBe(true);
    // inconsistency: column +11 vs json +12 on u-dual
    expect(report.inconsistentRows.map(m => m.userId)).toEqual(['u-dual']);
    expect(report.blocking).toBe(true);
    expect(report.blockingReasons.length).toBe(2);
  });

  it('preflight is READ-ONLY: reports collisions with ids/orgs/hashes/provenance, picks no winner, deletes nothing', async () => {
    await insertLegacy(conn, 'u-a', 'org-1', ' +15550100021 ', '+15550100021', { createdAt: '2026-01-01T00:00:00.000Z' });
    await insertLegacy(conn, 'u-b', 'org-2', '+15550100021', ' +15550100021 ', { createdAt: '2026-02-01T00:00:00.000Z', isSuperAdmin: true });
    const report = await preflightUsersPhone(conn);
    expect(report.collisionGroups.length).toBe(1);
    const g = report.collisionGroups[0]!;
    expect(g.members.map(m => m.userId).sort()).toEqual(['u-a', 'u-b']);
    expect(g.members.map(m => m.orgId).sort()).toEqual(['org-1', 'org-2']);
    expect(g.members.every(m => /^[0-9a-f]{64}$/.test(m.dataHash))).toBe(true);
    expect(g.members.find(m => m.userId === 'u-a')!.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(g.members.find(m => m.userId === 'u-b')!.isSuperAdmin).toBe(true);
    expect(report.inconsistentRows.length).toBe(0); // same after trim: consistent
    const check = await conn.query(`SELECT phone FROM users WHERE user_id='u-a'`);
    expect(check.rows[0]!['phone']).toBe(' +15550100021 '); // untouched
  });
});

pgOnly('blocking behavior', () => {
  it('inconsistency ALONE blocks normalization AND index creation; nothing is written; operator decision required', async () => {
    await insertLegacy(conn, 'u-inc', 'org-1', '+15550100031', '+15550100032');
    const n = await normalizeUsersPhones(conn);
    expect('aborted' in n && n.aborted).toBe(true);
    const ix = await createUsersPhoneIndex(conn);
    expect(ix.created).toBe(false);
    if (!ix.created) expect(ix.reason).toBe('blocked');
    expect(await usersPhoneIndexExists(conn)).toBe(false);
    const row = (await conn.query(`SELECT phone, data->>'phone' AS jp FROM users WHERE user_id='u-inc'`)).rows[0]!;
    expect(row['phone']).toBe('+15550100031'); // exactly as inserted - no silent column choice
    expect(row['jp']).toBe('+15550100032');
  });

  it('collision blocks index creation loudly (no index, no mutation, full report)', async () => {
    await insertLegacy(conn, 'u-x', 'org-1', '+15550100044', '+15550100044');
    await insertLegacy(conn, 'u-y', 'org-2', ' +15550100044', '+15550100044');
    const blocked = await createUsersPhoneIndex(conn);
    expect(blocked.created).toBe(false);
    if (!blocked.created) expect(blocked.preflight.collisionGroups[0]!.members.length).toBe(2);
    expect(await usersPhoneIndexExists(conn)).toBe(false);
    // operator resolution: re-key one row, then creation succeeds and is idempotent
    await conn.query(`UPDATE users SET phone='+15550100055', data=jsonb_set(data,'{phone}','"+15550100055"') WHERE user_id='u-y'`);
    expect((await createUsersPhoneIndex(conn)).created).toBe(true);
    expect((await createUsersPhoneIndex(conn)).created).toBe(true); // idempotent
    expect(await usersPhoneIndexExists(conn)).toBe(true);
  });
});

pgOnly('transactional normalization', () => {
  it('trims column AND embedded JSON in ONE transaction; idempotent re-run', async () => {
    await insertLegacy(conn, 'u-pad', 'org-1', '  +15550100033  ', '  +15550100033  ');
    const first = await normalizeUsersPhones(conn);
    expect('normalized' in first && first.normalized).toBe(1);
    const row = (await conn.query(`SELECT phone, data->>'phone' AS jp FROM users WHERE user_id='u-pad'`)).rows[0]!;
    expect(row['phone']).toBe('+15550100033');
    expect(row['jp']).toBe('+15550100033');
    const second = await normalizeUsersPhones(conn);
    expect('normalized' in second && second.normalized).toBe(0);
  });

  it('ROLLBACK regression: an injected failure on a LATER row rolls back the ENTIRE normalization', async () => {
    await insertLegacy(conn, 'u-n1', 'org-1', ' +15550100061 ', '+15550100061');
    await insertLegacy(conn, 'u-n2', 'org-1', ' +15550100062 ', '+15550100062');
    // fault-injecting wrapper: the SECOND UPDATE inside the transaction fails
    let updates = 0;
    const failing: Connectable = {
      query: (text: string, params?: unknown[]) => {
        if (/^\s*UPDATE\s+users/i.test(text)) {
          updates += 1;
          if (updates === 2) return Promise.reject(new Error('injected later-row failure'));
        }
        return conn.query(text, params);
      },
      connect: () => conn.connect().then(client => ({
        query: (text: string, params?: unknown[]) => {
          if (/^\s*UPDATE\s+users/i.test(text)) {
            updates += 1;
            if (updates === 2) return Promise.reject(new Error('injected later-row failure'));
          }
          return client.query(text, params);
        },
        release: () => client.release(),
      })),
    };
    await expect(normalizeUsersPhones(failing)).rejects.toThrow('injected later-row failure');
    // ENTIRE transaction rolled back: the first row keeps its padded phone
    const row = (await conn.query(`SELECT phone FROM users WHERE user_id='u-n1'`)).rows[0]!;
    expect(row['phone']).toBe(' +15550100061 ');
  });
});


pgOnly('storage-level unique index + restart durability (forward migration)', () => {
  it('storage-level index REJECTS a duplicate normalized phone once created', async () => {
    await insertLegacy(conn, 'u-one', 'org-1', '+15550100066', '+15550100066');
    expect((await createUsersPhoneIndex(conn)).created).toBe(true);
    await expect(insertLegacy(conn, 'u-two', 'org-2', '  +15550100066', '+15550100066'))
      .rejects.toThrow(/users_phone_unique|duplicate key/);
  });

  it('restart durability: a NEW connection over the same database sees normalized data + index (no schema drop)', async () => {
    if (REPO_IMPL !== 'realpg') return;
    await insertLegacy(conn, 'u-re', 'org-1', ' +15550100099 ', '+15550100099');
    await normalizeUsersPhones(conn);
    expect((await createUsersPhoneIndex(conn)).created).toBe(true);
    const { Pool } = await import('pg');
    const pool2 = new Pool({ connectionString: process.env['DATABASE_URL'] });
    try {
      const c2 = pool2 as unknown as Connectable;
      expect((await c2.query(`SELECT phone FROM users WHERE user_id='u-re'`)).rows[0]!['phone']).toBe('+15550100099');
      expect(await usersPhoneIndexExists(c2)).toBe(true);
    } finally { await pool2.end(); }
  });
});

pgOnly('locked maintenance transaction (security 2026-09-18)', () => {
  it('clean path: preflight under lock -> normalize -> rerun under lock -> index -> final preflight; idempotent re-run', async () => {
    await insertLegacy(conn, 'u-m1', 'org-1', ' +15550101051 ', ' +15550101051 ');
    const r = await migrateUsersPhone(conn);
    expect(r.migrated).toBe(true);
    expect(await usersPhoneIndexExists(conn)).toBe(true);
    expect((await conn.query(`SELECT phone FROM users WHERE user_id='u-m1'`)).rows[0]!['phone']).toBe('+15550101051');
    const again = await migrateUsersPhone(conn);
    expect(again.migrated).toBe(true);
    if (again.migrated) expect(again.normalized).toBe(0);
  });

  it('blocking path: collision -> migrated:false, NOTHING written, no index; inconsistency likewise', async () => {
    await insertLegacy(conn, 'u-b1', 'org-1', '+15550101061', '+15550101061');
    await insertLegacy(conn, 'u-b2', 'org-2', ' +15550101061', '+15550101061');
    const r = await migrateUsersPhone(conn);
    expect(r.migrated).toBe(false);
    expect(await usersPhoneIndexExists(conn)).toBe(false);
    expect((await conn.query(`SELECT phone FROM users WHERE user_id='u-b2'`)).rows[0]!['phone']).toBe(' +15550101061');
    await conn.query(`DELETE FROM users WHERE user_id IN ('u-b1','u-b2')`);
    await insertLegacy(conn, 'u-b3', 'org-1', '+15550101071', '+15550101072'); // inconsistent
    const r2 = await migrateUsersPhone(conn);
    expect(r2.migrated).toBe(false);
    expect((await conn.query(`SELECT phone FROM users WHERE user_id='u-b3'`)).rows[0]!['phone']).toBe('+15550101071');
  });
});


pgOnly('canonical index definition compare (QA/security 2026-09-18 v4)', () => {
  it('canonical compare, not byte compare: a legitimately pg-normalized live definition verifies against the canonical statement', async () => {
    await insertLegacy(conn, 'u-n1', 'org-1', ' +15550101041 ', '+15550101041');
    const r = await migrateUsersPhone(conn);
    expect(r.migrated).toBe(true);
    if (r.migrated) {
      expect(r.indexPresent).toBe(true);
      expect(r.finalPreflight.blocking).toBe(false);
    }
  });
});


pgOnly('real write exclusion (security 2026-09-18 v4)', () => {
  it('the forward maintenance migration takes the ONE documented lock order: advisory FIRST, then LOCK TABLE users SHARE ROW EXCLUSIVE (recorded query stream)', async () => {
    const recorded: string[] = [];
    const rec: Connectable = {
      query: (text: string, params?: unknown[]) => { recorded.push(text); return conn.query(text, params as never); },
      connect: async () => {
        const client = await conn.connect();
        return { query: (text: string, params?: unknown[]) => { recorded.push(text); return client.query(text, params as never); }, release: () => client.release() };
      },
    } as unknown as Connectable;
    await migrateUsersPhone(rec);
    expect(recorded.some(q => q.includes(`pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`))).toBe(true);
    expect(recorded.some(q => q === 'LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE')).toBe(true);
    const adv = recorded.findIndex(q => q.includes(`pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`));
    const tbl = recorded.findIndex(q => q === 'LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    expect(adv).toBeGreaterThanOrEqual(0);
    expect(tbl).toBeGreaterThan(adv); // ONE documented order: advisory FIRST
  });

  const realPgOnly = REPO_IMPL === 'realpg' ? it : it.skip;
  realPgOnly('two-connection proof: a writer on another connection BLOCKS against the migration lock and fails clean under statement_timeout, then succeeds after commit', async () => {
    const { Pool } = await import('pg');
    const poolB = new Pool({ connectionString: process.env['DATABASE_URL'], max: 1 });
    const clientA = await (conn as unknown as InstanceType<typeof Pool>).connect();
    try {
      await conn.query(`DELETE FROM users WHERE user_id='u-w1'`);
      await clientA.query('BEGIN');
      await clientA.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
      await poolB.query(`SET lock_timeout = 1200`);
      await poolB.query(`SET statement_timeout = 2000`);
      await expect(poolB.query(`INSERT INTO users(user_id, org_id, email, phone, data) VALUES('u-w1','org-1',NULL,'+15550101051','{}')`))
        .rejects.toThrow(/lock timeout|statement timeout|canceling statement/i);
      await clientA.query('COMMIT');
      await poolB.query(`SET statement_timeout = 0`);
      await poolB.query(`INSERT INTO users(user_id, org_id, email, phone, data) VALUES('u-w1','org-1',NULL,'+15550101051','{}')`);
      expect((await conn.query(`SELECT count(*)::int AS n FROM users WHERE user_id='u-w1'`)).rows[0]!['n']).toBe(1);
    } finally {
      clientA.release();
      await poolB.end();
    }
  });
});

pgOnly('standard migration runner (QA FAIL 2026-09-18: the forward migration must be operationally reachable)', () => {
  it('clean run: exit 0, invokes the locked primitive, index independently verified, final preflight clean; idempotent rerun', async () => {
    await insertLegacy(conn, 'u-r1', 'org-1', '  +15550102011  ', '  +15550102011  ');
    const out = await runUsersPhoneMigration(conn);
    expect(out.exitCode).toBe(0);
    expect(out.report.kind).toBe('users-phone-migration-run');
    expect(/^\d{4}-\d{2}-\d{2}T/.test(out.report.ranAt)).toBe(true);
    expect(out.report.migrated).toBe(true);
    expect(out.report.normalized).toBe(1);
    expect(out.report.indexPresent).toBe(true); // post-commit independent probe
    expect(out.report.preflight?.blocking).toBe(false); // final preflight carried
    expect(out.report.error).toBeNull();
    expect((await conn.query(`SELECT phone FROM users WHERE user_id='u-r1'`)).rows[0]!['phone']).toBe('+15550102011');
    expect(await usersPhoneIndexExists(conn)).toBe(true);
    const again = await runUsersPhoneMigration(conn); // idempotent rerun
    expect(again.exitCode).toBe(0);
    expect(again.report.normalized).toBe(0);
  });

  it('blocked run (collision): exit 1, NOTHING written, no index, fail-loud FULL preflight evidence', async () => {
    await insertLegacy(conn, 'u-rc1', 'org-1', '+15550102021', '+15550102021');
    await insertLegacy(conn, 'u-rc2', 'org-2', ' +15550102021', '+15550102021');
    const out = await runUsersPhoneMigration(conn);
    expect(out.exitCode).toBe(1); // nonzero status
    expect(out.report.migrated).toBe(false);
    expect(out.report.error).toBeNull();
    const pre = out.report.preflight!;
    expect(pre.blocking).toBe(true);
    expect(pre.blockingReasons.join(' ')).toContain('collision');
    const g = pre.collisionGroups.find(x => x.normalizedPhone === '+15550102021');
    expect(g?.members.map(m => m.userId).sort()).toEqual(['u-rc1', 'u-rc2']); // fail-loud detail
    expect(g?.members.map(m => m.orgId).sort()).toEqual(['org-1', 'org-2']);
    expect(await usersPhoneIndexExists(conn)).toBe(false);
    expect((await conn.query(`SELECT phone FROM users WHERE user_id='u-rc2'`)).rows[0]!['phone']).toBe(' +15550102021'); // untouched
  });

  it('blocked run (inconsistency): exit 1 with inconsistentRows evidence, nothing written', async () => {
    await insertLegacy(conn, 'u-ri1', 'org-1', '+15550102031', '+15550102032');
    const out = await runUsersPhoneMigration(conn);
    expect(out.exitCode).toBe(1);
    expect(out.report.migrated).toBe(false);
    expect(out.report.preflight!.inconsistentRows.map(m => m.userId)).toEqual(['u-ri1']);
    expect(out.report.preflight!.blockingReasons.join(' ')).toContain('inconsistent');
    expect(await usersPhoneIndexExists(conn)).toBe(false);
    expect((await conn.query(`SELECT phone FROM users WHERE user_id='u-ri1'`)).rows[0]!['phone']).toBe('+15550102031');
  });

  it('failed run: an injected mid-transaction failure exits 1 with the error and a PROVEN full rollback', async () => {
    await insertLegacy(conn, 'u-rf1', 'org-1', ' +15550102041 ', '+15550102041');
    await insertLegacy(conn, 'u-rf2', 'org-1', ' +15550102042 ', '+15550102042');
    let updates = 0;
    const failing: Connectable = {
      query: (text: string, params?: unknown[]) => conn.query(text, params),
      connect: () => conn.connect().then(client => ({
        query: (text: string, params?: unknown[]) => {
          if (/^\s*UPDATE\s+users/i.test(text)) {
            updates += 1;
            if (updates === 2) return Promise.reject(new Error('injected runner failure'));
          }
          return client.query(text, params);
        },
        release: () => client.release(),
      })),
    };
    const out = await runUsersPhoneMigration(failing);
    expect(out.exitCode).toBe(1);
    expect(out.report.migrated).toBe(false);
    expect(out.report.error).toContain('injected runner failure');
    expect(out.report.preflight).toBeNull();
    // ENTIRE transaction rolled back: the first row keeps its padded phone, no index
    expect((await conn.query(`SELECT phone FROM users WHERE user_id='u-rf1'`)).rows[0]!['phone']).toBe(' +15550102041 ');
    expect(await usersPhoneIndexExists(conn)).toBe(false);
  });

  it('exact DB targeting: the runner touches ONLY the resolved database; an independent second database is untouched', async () => {
    let conn2: Connectable;
    let close2: () => Promise<void>;
    if (REPO_IMPL === 'realpg') {
      const { Pool } = await import('pg');
      await conn.query(`DROP DATABASE IF EXISTS users_phone_target_probe`);
      await conn.query(`CREATE DATABASE users_phone_target_probe`);
      const u = new URL(process.env['DATABASE_URL'] as string);
      u.pathname = '/users_phone_target_probe';
      const pool2 = new Pool({ connectionString: u.toString() });
      conn2 = pool2 as unknown as Connectable;
      const { PostgresGraphRepository } = await import('../src/repo/postgres.js');
      await PostgresGraphRepository.create(conn2);
      close2 = async () => {
        await pool2.end();
        await conn.query(`DROP DATABASE IF EXISTS users_phone_target_probe`);
      };
    } else {
      const { PGlite } = await import('@electric-sql/pglite');
      const { pgliteConnectable, PostgresGraphRepository } = await import('../src/repo/postgres.js');
      const raw2 = new PGlite();
      conn2 = pgliteConnectable(raw2);
      await PostgresGraphRepository.create(conn2);
      close2 = () => raw2.close();
    }
    try {
      await insertLegacy(conn, 'u-t1', 'org-1', ' +15550102051 ', '+15550102051');
      await insertLegacy(conn2, 'u-t2', 'org-1', ' +15550102052 ', '+15550102052');
      const out = await runUsersPhoneMigration(conn); // resolved DB = conn ONLY
      expect(out.exitCode).toBe(0);
      expect((await conn.query(`SELECT phone FROM users WHERE user_id='u-t1'`)).rows[0]!['phone']).toBe('+15550102051');
      expect(await usersPhoneIndexExists(conn)).toBe(true);
      // the OTHER database is untouched: padded row kept, no index
      expect((await conn2.query(`SELECT phone FROM users WHERE user_id='u-t2'`)).rows[0]!['phone']).toBe(' +15550102052 ');
      expect(await usersPhoneIndexExists(conn2)).toBe(false);
    } finally {
      await close2();
    }
  });
});
