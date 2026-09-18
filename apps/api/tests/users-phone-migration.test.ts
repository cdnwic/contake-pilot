/** users-phone preflight + reversible migration (QA 21:06 stop-ship part 2):
 *  read-only duplicate preflight grouping btrim(phone) with a preservation
 *  report (ids/orgs/hashes/provenance, no winner, no deletion); reversible
 *  backup/restore; normalization of existing phone columns + JSON; index
 *  creation on the resolved DB only, aborting LOUDLY on collisions;
 *  idempotent restart behavior. PG lanes only (postgres [PGlite] / realpg).
 *  Synthetic phone numbers only. */
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

/** Raw connectable behind the test repo: PGlite lane keeps its file-scoped
 *  instance; realpg uses its own pool over DATABASE_URL (schema already
 *  reset by makeTestRepo). */
let repo: GraphRepository;
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
    // PGlite: dedicated fresh instance per test (single-connection lane).
    const { PGlite } = await import('@electric-sql/pglite');
    const { pgliteConnectable, PostgresGraphRepository } = await import('../src/repo/postgres.js');
    const raw = new PGlite();
    conn = pgliteConnectable(raw);
    await PostgresGraphRepository.create(conn); // production DDL
    closeConn = () => raw.close();
  }
  // Simulate a PRE-INDEX legacy deployment: the migration tooling owns index
  // creation, so every test starts without it in BOTH lanes.
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

pgOnly('users-phone preflight + migration', () => {
  it('preflight is READ-ONLY: groups by btrim(phone), reports collisions with ids/orgs/hashes/provenance, picks no winner, deletes nothing', async () => {
    await insertLegacy(conn, 'u-a', 'org-1', ' +15550100011 ', '+15550100011', { createdAt: '2026-01-01T00:00:00.000Z' });
    await insertLegacy(conn, 'u-b', 'org-2', '+15550100011', ' +15550100011 ', { createdAt: '2026-02-01T00:00:00.000Z', isSuperAdmin: true });
    await insertLegacy(conn, 'u-c', 'org-1', '+15550100022', '+15550100022');
    const report = await preflightUsersPhone(conn);
    expect(report.collisionGroups.length).toBe(1);
    const g = report.collisionGroups[0]!;
    expect(g.normalizedPhone).toBe('+15550100011');
    expect(g.members.map(m => m.userId).sort()).toEqual(['u-a', 'u-b']);
    expect(g.members.map(m => m.orgId).sort()).toEqual(['org-1', 'org-2']);
    expect(g.members.every(m => /^[0-9a-f]{64}$/.test(m.dataHash))).toBe(true);
    expect(g.members.find(m => m.userId === 'u-a')!.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(g.members.find(m => m.userId === 'u-b')!.isSuperAdmin).toBe(true);
    expect(report.operatorDecisionRequired).toBe(true);
    // read-only proof: padded values still exactly as inserted
    const check = await conn.query(`SELECT phone FROM users WHERE user_id='u-a'`);
    expect(check.rows[0]!['phone']).toBe(' +15550100011 ');
    const all = await conn.query(`SELECT count(*)::int AS n FROM users WHERE user_id IN ('u-a','u-b','u-c')`);
    expect(all.rows[0]!['n']).toBe(3); // no deletion
  });

  it('normalize trims column AND embedded JSON in one pass, idempotent on restart/re-run', async () => {
    await insertLegacy(conn, 'u-pad', 'org-1', '  +15550100033  ', '  +15550100033  ');
    const first = await normalizeUsersPhones(conn);
    expect(first.userIds).toEqual(['u-pad']);
    const row = (await conn.query(`SELECT phone, data->>'phone' AS jp FROM users WHERE user_id='u-pad'`)).rows[0]!;
    expect(row['phone']).toBe('+15550100033');
    expect(row['jp']).toBe('+15550100033');
    const second = await normalizeUsersPhones(conn); // idempotent re-run
    expect(second.normalized).toBe(0);
  });

  it('index creation ABORTS LOUDLY on collisions (no index, no mutation); succeeds once clean; idempotent re-create', async () => {
    await insertLegacy(conn, 'u-x', 'org-1', '+15550100044', '+15550100044');
    await insertLegacy(conn, 'u-y', 'org-2', ' +15550100044', '+15550100044');
    const blocked = await createUsersPhoneIndex(conn);
    expect(blocked.created).toBe(false);
    if (!blocked.created) {
      expect(blocked.reason).toBe('collisions');
      expect(blocked.preflight.collisionGroups[0]!.members.length).toBe(2);
    }
    expect(await usersPhoneIndexExists(conn)).toBe(false);
    // resolve the collision the OPERATOR way: re-key one row's phone, then retry
    await conn.query(`UPDATE users SET phone='+15550100055', data=jsonb_set(data,'{phone}','"+15550100055"') WHERE user_id='u-y'`);
    const ok = await createUsersPhoneIndex(conn);
    expect(ok.created).toBe(true);
    expect(await usersPhoneIndexExists(conn)).toBe(true);
    const again = await createUsersPhoneIndex(conn); // idempotent restart
    expect(again.created).toBe(true);
  });

  it('the storage-level index REJECTS a duplicate normalized phone (concurrent-enrollment backstop)', async () => {
    await insertLegacy(conn, 'u-one', 'org-1', '+15550100066', '+15550100066');
    expect((await createUsersPhoneIndex(conn)).created).toBe(true);
    await expect(insertLegacy(conn, 'u-two', 'org-2', '  +15550100066', '+15550100066'))
      .rejects.toThrow(/users_phone_unique|duplicate key/);
  });

  it('backup -> mutate -> restore REVERSES the migration (reversible by construction)', async () => {
    await insertLegacy(conn, 'u-bak', 'org-1', ' +15550100077 ', ' +15550100077 ');
    const file = join(mkdtempSync(join(tmpdir(), 'phone-bak-')), 'users-backup.jsonl');
    const lines: string[] = [];
    const n = await backupUsers(conn, l => lines.push(l));
    writeFileSync(file, lines.join('\n'));
    expect(n).toBeGreaterThan(0);
    await normalizeUsersPhones(conn);
    expect((await conn.query(`SELECT phone FROM users WHERE user_id='u-bak'`)).rows[0]!['phone']).toBe('+15550100077');
    // restore reverses
    const restored = await restoreUsers(conn, readFileSync(file, 'utf8').split('\n').filter(Boolean));
    expect(restored).toBe(n);
    expect((await conn.query(`SELECT phone FROM users WHERE user_id='u-bak'`)).rows[0]!['phone']).toBe(' +15550100077 ');
  });

  it('restart durability: a NEW connection over the same database sees normalized data + index (no schema drop)', async () => {
    if (REPO_IMPL !== 'realpg') return; // PGlite per-test instance: restart = new connection below
    await insertLegacy(conn, 'u-re', 'org-1', ' +15550100088 ', '+15550100088');
    await normalizeUsersPhones(conn);
    expect((await createUsersPhoneIndex(conn)).created).toBe(true);
    const { Pool } = await import('pg');
    const pool2 = new Pool({ connectionString: process.env['DATABASE_URL'] });
    try {
      const c2 = pool2 as unknown as Connectable;
      expect((await c2.query(`SELECT phone FROM users WHERE user_id='u-re'`)).rows[0]!['phone']).toBe('+15550100088');
      expect(await usersPhoneIndexExists(c2)).toBe(true);
    } finally { await pool2.end(); }
  });
});
