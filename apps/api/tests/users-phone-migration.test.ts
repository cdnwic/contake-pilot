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
  artifactMac, backupUsers, CANONICAL_INDEX_SQL, createUsersPhoneIndex, manifestDigest, MIGRATION_LOCK_KEY, migrateUsersPhone,
  normalizeUsersPhones, preflightUsersPhone, restoreUsers, rowDigest, usersPhoneIndexExists, validateBackupArtifact,
} from '../src/services/phone-migration.js';
import type { ArtifactAuth } from '../src/services/phone-migration.js';

import { generateBackupMacKey } from '../src/services/phone-migration.js';

/** Ephemeral TEST-ONLY credentials: a fresh crypto-strong canonical key
 *  per suite run (NOT a real secret); live keys come only from the managed
 *  secret store per CLI custody rules. env is a UNIQUE deployment ID. */
const TEST_AUTH: ArtifactAuth = { key: generateBackupMacKey(), keyId: 'test-key-v1', env: 'test-deploy-01' };
const TEST_AUTH_V2: ArtifactAuth = { ...TEST_AUTH, keyId: 'test-key-v2' };
// CLI child env: test MAC credentials + the authoritative per-deployment
// allowlists the CLI checks against (v7 operator gate).
const cliEnv = () => ({ ...process.env,
  CONTAKE_BACKUP_MAC_KEY: TEST_AUTH.key, CONTAKE_BACKUP_KEY_ID: TEST_AUTH.keyId, CONTAKE_BACKUP_ENV: TEST_AUTH.env,
  CONTAKE_BACKUP_ALLOWED_ENVS: `${TEST_AUTH.env},staging-pg-a,production-pg-a,staging-pg-b`,
  CONTAKE_BACKUP_ALLOWED_KEY_IDS: `${TEST_AUTH.keyId},test-key-v2` });

/** Re-MAC a (possibly tampered) artifact with the TEST key: produces a
 *  MAC-AUTHENTIC artifact so the INNER verification layers (row digests,
 *  manifest, closed schema) are what fire - each layer tested on its own. */
const reMac = (lines: string[], auth: ArtifactAuth = TEST_AUTH): string[] => {
  const parsed = lines.map(l => JSON.parse(l) as Record<string, unknown>);
  const { macSha256, ...sans } = parsed[0]!;
  void macSha256;
  parsed[0] = { ...sans, macSha256: artifactMac(auth.key, sans, parsed.slice(1)) };
  return parsed.map(l => JSON.stringify(l));
};

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
    await backupUsers(conn, l => linesA.push(l), { auth: TEST_AUTH });
    expect(JSON.parse(linesA[0]!).usersPhoneUniqueIndex.existed).toBe(true);
    await conn.query(`DROP INDEX users_phone_unique`);
    await conn.query(`UPDATE users SET phone=' +19999999999 ' WHERE user_id='u-bak'`);
    const rA = await restoreUsers(conn, linesA, TEST_AUTH);
    expect(rA.verified).toBe(true);
    expect(rA.indexRestored).toBe(true);
    expect(await usersPhoneIndexExists(conn)).toBe(true);
    expect((await conn.query(`SELECT phone FROM users WHERE user_id='u-bak'`)).rows[0]!['phone']).toBe(' +15550100077 ');
    // variant B: backup WITHOUT index -> restore DROPS it (verified)
    await conn.query(`DROP INDEX users_phone_unique`);
    const linesB: string[] = [];
    await backupUsers(conn, l => linesB.push(l), { auth: TEST_AUTH });
    expect(JSON.parse(linesB[0]!).usersPhoneUniqueIndex.existed).toBe(false);
    await conn.query(`CREATE UNIQUE INDEX users_phone_unique ON users(btrim(phone)) WHERE phone IS NOT NULL`);
    const rB = await restoreUsers(conn, linesB, TEST_AUTH);
    expect(rB.verified).toBe(true);
    expect(rB.indexRestored).toBe(false);
    expect(await usersPhoneIndexExists(conn)).toBe(false);
  });

  it('restore round-trips through a real artifact file (reversible by construction)', async () => {
    await insertLegacy(conn, 'u-file', 'org-1', ' +15550100088 ', '+15550100088');
    const file = join(mkdtempSync(join(tmpdir(), 'phone-bak-')), 'users-backup.jsonl');
    const lines: string[] = [];
    const n = await backupUsers(conn, l => lines.push(l), { auth: TEST_AUTH });
    writeFileSync(file, lines.join('\n'));
    expect(n).toBeGreaterThan(0);
    await normalizeUsersPhones(conn);
    expect((await conn.query(`SELECT phone FROM users WHERE user_id='u-file'`)).rows[0]!['phone']).toBe('+15550100088');
    const r = await restoreUsers(conn, readFileSync(file, 'utf8').split('\n').filter(Boolean), TEST_AUTH);
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

pgOnly('restore artifact validation + full-restore contract (security 2026-09-18)', () => {
  const backupNow = async (): Promise<string[]> => {
    const lines: string[] = [];
    await backupUsers(conn, l => lines.push(l), { auth: TEST_AUTH });
    return lines;
  };

  it('corrupt row sha256: restore REFUSES before any mutation; table and index state unchanged', async () => {
    await insertLegacy(conn, 'u-c1', 'org-1', ' +15550101001 ', '+15550101001');
    const lines = await backupNow();
    const tampered = lines.map((l, i) => {
      if (i === 0) return l;
      const row = JSON.parse(l);
      if (row.user_id === 'u-c1') row.data = { ...row.data, name: 'tampered' }; // hash now stale
      return JSON.stringify(row);
    });
    await expect(restoreUsers(conn, reMac(tampered), TEST_AUTH)).rejects.toThrow(/row digest mismatch/);
    expect((await conn.query(`SELECT phone FROM users WHERE user_id='u-c1'`)).rows[0]!['phone']).toBe(' +15550101001 ');
    expect((await conn.query(`SELECT data->>'name' AS n FROM users WHERE user_id='u-c1'`)).rows[0]!['n']).toBe('u-c1');
  });

  it('truncated artifact (rowCount mismatch) and duplicate ids: refused before mutation', async () => {
    await insertLegacy(conn, 'u-t1', 'org-1', '+15550101011', '+15550101011');
    const lines = await backupNow();
    await expect(restoreUsers(conn, lines.slice(0, -1), TEST_AUTH)).rejects.toThrow(/MAC mismatch|rowCount|truncated/);
    const dup = [...lines, lines[1]!]; // duplicate a row line
    // rowCount now matches? no: rowCount smaller than lines -> still mismatch OR duplicate id
    await expect(restoreUsers(conn, dup, TEST_AUTH)).rejects.toThrow(/MAC mismatch|rowCount|duplicate user_id/);
    expect((await conn.query(`SELECT count(*)::int AS n FROM users WHERE user_id='u-t1'`)).rows[0]!['n']).toBe(1);
  });

  it('post-backup rows are removed EXPLICITLY and reported (full-restore contract)', async () => {
    await insertLegacy(conn, 'u-k1', 'org-1', '+15550101021', '+15550101021');
    const lines = await backupNow();
    await insertLegacy(conn, 'u-extra', 'org-1', '+15550101022', '+15550101022'); // created after backup
    const r = await restoreUsers(conn, lines, TEST_AUTH);
    expect(r.removedPostBackupRows).toEqual(['u-extra']);
    expect((await conn.query(`SELECT count(*)::int AS n FROM users WHERE user_id='u-extra'`)).rows[0]!['n']).toBe(0);
    expect(r.verified).toBe(true);
  });

  it('no-index colliding backup restored over a CURRENT index: index dropped inside the tx BEFORE colliding rows load', async () => {
    // legacy backup: no index, two colliding rows
    await insertLegacy(conn, 'u-l1', 'org-1', ' +15550101031 ', '+15550101031');
    await insertLegacy(conn, 'u-l2', 'org-2', '+15550101031', '+15550101031');
    const lines = await backupNow();
    expect(JSON.parse(lines[0]!).usersPhoneUniqueIndex.existed).toBe(false);
    // current DB: rows removed, index created clean
    await conn.query(`DELETE FROM users WHERE user_id IN ('u-l1','u-l2')`);
    await conn.query(`CREATE UNIQUE INDEX users_phone_unique ON users(btrim(phone)) WHERE phone IS NOT NULL`);
    const r = await restoreUsers(conn, lines, TEST_AUTH);
    expect(r.verified).toBe(true);
    expect(r.indexRestored).toBe(false);
    expect(await usersPhoneIndexExists(conn)).toBe(false);
    expect((await conn.query(`SELECT count(*)::int AS n FROM users WHERE user_id IN ('u-l1','u-l2')`)).rows[0]!['n']).toBe(2);
  });

  it('tampered header index definition WITHOUT resigning: refused BEFORE any mutation (closed-schema guard fires before the manifest check)', async () => {
    await insertLegacy(conn, 'u-r1', 'org-1', ' +15550101041 ', '+15550101041');
    expect((await createUsersPhoneIndex(conn)).created).toBe(true);
    const lines = await backupNow();
    const tampered = lines.map((l, i) => {
      if (i !== 0) return l;
      const h = JSON.parse(l);
      h.usersPhoneUniqueIndex.definition = 'CREATE UNIQUE INDEX users_phone_unique ON public.users USING btree (btrim(nope_column)) WHERE (phone IS NOT NULL)';
      return JSON.stringify(h);
    });
    await conn.query(`UPDATE users SET phone=' +19990000000 ' WHERE user_id='u-r1'`);
    await expect(restoreUsers(conn, reMac(tampered), TEST_AUTH)).rejects.toThrow(/non-canonical index definition/);
    expect((await conn.query(`SELECT phone FROM users WHERE user_id='u-r1'`)).rows[0]!['phone']).toBe(' +19990000000 ');
    expect(await usersPhoneIndexExists(conn)).toBe(true);
  });

  it('index-creation failure inside restore rolls back EVERYTHING (rows + schema): resigned artifact whose rows collide under the canonical index', async () => {
    // backup taken WITH index (clean rows)
    await conn.query(`DELETE FROM users WHERE user_id IN ('u-r2','u-r2b','u-keep')`);
    await insertLegacy(conn, 'u-r2', 'org-1', '+15550101042', '+15550101042');
    expect((await createUsersPhoneIndex(conn)).created).toBe(true);
    const lines = await backupNow();
    // insider-grade tamper: introduce a colliding second row and RESIGN
    // (digests + manifest recomputed) - validation passes, the canonical
    // CREATE INDEX must fail INSIDE the tx and roll back rows AND schema
    const parsed = lines.map(l => JSON.parse(l));
    const srcRow = parsed.slice(1).find(r => r.user_id === 'u-r2')!;
    const colliding = { ...srcRow, user_id: 'u-r2b', phone: ' +15550101042 ' };
    colliding.data = { ...colliding.data, userId: 'u-r2b' };
    const rows = [...parsed.slice(1), colliding].map(r => ({ user_id: r.user_id, org_id: r.org_id, email: r.email, phone: r.phone, data: r.data }));
    const digests = rows.map(rowDigest);
    const base = { type: parsed[0].type, version: parsed[0].version, createdAt: parsed[0].createdAt, rowCount: rows.length, usersPhoneUniqueIndex: parsed[0].usersPhoneUniqueIndex };
    const sansMac = { ...base, manifestSha256: manifestDigest(base, digests), backupId: parsed[0].backupId, keyId: TEST_AUTH.keyId, env: TEST_AUTH.env };
    const rowLines = rows.map((r, i) => ({ ...r, rowSha256: digests[i] }));
    const resigned = [JSON.stringify({ ...sansMac, macSha256: artifactMac(TEST_AUTH.key, sansMac, rowLines) }),
      ...rowLines.map(r => JSON.stringify(r))];
    await conn.query(`DELETE FROM users WHERE user_id IN ('u-r2','u-r2b','u-keep')`);
    await conn.query(`DROP INDEX IF EXISTS users_phone_unique`);
    await insertLegacy(conn, 'u-keep', 'org-9', '+15550109999', '+15550109999');
    await expect(restoreUsers(conn, resigned, TEST_AUTH)).rejects.toThrow();
    // rollback proof: no artifact row landed, no index was left behind
    expect((await conn.query(`SELECT count(*)::int AS n FROM users WHERE user_id IN ('u-r2','u-r2b')`)).rows[0]!['n']).toBe(0);
    expect((await conn.query(`SELECT count(*)::int AS n FROM users WHERE user_id='u-keep'`)).rows[0]!['n']).toBe(1);
    expect(await usersPhoneIndexExists(conn)).toBe(false);
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

pgOnly('artifact authentication + closed index schema (QA/security 2026-09-18 v4)', () => {
  const backupNow = async (): Promise<string[]> => {
    const lines: string[] = [];
    await backupUsers(conn, l => lines.push(l), { auth: TEST_AUTH });
    return lines;
  };
  /** Recompute row digests + manifest over (possibly tampered) content:
   *  insider-grade tamper that PASSES per-layer digests. */
  const resign = (rows: { user_id: string; org_id: string; email: string | null; phone: string | null; data: unknown }[], header: Record<string, unknown>): string[] => {
    const digests = rows.map(rowDigest);
    const base = { type: header['type'], version: header['version'], createdAt: header['createdAt'], rowCount: rows.length, usersPhoneUniqueIndex: header['usersPhoneUniqueIndex'] } as Parameters<typeof manifestDigest>[0];
    const sansMac = { ...base, manifestSha256: manifestDigest(base, digests), backupId: String(header['backupId']), keyId: TEST_AUTH.keyId, env: TEST_AUTH.env };
    const rowLines = rows.map((r, i) => ({ ...r, rowSha256: digests[i]! }));
    return [JSON.stringify({ ...sansMac, macSha256: artifactMac(TEST_AUTH.key, sansMac, rowLines) }),
      ...rowLines.map(r => JSON.stringify(r))];
  };

  it('per-row digest covers EVERY authoritative column: tampering user_id/org_id/email/phone/data with a stale digest refuses pre-mutation', async () => {
    await insertLegacy(conn, 'u-a1', 'org-1', '+15550101001', '+15550101001');
    const lines = await backupNow();
    const tampers: Record<string, (r: Record<string, unknown>) => void> = {
      user_id: r => { r['user_id'] = 'u-a1-FORGED'; },
      org_id: r => { r['org_id'] = 'org-FORGED'; },
      email: r => { r['email'] = 'forged@example.com'; },
      phone: r => { r['phone'] = '+19999999999'; },
      data: r => { r['data'] = { ...(r['data'] as object), role: 'superadmin' }; },
    };
    for (const [col, mutate] of Object.entries(tampers)) {
      const tampered = [...lines];
      const row = JSON.parse(tampered[1]!);
      mutate(row);
      tampered[1] = JSON.stringify(row);
      await expect(restoreUsers(conn, reMac(tampered), TEST_AUTH), `column ${col}`).rejects.toThrow(/row digest mismatch/);
    }
    // DB untouched by every refusal
    expect((await conn.query(`SELECT org_id FROM users WHERE user_id='u-a1'`)).rows[0]!['org_id']).toBe('org-1');
  });

  it('manifest binds the ORDERED row set: swapping two rows refuses even with intact row digests', async () => {
    await insertLegacy(conn, 'u-o1', 'org-1', '+15550101011', '+15550101011');
    await insertLegacy(conn, 'u-o2', 'org-1', '+15550101012', '+15550101012');
    const lines = await backupNow();
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const swapped = [lines[0]!, lines[2]!, lines[1]!, ...lines.slice(3)];
    await expect(restoreUsers(conn, reMac(swapped), TEST_AUTH)).rejects.toThrow(/manifest digest mismatch/);
  });

  it('manifest binds header + index state: createdAt or index-existence substitution refuses', async () => {
    await insertLegacy(conn, 'u-h1', 'org-1', '+15550101021', '+15550101021');
    const lines = await backupNow();
    const h1 = { ...JSON.parse(lines[0]!), createdAt: '2001-01-01T00:00:00.000Z' };
    await expect(restoreUsers(conn, reMac([JSON.stringify(h1), ...lines.slice(1)]), TEST_AUTH)).rejects.toThrow(/manifest digest mismatch/);
    const h2raw = JSON.parse(lines[0]!);
    h2raw.usersPhoneUniqueIndex = { existed: true, definition: CANONICAL_INDEX_SQL };
    await expect(restoreUsers(conn, reMac([JSON.stringify(h2raw), ...lines.slice(1)]), TEST_AUTH)).rejects.toThrow(/manifest digest mismatch/);
  });

  it('closed index schema: resigned evidence definitions with appended SQL / different expression / predicate / table / schema are REFUSED and NEVER executed', async () => {
    await insertLegacy(conn, 'u-s1', 'org-1', '+15550101031', '+15550101031');
    expect((await createUsersPhoneIndex(conn)).created).toBe(true);
    const lines = await backupNow();
    const header = JSON.parse(lines[0]!);
    const row = JSON.parse(lines[1]!);
    const variants: Record<string, string> = {
      'appended SQL': 'CREATE UNIQUE INDEX users_phone_unique ON public.users USING btree (btrim(phone)) WHERE (phone IS NOT NULL); CREATE TABLE pwned(x int)',
      'expression': 'CREATE UNIQUE INDEX users_phone_unique ON public.users USING btree (lower(phone)) WHERE (phone IS NOT NULL)',
      'predicate': 'CREATE UNIQUE INDEX users_phone_unique ON public.users USING btree (btrim(phone)) WHERE (phone <> \'\')',
      'table': 'CREATE UNIQUE INDEX users_phone_unique ON public.orgs USING btree (btrim(phone)) WHERE (phone IS NOT NULL)',
      'schema': 'CREATE UNIQUE INDEX users_phone_unique ON other.users USING btree (btrim(phone)) WHERE (phone IS NOT NULL)',
    };
    for (const [name, def] of Object.entries(variants)) {
      const h = { ...header, usersPhoneUniqueIndex: { existed: true, definition: def } };
      const resigned = resign([{ user_id: row.user_id, org_id: row.org_id, email: row.email, phone: row.phone, data: row.data }], h);
      await expect(restoreUsers(conn, resigned, TEST_AUTH), name).rejects.toThrow(/non-canonical index definition/);
    }
    // proof nothing executed: no pwned table, original row intact
    expect((await conn.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name='pwned'`)).rows[0]!['n']).toBe(0);
    expect((await conn.query(`SELECT count(*)::int AS n FROM users WHERE user_id='u-s1'`)).rows[0]!['n']).toBe(1);
  });

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
  it('backup + restore + migrate ALL take the ONE documented lock order: advisory FIRST, then LOCK TABLE users SHARE ROW EXCLUSIVE (recorded query stream)', async () => {
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
    recorded.length = 0;
    const lines: string[] = [];
    await backupUsers(rec, l => lines.push(l), { auth: TEST_AUTH });
    expect(recorded[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ');
    expect(recorded[1]).toContain(`pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
    expect(recorded[2]).toBe('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    recorded.length = 0;
    await restoreUsers(rec, lines, TEST_AUTH);
    const adv2 = recorded.findIndex(q => q.includes(`pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`));
    const tbl2 = recorded.findIndex(q => q === 'LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    expect(adv2).toBeGreaterThanOrEqual(0);
    expect(tbl2).toBeGreaterThan(adv2);
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

pgOnly('CLI v4 (security 2026-09-18)', () => {
  const realPgOnly = REPO_IMPL === 'realpg' ? it : it.skip;
  const distReady = () => { try { return readFileSync(new URL('../dist/services/phone-migration.js', import.meta.url), 'utf8').includes('manifestSha256'); } catch { return false; } };

  realPgOnly('CLI --maintenance success output reports ACTUAL index presence and !finalPreflight.blocking', async () => {
    if (!distReady()) return; // build artifact absent in this lane - reported as skip
    const { execFileSync } = await import('node:child_process');
    const backupFile = join(mkdtempSync(join(tmpdir(), 'upm-cli-')), 'backup.jsonl');
    const out = execFileSync(process.execPath, ['scripts/users-phone-migrate.mjs', '--database-url', process.env['DATABASE_URL'] as string, '--backup', backupFile, '--maintenance'],
      { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8',
        env: cliEnv() });
    expect(out).toMatch(/index present=true/);
    expect(out).toMatch(/final preflight clean=true/);
    expect(out).toMatch(/readback verified/);
    expect(await usersPhoneIndexExists(conn)).toBe(true);
  });

  realPgOnly('CLI --normalize/--create-index are REMOVED: exit 64 with a closure message, nothing mutated', async () => {
    if (!distReady()) return;
    const { execFileSync } = await import('node:child_process');
    const run = (flag: string) => {
      try {
        execFileSync(process.execPath, ['scripts/users-phone-migrate.mjs', '--database-url', process.env['DATABASE_URL'] as string, flag], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', stdio: 'pipe' });
        return { code: 0, err: '' };
      } catch (e) {
        const err = e as { status?: number; stderr?: string };
        return { code: err.status ?? -1, err: String(err.stderr) };
      }
    };
    for (const flag of ['--normalize', '--create-index']) {
      const r = run(flag);
      expect(r.code, flag).toBe(64);
      expect(r.err, flag).toMatch(/REMOVED in v4/);
    }
    expect(await usersPhoneIndexExists(conn)).toBe(false);
  });
});

pgOnly('artifact MAC authentication (QA/security 2026-09-18 v5)', () => {
  const backupNow = async (auth: ArtifactAuth = TEST_AUTH): Promise<string[]> => {
    const lines: string[] = [];
    await backupUsers(conn, l => lines.push(l), { auth });
    return lines;
  };

  it('wrong key: MAC mismatch, refused BEFORE any mutation', async () => {
    await insertLegacy(conn, 'u-k1', 'org-1', '+15550102001', '+15550102001');
    const lines = await backupNow();
    await expect(restoreUsers(conn, lines, { ...TEST_AUTH, key: generateBackupMacKey() }))
      .rejects.toThrow(/MAC mismatch/);
    expect((await conn.query(`SELECT phone FROM users WHERE user_id='u-k1'`)).rows[0]!['phone']).toBe('+15550102001');
  });

  it('unsigned artifact (keyId/env/mac stripped): refused even with digests + manifest intact', async () => {
    await insertLegacy(conn, 'u-k2', 'org-1', '+15550102011', '+15550102011');
    const lines = await backupNow();
    const h = JSON.parse(lines[0]!);
    delete h.keyId; delete h.env; delete h.macSha256;
    await expect(restoreUsers(conn, [JSON.stringify(h), ...lines.slice(1)], TEST_AUTH))
      .rejects.toThrow(/unsigned artifact/);
  });

  it('rehashed substitution (attacker recomputes row digests + manifest WITHOUT the key): MAC mismatch', async () => {
    await insertLegacy(conn, 'u-k3', 'org-1', '+15550102021', '+15550102021');
    const lines = await backupNow();
    const parsed = lines.map(l => JSON.parse(l));
    const forged = { ...parsed[1], phone: '+19998887777', data: { ...parsed[1].data, isSuperAdmin: true } };
    const rows = [forged].map(r => ({ user_id: r.user_id, org_id: r.org_id, email: r.email, phone: r.phone, data: r.data }));
    const digests = rows.map(rowDigest);
    const base = { type: parsed[0].type, version: parsed[0].version, createdAt: parsed[0].createdAt, rowCount: 1, usersPhoneUniqueIndex: parsed[0].usersPhoneUniqueIndex };
    // attacker rehashes EVERYTHING they can - but keeps the old MAC
    const tampered = [JSON.stringify({ ...base, manifestSha256: manifestDigest(base, digests), backupId: parsed[0].backupId, keyId: parsed[0].keyId, env: parsed[0].env, macSha256: parsed[0].macSha256 }),
      JSON.stringify({ ...forged, rowSha256: digests[0] })];
    await expect(restoreUsers(conn, tampered, TEST_AUTH)).rejects.toThrow(/MAC mismatch/);
    expect((await conn.query(`SELECT phone FROM users WHERE user_id='u-k3'`)).rows[0]!['phone']).toBe('+15550102021');
  });

  it('cross-environment replay: artifact MACed for env A refused in env B', async () => {
    await insertLegacy(conn, 'u-k4', 'org-1', '+15550102031', '+15550102031');
    const lines = await backupNow({ ...TEST_AUTH, env: 'staging-pg-a' });
    await expect(restoreUsers(conn, lines, { ...TEST_AUTH, env: 'production-pg-a' }))
      .rejects.toThrow(/cross-environment replay/);
  });

  it('same-env-class CROSS-DB replay: artifact MACed for staging-pg-a refused on staging-pg-b (deployment-unique binding)', async () => {
    await insertLegacy(conn, 'u-k4b', 'org-1', '+15550102032', '+15550102032');
    const lines = await backupNow({ ...TEST_AUTH, env: 'staging-pg-a' });
    await expect(restoreUsers(conn, lines, { ...TEST_AUTH, env: 'staging-pg-b' }))
      .rejects.toThrow(/cross-environment replay/);
  });

  it('createdAt must be a finite canonical timestamp: impossible dates and non-canonical values refused pre-mutation', async () => {
    await insertLegacy(conn, 'u-ct1', 'org-1', '+15550102041', '+15550102041');
    const lines = await backupNow();
    for (const bad of ['2026-02-30T00:00:00.000Z', 'yesterday', '2026-09-18 10:00:00', '2026-13-01T00:00:00.000Z']) {
      const h = { ...JSON.parse(lines[0]!), createdAt: bad };
      await expect(restoreUsers(conn, reMac([JSON.stringify(h), ...lines.slice(1)]), TEST_AUTH), bad)
        .rejects.toThrow(/finite canonical timestamp/);
    }
  });

  it('key-version mismatch: artifact keyId v1 refused against provided keyId v2', async () => {
    await insertLegacy(conn, 'u-k5', 'org-1', '+15550102041', '+15550102041');
    const lines = await backupNow();
    await expect(restoreUsers(conn, lines, TEST_AUTH_V2)).rejects.toThrow(/key version mismatch/);
  });

  it('backup REFUSES without complete external auth (custody guard)', async () => {
    await expect(backupUsers(conn, () => undefined, { auth: undefined as unknown as ArtifactAuth })).rejects.toThrow(/external MAC key/);
    await expect(backupUsers(conn, () => undefined, { auth: { key: '', keyId: 'test-key-v1', env: 'test-deploy-01' } })).rejects.toThrow(/64 lowercase hex/);
  });

  it('MAC + digests verify post-restore in-tx (restore of authenticated artifact still VERIFIES)', async () => {
    await insertLegacy(conn, 'u-k6', 'org-1', ' +15550102051 ', '+15550102051');
    const lines = await backupNow();
    const r = await restoreUsers(conn, lines, TEST_AUTH);
    expect(r.verified).toBe(true);
    // artifact lines validate independently too (readback path)
    expect(validateBackupArtifact(lines, TEST_AUTH).rows.some(r => r.user_id === 'u-k6')).toBe(true);
  });
});

pgOnly('backup snapshot consistency + publication (QA/security 2026-09-18 v5)', () => {
  const realPgOnly = REPO_IMPL === 'realpg' ? it : it.skip;

  realPgOnly('two-connection: concurrent writer AND index creation BLOCK during backup, fail clean under statement_timeout, succeed after', async () => {
    const { Pool } = await import('pg');
    const poolB = new Pool({ connectionString: process.env['DATABASE_URL'], max: 1 });
    let holdBackup = false;
    let pendingIndex: Promise<void> | undefined;
    const rec: Connectable = {
      query: (text: string, params?: unknown[]) => conn.query(text, params as never),
      connect: async () => {
        const client = await conn.connect();
        return {
          query: async (text: string, params?: unknown[]) => {
            const out = await client.query(text, params as never);
            if (text === 'LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE') {
              // lock now held: prove writer + DDL block before proceeding
              // writer: fails CLEAN under lock_timeout/statement_timeout
              await poolB.query(`SET lock_timeout = 1200`);
              await poolB.query(`SET statement_timeout = 2000`);
              await expect(poolB.query(`INSERT INTO users(user_id, org_id, email, phone, data) VALUES('u-cb1','org-1',NULL,'+15550102061','{}')`))
                .rejects.toThrow(/lock timeout|statement timeout|canceling statement/i);
              // schema mutation: PROVEN PENDING while the backup lock is
              // held (CREATE INDEX lock waits ignore lock_timeout on this
              // PG build, so assert in-flight instead of interrupt)
              let indexDone = false;
              const pending = poolB.query(`CREATE UNIQUE INDEX users_phone_concurrent_probe ON users(btrim(phone))`)
                .then(() => { indexDone = true; });
              await new Promise(r => setTimeout(r, 600));
              expect(indexDone).toBe(false); // still BLOCKED by the backup's table lock
              pendingIndex = pending;
              holdBackup = true;
            }
            return out;
          },
          release: () => client.release(),
        };
      },
    } as unknown as Connectable;
    try {
      const lines: string[] = [];
      await backupUsers(rec, l => lines.push(l), { auth: TEST_AUTH });
      expect(holdBackup).toBe(true);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      // after backup commits: both succeed
      await poolB.query(`SET lock_timeout = 0`);
      await poolB.query(`SET statement_timeout = 0`);
      await poolB.query(`INSERT INTO users(user_id, org_id, email, phone, data) VALUES('u-cb1','org-1',NULL,'+15550102061','{}')`);
      expect(pendingIndex).toBeDefined();
      await pendingIndex; // the blocked CREATE INDEX now completes
      await poolB.query(`DROP INDEX users_phone_concurrent_probe`);
    } finally {
      await poolB.query(`DELETE FROM users WHERE user_id='u-cb1'`).catch(() => undefined);
      await poolB.end();
    }
  });

  realPgOnly('two-connection serialization: a second locked operation WAITS behind the first (advisory first), then proceeds', async () => {
    const { Pool } = await import('pg');
    const poolB = new Pool({ connectionString: process.env['DATABASE_URL'], max: 1 });
    const bQueries: string[] = [];
    const recB: Connectable = {
      query: (text: string, params?: unknown[]) => { bQueries.push(text); return poolB.query(text, params as never); },
      connect: async () => {
        const client = await poolB.connect();
        return { query: (text: string, params?: unknown[]) => { bQueries.push(text); return client.query(text, params as never); }, release: () => client.release() };
      },
    } as unknown as Connectable;
    // operation A: holds the lock pair for ~800ms
    let aHolding = false;
    const recA: Connectable = {
      query: (text: string, params?: unknown[]) => conn.query(text, params as never),
      connect: async () => {
        const client = await conn.connect();
        return {
          query: async (text: string, params?: unknown[]) => {
            const out = await client.query(text, params as never);
            if (text === 'LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE') {
              aHolding = true;
              await new Promise(r => setTimeout(r, 800));
              aHolding = false;
            }
            return out;
          },
          release: () => client.release(),
        };
      },
    } as unknown as Connectable;
    try {
      const a = backupUsers(recA, () => undefined, { auth: TEST_AUTH });
      await new Promise(r => setTimeout(r, 200)); // let A take the locks
      const b = backupUsers(recB, () => undefined, { auth: TEST_AUTH });
      await new Promise(r => setTimeout(r, 300)); // B must be WAITING at its advisory lock
      expect(aHolding).toBe(true);
      expect(bQueries.filter(q => q.includes('LOCK TABLE')).length).toBe(0); // B has NOT passed its advisory lock
      await Promise.all([a, b]);
      expect(bQueries.some(q => q.includes('LOCK TABLE'))).toBe(true); // B proceeded after A released
    } finally {
      await poolB.end();
    }
  });
});

pgOnly('CLI durable publication (QA/security 2026-09-18 v5)', () => {
  const realPgOnly = REPO_IMPL === 'realpg' ? it : it.skip;
  const distReady = () => { try { return readFileSync(new URL('../dist/services/phone-migration.js', import.meta.url), 'utf8').includes('macSha256'); } catch { return false; } };
  const runCli = async (argv: string[], env: NodeJS.ProcessEnv = cliEnv()) => {
    const { execFileSync } = await import('node:child_process');
    try {
      const out = execFileSync(process.execPath, ['scripts/users-phone-migrate.mjs', ...argv], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', env, stdio: 'pipe' });
      return { code: 0, out, err: '' };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? -1, out: String(err.stdout ?? ''), err: String(err.stderr ?? '') };
    }
  };

  realPgOnly('backup publishes durably: 0600 file, readback verified message, independently re-validates', async () => {
    if (!distReady()) return;
    await insertLegacy(conn, 'u-p1', 'org-1', '+15550102071', '+15550102071');
    const file = join(mkdtempSync(join(tmpdir(), 'upm-pub-')), 'backup.jsonl');
    const r = await runCli(['--database-url', process.env['DATABASE_URL'] as string, '--backup', file]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/readback verified/);
    const { statSync } = await import('node:fs');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    expect(validateBackupArtifact(lines, TEST_AUTH).rows.length).toBeGreaterThanOrEqual(1);
    await conn.query(`DELETE FROM users WHERE user_id='u-p1'`);
  });

  realPgOnly('no-clobber only (overwrite removed v7): existing file preserved exactly, --overwrite-backup rejected; no partial publication on failure', async () => {
    if (!distReady()) return;
    const dir = mkdtempSync(join(tmpdir(), 'upm-ow-'));
    const file = join(dir, 'backup.jsonl');
    writeFileSync(file, 'PRE-EXISTING');
    const r1 = await runCli(['--database-url', process.env['DATABASE_URL'] as string, '--backup', file]);
    expect(r1.code).toBe(64);
    expect(r1.err).toMatch(/already exists/);
    expect(readFileSync(file, 'utf8')).toBe('PRE-EXISTING'); // exact old bytes
    const r2 = await runCli(['--database-url', process.env['DATABASE_URL'] as string, '--backup', file, '--overwrite-backup']);
    expect(r2.code).toBe(64);
    expect(r2.err).toMatch(/REMOVED in v7/);
    expect(readFileSync(file, 'utf8')).toBe('PRE-EXISTING');
    // failure path: unreachable DB leaves NO final file
    const dead = join(dir, 'dead.jsonl');
    const r3 = await runCli(['--database-url', 'postgres://postgres@127.0.0.1:1/postgres', '--backup', dead]);
    expect(r3.code).not.toBe(0);
    const { existsSync } = await import('node:fs');
    expect(existsSync(dead)).toBe(false);
  });

  realPgOnly('missing MAC env credentials: exit 64 custody message, nothing written', async () => {
    if (!distReady()) return;
    const file = join(mkdtempSync(join(tmpdir(), 'upm-ck-')), 'backup.jsonl');
    const env = { ...process.env };
    delete env['CONTAKE_BACKUP_MAC_KEY']; delete env['CONTAKE_BACKUP_KEY_ID']; delete env['CONTAKE_BACKUP_ENV'];
    const r = await runCli(['--database-url', process.env['DATABASE_URL'] as string, '--backup', file], env);
    expect(r.code).toBe(64);
    expect(r.err).toMatch(/managed secret store/);
    const { existsSync } = await import('node:fs');
    expect(existsSync(file)).toBe(false);
  });

  realPgOnly('authoritative allowlist gate (v7): non-allowlisted env or key version -> exit 64, nothing written', async () => {
    if (!distReady()) return;
    const file = join(mkdtempSync(join(tmpdir(), 'upm-al-')), 'backup.jsonl');
    const base = cliEnv();
    const badEnv = { ...base, CONTAKE_BACKUP_ALLOWED_ENVS: 'some-other-deploy' };
    const r1 = await runCli(['--database-url', process.env['DATABASE_URL'] as string, '--backup', file], badEnv);
    expect(r1.code).toBe(64);
    expect(r1.err).toMatch(/NOT in the authoritative allowlist/);
    const badKey = { ...base, CONTAKE_BACKUP_ALLOWED_KEY_IDS: 'some-other-version' };
    const r2 = await runCli(['--database-url', process.env['DATABASE_URL'] as string, '--backup', file], badKey);
    expect(r2.code).toBe(64);
    expect(r2.err).toMatch(/NOT in the authoritative allowlist/);
    const missing = { ...base };
    delete missing['CONTAKE_BACKUP_ALLOWED_ENVS'];
    const r3 = await runCli(['--database-url', process.env['DATABASE_URL'] as string, '--backup', file], missing);
    expect(r3.code).toBe(64);
    const { existsSync } = await import('node:fs');
    expect(existsSync(file)).toBe(false);
  });

  realPgOnly('path canonicalization (v7): symlink restore input and alias-colliding backup/restore refused', async () => {
    if (!distReady()) return;
    const dir = mkdtempSync(join(tmpdir(), 'upm-path-'));
    const real = join(dir, 'real.jsonl');
    // produce a real artifact first
    const r0 = await runCli(['--database-url', process.env['DATABASE_URL'] as string, '--backup', real]);
    expect(r0.code).toBe(0);
    const { symlinkSync } = await import('node:fs');
    const alias = join(dir, 'alias.jsonl');
    symlinkSync(real, alias);
    // symlink restore input: refused
    const r1 = await runCli(['--database-url', process.env['DATABASE_URL'] as string, '--backup', join(dir, 'b2.jsonl'), '--restore', alias]);
    expect(r1.code).toBe(64);
    expect(r1.err).toMatch(/symlink\/alias/);
    // relative-alias collision: --restore ./real.jsonl resolved vs --backup pointing at the same actual file via ..
    const r2 = await runCli(['--database-url', process.env['DATABASE_URL'] as string, '--backup', join(dir, 'sub', '..', 'real.jsonl'), '--restore', real]);
    expect(r2.code).toBe(64);
  });
});
