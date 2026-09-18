/** users-phone FORWARD migration as DECLARATIVE runner steps (SA lane
 *  resubmission 2026-09-19; supersedes the procedural phone-migration.ts,
 *  which is retired - the shared release-migration runner owns all schema
 *  evolution):
 *  - 0002 normalizes ROW DATA through the closed DATA template family
 *    (trim column AND embedded JSON key, each to its OWN btrim value;
 *    never deletes, never picks a representation winner);
 *  - 0003 creates the canonical users_phone_unique partial unique index
 *    through the ddl.create-index template with NAMED expression forms;
 *  - the collision guard is a runner-owned named primitive that HARD-FAILS
 *    inside the step transaction (full rollback: no rows, no index, no
 *    version record);
 *  - cross-representation collision/inconsistency REPORTING remains an
 *    operator preflight outside the migration artifact - the closed guard
 *    union intentionally cannot express it (documented boundary);
 *  - normalization is idempotent and the whole sequence re-runs as a no-op.
 *  PG lanes only (PGlite hermetic; real-PG via REPO_IMPL=realpg). Synthetic
 *  phones only. */
import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { pgliteConnectable, type Connectable } from '../src/repo/postgres.js';
import {
  EXPECTED_SCHEMA_VERSIONS, MIGRATIONS, assertSchemaCurrent, runMigrations,
  computeUsersPhonePreflight, operatorAckFor, runMigrations } from '../src/migrations/runner.js';

const pgOnly = process.env['REPO_IMPL'] === 'memory' ? describe.skip : describe;

// PGlite wasm instances are heavy; every one is closed after each test
// (leaked instances OOM the worker on the gate box).
const liveCloses: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (liveCloses.length > 0) await liveCloses.pop()!();
});

async function freshConn(): Promise<Connectable> {
  if (process.env['REPO_IMPL'] === 'realpg') {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    liveCloses.push(() => pool.end());
    return pool as unknown as Connectable;
  }
  const pg = new PGlite();
  liveCloses.push(() => pg.close());
  return pgliteConnectable(pg);
}

const insertUser = (c: Connectable, userId: string, phone: string | null, jsonPhone?: string) =>
  c.query(
    `INSERT INTO users(user_id, org_id, email, phone, data) VALUES($1, 'org-1', $2, $3, $4::jsonb)`,
    [userId, `${userId}@example.com`, phone, JSON.stringify(jsonPhone === undefined ? {} : { phone: jsonPhone })],
  );

pgOnly('declarative users-phone migration (0002 normalize + 0003 index)', () => {
  it('registers 0002 + 0003 after the 0001 baseline', () => {
    expect(EXPECTED_SCHEMA_VERSIONS).toEqual(['0001', '0002', '0003']);
    expect(MIGRATIONS[1]!.template).toBe('data.normalize-users-phone');
    expect(MIGRATIONS[2]!.template).toBe('ddl.create-index');
  });

  it('fresh database: applies 0001-0003, canonical index present, boot gate passes', async () => {
    const conn = await freshConn();
    const r = await runMigrations(conn, { deployment: 'test' });
    expect(r.appliedNow).toEqual(['0001', '0002', '0003']);
    const idx = await conn.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'users_phone_unique'`);
    expect(idx.rows.length).toBe(1);
    expect(String(idx.rows[0]!['indexdef'])).toContain('btrim(phone)');
    expect(String(idx.rows[0]!['indexdef'])).toContain('WHERE (phone IS NOT NULL)');
    await expect(assertSchemaCurrent(conn)).resolves.toBeUndefined();
  });

  it('normalizes BOTH representations to their OWN trimmed values in one step; other data untouched', async () => {
    const conn = await freshConn();
    await runMigrations(conn, { deployment: 'test', migrations: MIGRATIONS.slice(0, 1) });
    await insertUser(conn, 'u-pad-col', '  +15550100001  ');
    await insertUser(conn, 'u-pad-json', null, '  +15550100002  ');
    await insertUser(conn, 'u-pad-both', ' +15550100003 ', '  +15550100003 ');
    await insertUser(conn, 'u-clean', '+15550100004', '+15550100004');
    const r = await runMigrations(conn, { deployment: 'test' });
    expect(r.appliedNow).toEqual(['0002', '0003']);
    const rows = await conn.query(`SELECT user_id, phone, data->>'phone' AS jp FROM users ORDER BY user_id`);
    const byId = Object.fromEntries(rows.rows.map(x => [String(x['user_id']), x]));
    expect(byId['u-pad-col']!['phone']).toBe('+15550100001');
    expect(byId['u-pad-json']!['phone']).toBeNull();
    expect(byId['u-pad-json']!['jp']).toBe('+15550100002');
    // each representation trimmed to its OWN value (never a winner picked):
    expect(byId['u-pad-both']!['phone']).toBe('+15550100003');
    expect(byId['u-pad-both']!['jp']).toBe('+15550100003');
    expect(byId['u-clean']!['phone']).toBe('+15550100004');
    expect(byId['u-clean']!['jp']).toBe('+15550100004');
  });

  it('collision guard HARD-FAILS 0002 inside the step transaction: no rows mutated, no index, no version record', async () => {
    const conn = await freshConn();
    await runMigrations(conn, { deployment: 'test', migrations: MIGRATIONS.slice(0, 1) });
    await insertUser(conn, 'u-dup-1', '+15550100005');
    await insertUser(conn, 'u-dup-2', '  +15550100005  '); // same btrim identity
    await expect(runMigrations(conn, { deployment: 'test' })).rejects.toThrow(/ASSERTION refusal - guard 'no-duplicates' in '0002'/);
    // full rollback: untrimmed row untouched, no 0002/0003 records, no index
    const row = await conn.query(`SELECT phone FROM users WHERE user_id = 'u-dup-2'`);
    expect(row.rows[0]!['phone']).toBe('  +15550100005  ');
    const hist = await conn.query(`SELECT version FROM schema_migrations ORDER BY version`);
    expect(hist.rows.map(x => String(x['version']))).toEqual(['0001']);
    expect((await conn.query(`SELECT to_regclass('public.users_phone_unique') AS r`)).rows[0]!['r']).toBeNull();
  });

  it('0003 reruns the guard AFTER normalization: a collision slipped between steps still blocks the index', async () => {
    const conn = await freshConn();
    await runMigrations(conn, { deployment: 'test', migrations: MIGRATIONS.slice(0, 1) });
    await insertUser(conn, 'u-ok', '+15550100006');
    await runMigrations(conn, { deployment: 'test', migrations: MIGRATIONS.slice(0, 2) });
    // writer slips a collision in AFTER 0002 normalized (column already trimmed):
    await insertUser(conn, 'u-late-dup', '+15550100006');
    await expect(runMigrations(conn, { deployment: 'test' })).rejects.toThrow(/ASSERTION refusal - guard 'no-duplicates' in '0003'/);
    expect((await conn.query(`SELECT to_regclass('public.users_phone_unique') AS r`)).rows[0]!['r']).toBeNull();
    const hist = await conn.query(`SELECT version FROM schema_migrations ORDER BY version`);
    expect(hist.rows.map(x => String(x['version']))).toEqual(['0001', '0002']);
  });

  it('cross-representation inconsistency does NOT block (operator-preflight boundary); both sides still trim to their own values', async () => {
    const conn = await freshConn();
    await runMigrations(conn, { deployment: 'test', migrations: MIGRATIONS.slice(0, 1) });
    await insertUser(conn, 'u-inconsistent', ' +15550100007 ', ' +15550100008 ');
    const r = await runMigrations(conn, { deployment: 'test' });
    expect(r.appliedNow).toEqual(['0002', '0003']);
    const row = await conn.query(`SELECT phone, data->>'phone' AS jp FROM users WHERE user_id = 'u-inconsistent'`);
    expect(row.rows[0]!['phone']).toBe('+15550100007');
    expect(row.rows[0]!['jp']).toBe('+15550100008'); // its OWN value preserved - the operator preflight owns the decision
  });

  it("SA1 acceptance: blank phones ('' and whitespace-only) normalize to NULL and the index builds - absence, not identity", async () => {
    const conn = await freshConn();
    await runMigrations(conn, { deployment: 'test', migrations: MIGRATIONS.slice(0, 1) });
    await insertUser(conn, 'u-blank-1', '');
    await insertUser(conn, 'u-blank-2', '   ');
    await insertUser(conn, 'u-blank-json', null, '  ');
    await insertUser(conn, 'u-real', '+15550100009');
    const r = await runMigrations(conn, { deployment: 'test' });
    // two absent phones are NOT a collision: no guard refusal, both steps apply
    expect(r.appliedNow).toEqual(['0002', '0003']);
    const rows = await conn.query(`SELECT user_id, phone, data->>'phone' AS jp FROM users ORDER BY user_id`);
    const byId = Object.fromEntries(rows.rows.map(x => [String(x['user_id']), x]));
    expect(byId['u-blank-1']!['phone']).toBeNull();
    expect(byId['u-blank-2']!['phone']).toBeNull();
    expect(byId['u-blank-json']!['jp']).toBeNull(); // jsonb null - key preserved, value absent
    expect(byId['u-real']!['phone']).toBe('+15550100009');
    // the partial index excludes absent phones by construction and BUILDS:
    expect((await conn.query(`SELECT to_regclass('public.users_phone_unique') AS r`)).rows[0]!['r']).not.toBeNull();
  });

  it('SA1 acceptance: login-by-phone can never match a NULL phone (findUserByPhone semantics)', async () => {
    const conn = await freshConn();
    await runMigrations(conn, { deployment: 'test', migrations: MIGRATIONS.slice(0, 1) });
    await insertUser(conn, 'u-blank-login', '');
    await insertUser(conn, 'u-real-login', ' +15550100010 ');
    await runMigrations(conn, { deployment: 'test' });
    // the EXACT lookup statement PostgresGraphRepository.findUserByPhone issues:
    const blank = await conn.query(`SELECT data FROM users WHERE phone=$1 LIMIT 1`, [''.trim()]);
    expect(blank.rows.length).toBe(0); // SQL NULL never equals '' - absence is not identity
    const ws = await conn.query(`SELECT data FROM users WHERE phone=$1 LIMIT 1`, ['   '.trim()]);
    expect(ws.rows.length).toBe(0);
    const real = await conn.query(`SELECT data FROM users WHERE phone=$1 LIMIT 1`, [' +15550100010 '.trim()]);
    expect(real.rows.length).toBe(1); // a real phone still resolves after trimming
  });

  it('idempotent: a second full run applies nothing and keeps the index', async () => {
    const conn = await freshConn();
    await runMigrations(conn, { deployment: 'test' });
    const r2 = await runMigrations(conn, { deployment: 'test' });
    expect(r2.appliedNow).toEqual([]);
    expect((await conn.query(`SELECT to_regclass('public.users_phone_unique') AS r`)).rows[0]!['r']).not.toBeNull();
    await expect(assertSchemaCurrent(conn)).resolves.toBeUndefined();
  });
});

// --- SA2 real-entrypoint operator gate (mine) ---
describe('SA2 operator gate (runner-enforced, recomputed under lock)', () => {
  const STAGING = 'staging';
  const seedClean = async (db: PGlite) => {
    await db.query(`CREATE TABLE public.users(user_id text PRIMARY KEY, org_id text NOT NULL DEFAULT 'o1', phone text, data jsonb)`);
    await db.query(`INSERT INTO public.users(user_id, phone, data) VALUES
      ('u1', '+15550100001', '{"phone":"+15550100001"}'),
      ('u2', NULL, '{}')`);
  };
  it('absent ack refuses on staging-shaped deployments; nothing past 0001 applies', async () => {
    const raw = new PGlite(); const db = pgliteConnectable(raw);
    try {
      await expect(runMigrations(db, { deployment: STAGING })).rejects.toThrow('OPERATOR GATE refusal');
      const r = await db.query(`SELECT version FROM public.schema_migrations ORDER BY seq`);
      expect(r.rows.map(x => x['version'])).toEqual(['0001']);
    } finally { await raw.close(); }
  });
  it('wrong ack refuses', async () => {
    const raw = new PGlite(); const db = pgliteConnectable(raw);
    try {
      await expect(runMigrations(db, { deployment: STAGING, operatorAck: 'ack:deadbeef' })).rejects.toThrow('OPERATOR GATE refusal');
    } finally { await raw.close(); }
  });
  it('correct ack applies 0002/0003 and persists the acknowledged report + digest as migration evidence', async () => {
    const raw = new PGlite(); const db = pgliteConnectable(raw);
    try {
      // attended first run: preflight on the fresh DB (empty list), ack minted.
      const pf = await computeUsersPhonePreflight(db, { deployment: STAGING });
      const r = await runMigrations(db, { deployment: STAGING, operatorAck: operatorAckFor(pf) });
      expect(r.appliedNow).toEqual(['0001', '0002', '0003']);
      const ev = await db.query(`SELECT version, kind, list_digest, target FROM public.schema_migration_evidence ORDER BY version`);
      expect(ev.rows.map(x => x['version'])).toEqual(['0002', '0003']);
      expect(ev.rows[0]!['list_digest']).toMatch(/^[0-9a-f]{64}$/);
    } finally { await raw.close(); }
  });
  it('stale ack refuses: state changed after the ack was minted', async () => {
    const raw = new PGlite(); const db = pgliteConnectable(raw);
    try {
      const pf = await computeUsersPhonePreflight(db, { deployment: STAGING });
      const ack = operatorAckFor(pf);
      // operator walks away; state changes (a colliding pair appears)
      await seedClean(db);
      await db.query(`INSERT INTO public.users(user_id, phone, data) VALUES ('u3', ' +15550100001 ', '{}')`);
      await expect(runMigrations(db, { deployment: STAGING, operatorAck: ack })).rejects.toThrow('OPERATOR GATE refusal');
      const r = await db.query(`SELECT version FROM public.schema_migrations ORDER BY seq`);
      expect(r.rows.map(x => x['version'])).toEqual(['0001']);
    } finally { await raw.close(); }
  });
  it('replayed ack refuses: ack minted for another deployment matches nothing here', async () => {
    const raw = new PGlite(); const db = pgliteConnectable(raw);
    try {
      const pfOther = await computeUsersPhonePreflight(db, { deployment: 'production' });
      await expect(runMigrations(db, { deployment: STAGING, operatorAck: operatorAckFor(pfOther) })).rejects.toThrow('OPERATOR GATE refusal');
    } finally { await raw.close(); }
  });
  it('attended TOFU on an EXISTING database: real inconsistency list acknowledged, gate passes, evidence carries the list', async () => {
    const raw = new PGlite(); const db = pgliteConnectable(raw);
    try {
      await seedClean(db);
      // cross-representation inconsistency (does NOT block; operator boundary),
      // no real-phone collision.
      await db.query(`INSERT INTO public.users(user_id, phone, data) VALUES ('u3', ' +15550100009 ', '{"phone":"+15550100008"}')`);
      const pf = await computeUsersPhonePreflight(db, { deployment: STAGING });
      expect(pf.collisionGroups.length).toBe(0);
      expect(pf.crossRepresentationInconsistencies.length).toBe(1);
      const r = await runMigrations(db, { deployment: STAGING, operatorAck: operatorAckFor(pf) });
      expect(r.appliedNow).toEqual(['0001', '0002', '0003']);
      const ev = await db.query(`SELECT report FROM public.schema_migration_evidence WHERE version = '0002'`);
      const report = ev.rows[0]!['report'] as { report: { crossRepresentationInconsistencies: unknown[] } };
      expect(report.report.crossRepresentationInconsistencies.length).toBe(1);
    } finally { await raw.close(); }
  });
  it('a VALID ack does NOT override the collision guard: ack is a precondition, not a bypass', async () => {
    const raw = new PGlite(); const db = pgliteConnectable(raw);
    try {
      await seedClean(db);
      await db.query(`INSERT INTO public.users(user_id, phone, data) VALUES ('u3', ' +15550100001 ', '{}')`);
      const pf = await computeUsersPhonePreflight(db, { deployment: STAGING });
      expect(pf.collisionGroups.length).toBe(1);
      await expect(runMigrations(db, { deployment: STAGING, operatorAck: operatorAckFor(pf) }))
        .rejects.toThrow(/ASSERTION refusal - guard 'no-duplicates'/);
      const r = await db.query(`SELECT version FROM public.schema_migrations ORDER BY seq`);
      expect(r.rows.map(x => x['version'])).toEqual(['0001']);
    } finally { await raw.close(); }
  });
  it('the ack covers the attended 0002+0003 SEQUENCE: blank phones move the recomputed lists after 0002, 0003 continues in the same run', async () => {
    const raw = new PGlite(); const db = pgliteConnectable(raw);
    try {
      await seedClean(db);
      await db.query(`INSERT INTO public.users(user_id, phone, data) VALUES ('u-blank', '', '{}')`);
      const pf = await computeUsersPhonePreflight(db, { deployment: STAGING });
      expect(pf.blankPhoneUsers.length).toBe(1);
      const r = await runMigrations(db, { deployment: STAGING, operatorAck: operatorAckFor(pf) });
      expect(r.appliedNow).toEqual(['0001', '0002', '0003']);
      // the recomputed post-0002 lists differ from the acked ones; evidence
      // records the recomputed digest per step.
      const ev = await db.query(`SELECT version, list_digest FROM public.schema_migration_evidence ORDER BY version`);
      expect(ev.rows.length).toBe(2);
      expect(ev.rows[0]!['list_digest']).not.toBe(ev.rows[1]!['list_digest']);
    } finally { await raw.close(); }
  });
  it('the accepted ack does NOT leak across runs: a later gated step demands a FRESH ack', async () => {
    const raw = new PGlite(); const db = pgliteConnectable(raw);
    try {
      const pf = await computeUsersPhonePreflight(db, { deployment: STAGING });
      const ack = operatorAckFor(pf);
      const late: typeof MIGRATIONS[number] = {
        version: '0004', name: 'later-gated', description: 'later gated step', template: 'ddl.create-index',
        params: { index: 'users_phone_org_idx', table: 'users', unique: 'unique', expression: 'EXPR_NORM_PHONE', predicate: 'PRED_PHONE_NOT_NULL', ifNotExists: 'if-not-exists' },
        requiresOperatorAck: true,
      };
      await runMigrations(db, { deployment: STAGING, operatorAck: ack });
      // a NEW run presenting the OLD ack for a NEW gated step: the preflight
      // recompute must match - the old ack covers nothing new.
      await expect(runMigrations(db, { deployment: STAGING, migrations: [...MIGRATIONS, late], operatorAck: 'ack:' + '0'.repeat(64) }))
        .rejects.toThrow('OPERATOR GATE refusal');
      const pfNow = await computeUsersPhonePreflight(db, { deployment: STAGING });
      const ok = await runMigrations(db, { deployment: STAGING, migrations: [...MIGRATIONS, late], operatorAck: operatorAckFor(pfNow) });
      expect(ok.appliedNow).toEqual(['0004']);
    } finally { await raw.close(); }
  });
  it("test deployments stay gate-exempt (hermetic synthetic lanes)", async () => {
    const raw = new PGlite(); const db = pgliteConnectable(raw);
    try {
      const r = await runMigrations(db, { deployment: 'test' });
      expect(r.appliedNow).toEqual(['0001', '0002', '0003']);
    } finally { await raw.close(); }
  });
});
