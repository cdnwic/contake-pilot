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
  attendedResolveDirty, computeUsersPhonePreflight, issueOperatorPreflight, operatorAckFor, operatorListDigestForReview } from '../src/migrations/runner.js';

type RunOpts = Parameters<typeof runMigrations>[1];
/** SA3: tests mint REAL acks through the REAL issuance path (a persisted
 *  issued-nonce record); no caller-label exemption exists anywhere. */
const mintAck = async (conn: Connectable, opts: RunOpts): Promise<string> => {
  const pf = await issueOperatorPreflight(conn, opts.migrations === undefined
    ? { deployment: opts.deployment }
    : { deployment: opts.deployment, migrations: opts.migrations });
  return operatorAckFor(pf);
};
const runAcked = async (conn: Connectable, opts: RunOpts) =>
  runMigrations(conn, { ...opts, operatorAck: await mintAck(conn, opts) });

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
    const r = await runAcked(conn, { deployment: 'test' });
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
    const r = await runAcked(conn, { deployment: 'test' });
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
    await expect(runAcked(conn, { deployment: 'test' })).rejects.toThrow(/ASSERTION refusal - guard 'no-duplicates' in '0002'/);
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
    await runAcked(conn, { deployment: 'test', migrations: MIGRATIONS.slice(0, 2) });
    // writer slips a collision in AFTER 0002 normalized (column already trimmed):
    await insertUser(conn, 'u-late-dup', '+15550100006');
    await expect(runAcked(conn, { deployment: 'test' })).rejects.toThrow(/ASSERTION refusal - guard 'no-duplicates' in '0003'/);
    expect((await conn.query(`SELECT to_regclass('public.users_phone_unique') AS r`)).rows[0]!['r']).toBeNull();
    const hist = await conn.query(`SELECT version FROM schema_migrations ORDER BY version`);
    expect(hist.rows.map(x => String(x['version']))).toEqual(['0001', '0002']);
  });

  it('cross-representation inconsistency does NOT block (operator-preflight boundary); both sides still trim to their own values', async () => {
    const conn = await freshConn();
    await runMigrations(conn, { deployment: 'test', migrations: MIGRATIONS.slice(0, 1) });
    await insertUser(conn, 'u-inconsistent', ' +15550100007 ', ' +15550100008 ');
    const r = await runAcked(conn, { deployment: 'test' });
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
    const r = await runAcked(conn, { deployment: 'test' });
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
    await runAcked(conn, { deployment: 'test' });
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
    await runAcked(conn, { deployment: 'test' });
    const r2 = await runMigrations(conn, { deployment: 'test' });
    expect(r2.appliedNow).toEqual([]);
    expect((await conn.query(`SELECT to_regclass('public.users_phone_unique') AS r`)).rows[0]!['r']).not.toBeNull();
    await expect(assertSchemaCurrent(conn)).resolves.toBeUndefined();
  });
});

// --- SA2/SA2-A/SA3 real-entrypoint operator gate (mine) ---
describe('SA2+SA3 operator gate (runner-enforced, issued-nonce lifecycle, recomputed under lock)', () => {
  const STAGING = 'staging';
  const seedClean = async (db: PGlite) => {
    await db.query(`CREATE TABLE public.users(user_id text PRIMARY KEY, org_id text NOT NULL DEFAULT 'o1', phone text, data jsonb)`);
    await db.query(`INSERT INTO public.users(user_id, phone, data) VALUES
      ('u1', '+15550100001', '{"phone":"+15550100001"}'),
      ('u2', NULL, '{}')`);
  };
  const newDb = async () => {
    const raw = new PGlite();
    return { raw, db: pgliteConnectable(raw) };
  };
  const lateStep = (): typeof MIGRATIONS[number] => ({
    version: '0004', name: 'later-gated', description: 'later gated step', template: 'ddl.create-index',
    params: { index: 'users_phone_org_idx', table: 'users', unique: 'unique', expression: 'EXPR_NORM_PHONE', predicate: 'PRED_PHONE_NOT_NULL', ifNotExists: 'if-not-exists' },
    requiresOperatorAck: true,
  });
  it('absent ack refuses on staging-shaped deployments; nothing past 0001 applies', async () => {
    const { raw, db } = await newDb();
    try {
      await expect(runMigrations(db, { deployment: STAGING })).rejects.toThrow('OPERATOR GATE refusal');
      const r = await db.query(`SELECT version FROM public.schema_migrations ORDER BY seq`);
      expect(r.rows.map(x => x['version'])).toEqual(['0001']);
    } finally { await raw.close(); }
  });
  it('malformed ack refuses', async () => {
    const { raw, db } = await newDb();
    try {
      await expect(runMigrations(db, { deployment: STAGING, operatorAck: 'ack:deadbeef' })).rejects.toThrow('OPERATOR GATE refusal');
    } finally { await raw.close(); }
  });
  it('SA3 Q1: TRULY-ABSENT preflight - a well-formed ack built from an arbitrary nonce + the public canonical digest (NO issuance record) refuses', async () => {
    const { raw, db } = await newDb();
    try {
      // read-only compute only - NOTHING persisted; the attacker knows the
      // canonical lists and the digest recipe, picks an arbitrary nonce.
      const pf = await computeUsersPhonePreflight(db, { deployment: STAGING });
      const forged = operatorAckFor(pf);
      expect(forged).toMatch(/^ack:[0-9a-f]{16}:[0-9a-f]{64}$/);
      await expect(runMigrations(db, { deployment: STAGING, operatorAck: forged })).rejects.toThrow(/NO ISSUED PREFLIGHT/);
      const r = await db.query(`SELECT version FROM public.schema_migrations ORDER BY seq`);
      expect(r.rows.map(x => x['version'])).toEqual(['0001']);
    } finally { await raw.close(); }
  });
  it('correct ISSUED ack applies 0002/0003; lifecycle + evidence records persisted with unique event identity', async () => {
    const { raw, db } = await newDb();
    try {
      const pf = await issueOperatorPreflight(db, { deployment: STAGING });
      const r = await runMigrations(db, { deployment: STAGING, operatorAck: operatorAckFor(pf) });
      expect(r.appliedNow).toEqual(['0001', '0002', '0003']);
      // lifecycle: the issued record transitioned exactly once to consumed.
      const acks = await db.query(`SELECT nonce, state FROM public.schema_migration_acks`);
      expect(acks.rows.length).toBe(1);
      expect(acks.rows[0]!['nonce']).toBe(pf.nonce);
      expect(acks.rows[0]!['state']).toBe('consumed');
      // append-only events: issued + consumed + per-step attended-tofu.
      const ev = await db.query(`SELECT version, kind, list_digest, target FROM public.schema_migration_evidence WHERE kind = 'attended-tofu' ORDER BY version`);
      expect(ev.rows.map(x => x['version'])).toEqual(['0002', '0003']);
      expect(ev.rows[0]!['list_digest']).toMatch(/^[0-9a-f]{64}$/);
      const kinds = await db.query(`SELECT kind FROM public.schema_migration_evidence ORDER BY seq`);
      expect(kinds.rows.map(x => x['kind'])).toEqual(['runner-bootstrap', 'ack-issued', 'ack-consumed', 'attended-tofu', 'attended-tofu']);
      // every event carries a UNIQUE event_id (append-only identity).
      const ids = await db.query(`SELECT event_id FROM public.schema_migration_evidence`);
      expect(new Set(ids.rows.map(x => String(x['event_id']))).size).toBe(ids.rows.length);
      const boot = await db.query(`SELECT version, kind, list_digest FROM public.schema_migration_evidence WHERE kind = 'runner-bootstrap'`);
      expect(boot.rows.length).toBe(1);
      expect(boot.rows[0]!['version']).toBe('0000');
    } finally { await raw.close(); }
  });
  it('stale ack refuses: state changed after issuance (in-lock recompute disagrees)', async () => {
    const { raw, db } = await newDb();
    try {
      const pf = await issueOperatorPreflight(db, { deployment: STAGING });
      const ack = operatorAckFor(pf);
      // operator walks away; state changes (a colliding pair appears)
      await seedClean(db);
      await db.query(`INSERT INTO public.users(user_id, phone, data) VALUES ('u3', ' +15550100001 ', '{}')`);
      await expect(runMigrations(db, { deployment: STAGING, operatorAck: ack })).rejects.toThrow('OPERATOR GATE refusal');
      const r = await db.query(`SELECT version FROM public.schema_migrations ORDER BY seq`);
      expect(r.rows.map(x => x['version'])).toEqual(['0001']);
    } finally { await raw.close(); }
  });
  it('cross-target ack refuses: issued for another deployment matches nothing here', async () => {
    const { raw, db } = await newDb();
    try {
      const pfOther = await issueOperatorPreflight(db, { deployment: 'production' });
      await expect(runMigrations(db, { deployment: STAGING, operatorAck: operatorAckFor(pfOther) })).rejects.toThrow(/CROSS-TARGET/);
    } finally { await raw.close(); }
  });
  it('attended TOFU on an EXISTING database: real inconsistency list acknowledged, gate passes, evidence carries the list', async () => {
    const { raw, db } = await newDb();
    try {
      await seedClean(db);
      await db.query(`INSERT INTO public.users(user_id, phone, data) VALUES ('u3', ' +15550100009 ', '{"phone":"+15550100008"}')`);
      const pf = await issueOperatorPreflight(db, { deployment: STAGING });
      expect(pf.collisionGroups.length).toBe(0);
      expect(pf.crossRepresentationInconsistencies.length).toBe(1);
      const r = await runMigrations(db, { deployment: STAGING, operatorAck: operatorAckFor(pf) });
      expect(r.appliedNow).toEqual(['0001', '0002', '0003']);
      const ev = await db.query(`SELECT report FROM public.schema_migration_evidence WHERE version = '0002' AND kind = 'attended-tofu'`);
      const report = ev.rows[0]!['report'] as { report: { crossRepresentationInconsistencies: unknown[] } };
      expect(report.report.crossRepresentationInconsistencies.length).toBe(1);
    } finally { await raw.close(); }
  });
  it('a VALID ack does NOT override the collision guard: ack is a precondition, not a bypass; the abort invalidates it', async () => {
    const { raw, db } = await newDb();
    try {
      await seedClean(db);
      await db.query(`INSERT INTO public.users(user_id, phone, data) VALUES ('u3', ' +15550100001 ', '{}')`);
      const pf = await issueOperatorPreflight(db, { deployment: STAGING });
      expect(pf.collisionGroups.length).toBe(1);
      await expect(runMigrations(db, { deployment: STAGING, operatorAck: operatorAckFor(pf) }))
        .rejects.toThrow(/ASSERTION refusal - guard 'no-duplicates'/);
      const r = await db.query(`SELECT version FROM public.schema_migrations ORDER BY seq`);
      expect(r.rows.map(x => x['version'])).toEqual(['0001']);
      // consumed-then-aborted: the record is INVALIDATED (not replayable).
      const acks = await db.query(`SELECT state FROM public.schema_migration_acks WHERE nonce = $1`, [pf.nonce]);
      expect(acks.rows[0]!['state']).toBe('invalidated');
      const inv = await db.query(`SELECT kind, report->>'nonce' AS nonce FROM public.schema_migration_evidence WHERE kind = 'ack-invalidated'`);
      expect(inv.rows.length).toBe(1);
      expect(inv.rows[0]!['nonce']).toBe(pf.nonce);
    } finally { await raw.close(); }
  });
  it('the ack covers the attended 0002+0003 SEQUENCE: blank phones move the recomputed lists after 0002, 0003 continues in the same run', async () => {
    const { raw, db } = await newDb();
    try {
      await seedClean(db);
      await db.query(`INSERT INTO public.users(user_id, phone, data) VALUES ('u-blank', '', '{}')`);
      const pf = await issueOperatorPreflight(db, { deployment: STAGING });
      expect(pf.blankPhoneUsers.length).toBe(1);
      const r = await runMigrations(db, { deployment: STAGING, operatorAck: operatorAckFor(pf) });
      expect(r.appliedNow).toEqual(['0001', '0002', '0003']);
      const ev = await db.query(`SELECT version, list_digest FROM public.schema_migration_evidence WHERE kind = 'attended-tofu' ORDER BY version`);
      expect(ev.rows.length).toBe(2);
      expect(ev.rows[0]!['list_digest']).not.toBe(ev.rows[1]!['list_digest']);
      const dig = await db.query(`SELECT version, report->>'preStateDigest' AS pre, report->>'postStateDigest' AS post FROM public.schema_migration_evidence WHERE kind = 'attended-tofu' ORDER BY version`);
      for (const row of dig.rows) { expect(row['post']).toBe(row['pre']); expect(String(row['pre'])).toMatch(/^[0-9a-f]{64}$/); }
    } finally { await raw.close(); }
  });
  it('the accepted ack does NOT leak across runs: a later gated step demands a FRESH issued ack', async () => {
    const { raw, db } = await newDb();
    try {
      const pf = await issueOperatorPreflight(db, { deployment: STAGING });
      const ack = operatorAckFor(pf);
      const late = lateStep();
      await runMigrations(db, { deployment: STAGING, operatorAck: ack });
      await expect(runMigrations(db, { deployment: STAGING, migrations: [...MIGRATIONS, late], operatorAck: 'ack:' + '0'.repeat(16) + ':' + '0'.repeat(64) }))
        .rejects.toThrow('OPERATOR GATE refusal');
      const pfNow = await issueOperatorPreflight(db, { deployment: STAGING, migrations: [...MIGRATIONS, late] });
      const ok = await runMigrations(db, { deployment: STAGING, migrations: [...MIGRATIONS, late], operatorAck: operatorAckFor(pfNow) });
      expect(ok.appliedNow).toEqual(['0004']);
    } finally { await raw.close(); }
  });
  it('SA2-A acceptance: PLAN-MISMATCH presentation refuses (ack string carrying a tampered plan digest)', async () => {
    const { raw, db } = await newDb();
    try {
      const pf = await issueOperatorPreflight(db, { deployment: STAGING });
      expect(pf.plan.map(x => x.version)).toEqual(['0002', '0003']);
      const tamperedPlan = (keep: string) => operatorListDigestForReview({
        target: pf.target, deployment: pf.deployment, nonce: pf.nonce,
        plan: pf.plan.filter(x => x.version === keep),
        collisionGroups: pf.collisionGroups, crossRepresentationInconsistencies: pf.crossRepresentationInconsistencies, blankPhoneUsers: pf.blankPhoneUsers,
      });
      await expect(runMigrations(db, { deployment: STAGING, operatorAck: `ack:${pf.nonce}:${tamperedPlan('0002')}` })).rejects.toThrow('OPERATOR GATE refusal');
      await expect(runMigrations(db, { deployment: STAGING, operatorAck: `ack:${pf.nonce}:${tamperedPlan('0003')}` })).rejects.toThrow('OPERATOR GATE refusal');
    } finally { await raw.close(); }
  });
  it('SA3: RECORD plan-mismatch refuses - digest valid for the CURRENT plan, but the issuance bound a different plan', async () => {
    const { raw, db } = await newDb();
    try {
      const pf = await issueOperatorPreflight(db, { deployment: STAGING });
      // attacker re-derives a digest over the CURRENT (wider) plan with the issued nonce
      const late = lateStep();
      const wider = await computeUsersPhonePreflight(db, { deployment: STAGING, migrations: [...MIGRATIONS, late], nonce: pf.nonce });
      await expect(runMigrations(db, { deployment: STAGING, migrations: [...MIGRATIONS, late], operatorAck: `ack:${pf.nonce}:${wider.listDigest}` }))
        .rejects.toThrow(/PLAN MISMATCH/);
    } finally { await raw.close(); }
  });
  it('SA2-A acceptance: POST-ABORT reuse refuses; the abort invalidates the ack (append-only unique events); a fresh issuance succeeds', async () => {
    const { raw, db } = await newDb();
    try {
      await seedClean(db);
      const failing0003: typeof MIGRATIONS[number] = {
        ...MIGRATIONS[2]!,
        assertions: [{ kind: 'table-empty', table: 'users' }],
      };
      const plan = [...MIGRATIONS.slice(0, 2), failing0003];
      const pf = await issueOperatorPreflight(db, { deployment: STAGING, migrations: plan });
      const ack = operatorAckFor(pf);
      await expect(runMigrations(db, { deployment: STAGING, migrations: plan, operatorAck: ack }))
        .rejects.toThrow(/ASSERTION refusal - guard 'table-empty'/);
      const applied = await db.query(`SELECT version FROM public.schema_migrations ORDER BY seq`);
      expect(applied.rows.map(x => x['version'])).toEqual(['0001']);
      const inv = await db.query(`SELECT event_id, kind, report->>'nonce' AS nonce FROM public.schema_migration_evidence WHERE kind = 'ack-invalidated'`);
      expect(inv.rows.length).toBe(1);
      expect(inv.rows[0]!['nonce']).toBe(pf.nonce);
      // REPLAY of the exact same ack (same plan, unchanged state): digest and
      // plan still match, but the lifecycle state refuses it (loud conflict).
      await expect(runMigrations(db, { deployment: STAGING, migrations: plan, operatorAck: ack })).rejects.toThrow(/ACK LIFECYCLE/);
      const pf2 = await issueOperatorPreflight(db, { deployment: STAGING });
      expect(operatorAckFor(pf2)).not.toBe(ack);
      const r = await runMigrations(db, { deployment: STAGING, operatorAck: operatorAckFor(pf2) });
      expect(r.appliedNow).toEqual(['0002', '0003']);
    } finally { await raw.close(); }
  });
  it('SA3 Q2: a SECOND ack invalidation is NEVER dropped - two aborted runs leave TWO append-only invalidation events with unique identities', async () => {
    const { raw, db } = await newDb();
    try {
      await seedClean(db);
      await db.query(`INSERT INTO public.users(user_id, phone, data) VALUES ('u3', ' +15550100001 ', '{}')`); // collision pair -> guard aborts both runs
      const pf1 = await issueOperatorPreflight(db, { deployment: STAGING });
      await expect(runMigrations(db, { deployment: STAGING, operatorAck: operatorAckFor(pf1) })).rejects.toThrow(/ASSERTION refusal/);
      const pf2 = await issueOperatorPreflight(db, { deployment: STAGING });
      await expect(runMigrations(db, { deployment: STAGING, operatorAck: operatorAckFor(pf2) })).rejects.toThrow(/ASSERTION refusal/);
      const inv = await db.query(`SELECT event_id, report->>'nonce' AS nonce FROM public.schema_migration_evidence WHERE kind = 'ack-invalidated' ORDER BY seq`);
      expect(inv.rows.length).toBe(2);
      expect(inv.rows.map(x => x['nonce'])).toEqual([pf1.nonce, pf2.nonce]);
      expect(inv.rows[0]!['event_id']).not.toBe(inv.rows[1]!['event_id']);
      // both acks are dead: neither replays (Q2's reuse path is closed).
      await expect(runMigrations(db, { deployment: STAGING, operatorAck: operatorAckFor(pf1) })).rejects.toThrow(/ACK LIFECYCLE/);
      await expect(runMigrations(db, { deployment: STAGING, operatorAck: operatorAckFor(pf2) })).rejects.toThrow(/ACK LIFECYCLE/);
    } finally { await raw.close(); }
  });
  it('SA3: a second lifecycle transition is a LOUD conflict (consumed record presented again)', async () => {
    const { raw, db } = await newDb();
    try {
      const pf = await issueOperatorPreflight(db, { deployment: STAGING });
      // simulate the consumed state directly (the successful-run path is
      // covered above); presenting it with a matching plan+state must refuse.
      await db.query(`UPDATE public.schema_migration_acks SET state = 'consumed' WHERE nonce = $1`, [pf.nonce]);
      await expect(runMigrations(db, { deployment: STAGING, operatorAck: operatorAckFor(pf) })).rejects.toThrow(/ACK LIFECYCLE/);
      const acks = await db.query(`SELECT state FROM public.schema_migration_acks WHERE nonce = $1`, [pf.nonce]);
      expect(acks.rows[0]!['state']).toBe('consumed'); // never silently transitioned again
    } finally { await raw.close(); }
  });
  it('SA3 section 5: invalidation-failure marks the target DIRTY/INDETERMINATE (BOTH errors retained), blocks issuance + runs, attended resolution unblocks', async () => {
    const { raw, db } = await newDb();
    try {
      await seedClean(db);
      const pf = await issueOperatorPreflight(db, { deployment: STAGING });
      // break EVERY evidence insert: the abort's invalidation event will fail.
      await db.query(`CREATE OR REPLACE FUNCTION public.__sa3_fail_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated evidence-write failure'; END; $$`);
      await db.query(`CREATE TRIGGER __sa3_fail_evidence BEFORE INSERT ON public.schema_migration_evidence FOR EACH ROW EXECUTE FUNCTION public.__sa3_fail_evidence()`);
      let dirtyErr: unknown;
      try {
        await runMigrations(db, { deployment: STAGING, operatorAck: operatorAckFor(pf) });
      } catch (e) { dirtyErr = e; }
      expect(String((dirtyErr as Error).message)).toContain('DIRTY/INDETERMINATE');
      // BOTH error records retained: the original failure (the trigger broke
      // the ack-consumed event) AND the invalidation failure.
      expect(String((dirtyErr as Error).message)).toContain('original failure:');
      expect(String((dirtyErr as Error).message)).toContain('invalidation failure:');
      expect(String((dirtyErr as Error).message)).toContain('simulated evidence-write failure');
      // the target is marked DIRTY: runs AND issuance both refuse.
      const ts = await db.query(`SELECT dirty, dirty_reason FROM public.schema_migration_target_state`);
      expect(ts.rows.length).toBe(1);
      expect(ts.rows[0]!['dirty']).toBe(true);
      expect(JSON.stringify(ts.rows[0]!['dirty_reason'])).toContain('originalFailure');
      expect(JSON.stringify(ts.rows[0]!['dirty_reason'])).toContain('invalidationFailure');
      await expect(runMigrations(db, { deployment: STAGING, operatorAck: 'ack:' + '0'.repeat(16) + ':' + '0'.repeat(64) })).rejects.toThrow(/DIRTY TARGET refusal/);
      await expect(issueOperatorPreflight(db, { deployment: STAGING })).rejects.toThrow(/DIRTY TARGET refusal/);
      // attended resolution: operator repairs the DB (drops the sabotage),
      // resolves with a note; the resolution is an append-only event.
      await db.query(`DROP TRIGGER __sa3_fail_evidence ON public.schema_migration_evidence`);
      await db.query(`DROP FUNCTION public.__sa3_fail_evidence()`);
      await attendedResolveDirty(db, { note: 'operator reviewed the abort; evidence writer repaired', resolvedBy: 'test-operator' });
      const resolved = await db.query(`SELECT kind, report FROM public.schema_migration_evidence WHERE kind = 'dirty-resolved'`);
      expect(resolved.rows.length).toBe(1);
      expect(JSON.stringify(resolved.rows[0]!['report'])).toContain('invalidationFailure');
      // a FRESH issuance + run succeeds after resolution.
      const pf2 = await issueOperatorPreflight(db, { deployment: STAGING });
      const r = await runMigrations(db, { deployment: STAGING, operatorAck: operatorAckFor(pf2) });
      expect(r.appliedNow).toEqual(['0002', '0003']);
    } finally { await raw.close(); }
  });
  it('SA3 section 3: NO caller label relaxes the gate - deployment test/test-harness are refused without an issued ack exactly like staging', async () => {
    const raw = new PGlite(); const db = pgliteConnectable(raw);
    try {
      await expect(runMigrations(db, { deployment: 'test' })).rejects.toThrow('OPERATOR GATE refusal');
      const r1 = await db.query(`SELECT version FROM public.schema_migrations ORDER BY seq`);
      expect(r1.rows.map(x => x['version'])).toEqual(['0001']);
    } finally { await raw.close(); }
    const raw2 = new PGlite(); const db2 = pgliteConnectable(raw2);
    try {
      await expect(runMigrations(db2, { deployment: 'test-harness' })).rejects.toThrow('OPERATOR GATE refusal');
      const r2 = await db2.query(`SELECT version FROM public.schema_migrations ORDER BY seq`);
      expect(r2.rows.map(x => x['version'])).toEqual(['0001']);
      // ...and with an ISSUED ack the synthetic lane runs green (real path).
      const pf = await issueOperatorPreflight(db2, { deployment: 'test-harness' });
      const r = await runMigrations(db2, { deployment: 'test-harness', operatorAck: operatorAckFor(pf) });
      expect(r.appliedNow).toEqual(['0002', '0003']);
    } finally { await raw2.close(); }
  });
});
