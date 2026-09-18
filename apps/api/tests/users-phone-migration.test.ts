/** users-phone preflight + reversible migration v2 (QA 21:06 + QA/security
 *  review 2026-09-18): preflight models EVERY distinct normalized identity
 *  (column + JSON); collisions OR column/JSON inconsistencies BLOCK
 *  normalization and index creation (never silently choose); usersWithPhone
 *  counts either representation; normalization is ONE real transaction with
 *  proven rollback on injected later-row failure; backup captures and
 *  restore VERIFIABLY reverses row + index state; bootstrap no longer
 *  creates the index (preservation-first). PG lanes only. Synthetic phones. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeTestRepo, REPO_IMPL } from './helpers/repo.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import type { Connectable } from '../src/repo/postgres.js';
import {
  backupUsers, createUsersPhoneIndex, normalizeUsersPhones, preflightUsersPhone, restoreUsers, usersPhoneIndexExists,
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

pgOnly('backup / restore reversal', () => {
  it('backup captures rows + index state; restore reverses rows AND index state, VERIFIED against the header', async () => {
    await insertLegacy(conn, 'u-bak', 'org-1', ' +15550100077 ', ' +15550100077 ');
    // variant A: backup WITH index present
    expect((await createUsersPhoneIndex(conn)).created).toBe(true);
    const linesA: string[] = [];
    await backupUsers(conn, l => linesA.push(l));
    expect(JSON.parse(linesA[0]!).usersPhoneUniqueIndex.existed).toBe(true);
    await conn.query(`DROP INDEX users_phone_unique`);
    await conn.query(`UPDATE users SET phone=' +19999999999 ' WHERE user_id='u-bak'`);
    const rA = await restoreUsers(conn, linesA);
    expect(rA.verified).toBe(true);
    expect(rA.indexRestored).toBe(true);
    expect(await usersPhoneIndexExists(conn)).toBe(true);
    expect((await conn.query(`SELECT phone FROM users WHERE user_id='u-bak'`)).rows[0]!['phone']).toBe(' +15550100077 ');
    // variant B: backup WITHOUT index -> restore DROPS it (verified)
    await conn.query(`DROP INDEX users_phone_unique`);
    const linesB: string[] = [];
    await backupUsers(conn, l => linesB.push(l));
    expect(JSON.parse(linesB[0]!).usersPhoneUniqueIndex.existed).toBe(false);
    await conn.query(`CREATE UNIQUE INDEX users_phone_unique ON users(btrim(phone)) WHERE phone IS NOT NULL`);
    const rB = await restoreUsers(conn, linesB);
    expect(rB.verified).toBe(true);
    expect(rB.indexRestored).toBe(false);
    expect(await usersPhoneIndexExists(conn)).toBe(false);
  });

  it('restore round-trips through a real artifact file (reversible by construction)', async () => {
    await insertLegacy(conn, 'u-file', 'org-1', ' +15550100088 ', '+15550100088');
    const file = join(mkdtempSync(join(tmpdir(), 'phone-bak-')), 'users-backup.jsonl');
    const lines: string[] = [];
    const n = await backupUsers(conn, l => lines.push(l));
    writeFileSync(file, lines.join('\n'));
    expect(n).toBeGreaterThan(0);
    await normalizeUsersPhones(conn);
    expect((await conn.query(`SELECT phone FROM users WHERE user_id='u-file'`)).rows[0]!['phone']).toBe('+15550100088');
    const r = await restoreUsers(conn, readFileSync(file, 'utf8').split('\n').filter(Boolean));
    expect(r.restoredRows).toBe(n);
    expect((await conn.query(`SELECT phone FROM users WHERE user_id='u-file'`)).rows[0]!['phone']).toBe(' +15550100088 ');
  });

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
void repo;
