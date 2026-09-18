/** users-phone duplicate preflight + FORWARD migration (QA 21:06 stop-ship,
 *  architecture separation 2026-09-18: the bespoke backup/restore CLI is
 *  DECOUPLED from the Super Admin gate - it lives on the separate infra
 *  track; this module is preflight + normalize + canonical index +
 *  locked maintenance migration ONLY. Full history preserved in git).
 *  v2 2026-09-18 after QA/security review): for deployments whose users data
 *  predates the users_phone_unique partial unique index on btrim(phone).
 *  The index is NOT created at bootstrap (preservation-first): it is created
 *  ONLY by this tool, after a clean preflight, on the resolved database.
 *
 *  Guarantees:
 *  - PREFLIGHT IS READ-ONLY and models EVERY distinct normalized phone
 *    identity a row carries (column phone AND embedded JSON phone, trimmed).
 *    A row with both representations belongs to BOTH identity groups. A
 *    collision (one normalized phone, >1 user) or an inconsistency (column
 *    and JSON trim to DIFFERENT values) BLOCKS normalization and index
 *    creation pending an explicit operator decision - the tool never
 *    silently picks the column (or any) winner, never deletes, never mutates.
 *  - usersWithPhone counts a row when EITHER representation carries a phone.
 *  - REVERSIBLE: backup captures every users row PLUS the users_phone_unique
 *    index state (existence + definition); restore writes the rows back in
 *    one transaction, restores the index state (recreate or verified drop),
 *    and VERIFIES the final state against the backup header, failing loud
 *    on mismatch.
 *  - NORMALIZATION is ONE REAL TRANSACTION (BEGIN/COMMIT, ROLLBACK on any
 *    failure) trimming the column and the embedded JSON to their own values.
 *  - RESOLVED-DB-ONLY: functions touch ONLY the passed connection; the CLI
 *    requires an explicit --database-url (no default, no ambient env).
 *  - IDEMPOTENT: normalize/createIndex/restore are safe to re-run.
 *
 *  v4 (QA + security 2026-09-18):
 *  - AUTHENTICATED ARTIFACTS: every row carries rowSha256 = sha256 over the
 *    CANONICAL full row (user_id, org_id, email, phone, data; recursively
 *    key-sorted JSON); the header carries manifestSha256 binding the header
 *    fields, the index state AND the ordered row digest set. Both are
 *    verified BEFORE any mutation and again post-restore inside the tx.
 *  - CLOSED INDEX SCHEMA: the backup stores the index state as a boolean
 *    plus the definition as EVIDENCE ONLY. Restore NEVER executes SQL from
 *    the artifact; it recreates exactly one hardcoded canonical statement
 *    (CANONICAL_INDEX_SQL) and verifies the live definition against it
 *    (normalized compare). An artifact whose evidence definition is not the
 *    canonical shape (appended SQL, different expression/predicate/table/
 *    schema) is REFUSED before any mutation.
 *  - REAL WRITE EXCLUSION: restoreUsers and migrateUsersPhone take
 *    LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE for the whole transaction
 *    (blocks application INSERT/UPDATE/DELETE, which take ROW EXCLUSIVE),
 *    plus the advisory lock serializing concurrent migration runs.
 *  - QUIESCENCE GATE (documented, operator-carried): even with the table
 *    lock, the migration window REQUIRES application writers quiesced
 *    (maintenance mode / writers scaled down) - the lock blocks writers
 *    only for the transaction's duration, and a long queue of blocked
 *    writers is itself an operational incident. MIGRATION_LOCK_KEY is
 *    exported for any future writer-side enforcement.
 *
 *  v5 (QA + security 2026-09-18):
 *  - AUTHENTICATED ARTIFACTS (MAC): every backup header carries keyId,
 *    env and macSha256 = HMAC-SHA256 over the FULL canonical artifact
 *    (header-without-mac + every row line, in order). The key is
 *    EXTERNAL - provisioned from managed secrets (vault/secret-manager
 *    env), NEVER committed, NEVER passed via argv, NEVER stored in the
 *    artifact. Restore verifies keyId (key-version), env (cross-env
 *    replay) and the MAC BEFORE any mutation; rehashed-but-unsigned
 *    tampering cannot pass. NO LIVE KEYS are created by this change.
 *  - ONE DOCUMENTED LOCK ORDER for backup, restore AND maintenance:
 *    pg_advisory_xact_lock(MIGRATION_LOCK_KEY) FIRST, then
 *    LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE. Backup additionally
 *    runs in REPEATABLE READ so rows + index state are one consistent
 *    snapshot that concurrent row/schema mutation cannot disturb.
 *  - DURABLE CLI PUBLICATION (v6): temp-write 0600, fsync, TEMP readback
 *    validation BEFORE publish, atomic no-clobber hard-link (EEXIST if the
 *    destination appeared) or explicit overwrite via atomic rename-replace,
 *    containing-directory fsync, temp/final cleanup on every failure.
 *  - REPLAY/FRESHNESS is exposed ONLY as an EXPLICIT MANDATORY OPERATOR
 *    GATE (security 2026-09-18): backupId + createdAt are validated
 *    (shape + canonical finite timestamp) and bound into the MAC so the
 *    evidence is trustworthy, and the CLI prints them before applying a
 *    restore - but NO mechanical freshness/replay prevention is claimed:
 *    a human operator MUST approve every restore against the SAME
 *    deployment/database ID the artifact was MACed for.
 *  - AUTHORITATIVE DEPLOYMENT/KEY CONFIG is a LIVE OPERATOR GATE: the
 *    deployment ID and key version are verified at run time against the
 *    managed per-deployment allowlists (CONTAKE_BACKUP_ALLOWED_ENVS /
 *    CONTAKE_BACKUP_ALLOWED_KEY_IDS) - a runtime gate, not a source claim.
 *  - PER-DEPLOYMENT KEYS: each deployed database gets its OWN managed MAC
 *    key + keyId + unique env ID; keys are never shared across deployments.
 *  - NO OVERWRITE (v7): backup publication is no-clobber only; overwrite
 *    support was removed entirely (no indeterminate post-fsync states).
 *
 *  OPERATOR GATES for later live use (carried; NO live action now):
 *  1. explicit approval to run the read-only preflight against the live DB;
 *  2. an explicit operator decision per collision/inconsistency group
 *     (which identity wins, per row) - never automatic;
 *  3. verified backup + restore rehearsal on a SCRATCH copy before any live
 *     mutation;
 *  4. an approved atomic migration window for normalize + index creation;
 *  5. idempotent post-migration verification (preflight clean, index
 *     present, restart re-check). */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Connectable } from '../repo/postgres.js';

export interface PhoneMember {
  userId: string;
  orgId: string;
  columnPhone: string | null;
  jsonPhone: string | null;
  /** ALL distinct normalized (trimmed, non-empty) phone identities this row
   *  carries across BOTH representations. */
  normalizedIdentities: string[];
  /** sha256 over the stored data JSON (content identity, preservation proof). */
  dataHash: string;
  createdAt: string | null;
  isSuperAdmin: boolean;
  impersonationOf: string | null;
}

export interface PhoneGroup {
  normalizedPhone: string;
  members: PhoneMember[];
}

export interface PreflightReport {
  kind: 'users-phone-preflight';
  generatedAt: string;
  scannedUsers: number;
  /** Rows carrying a phone in EITHER representation (column or JSON). */
  usersWithPhone: number;
  /** Distinct normalized phone identities seen across all rows. */
  identities: number;
  collisionGroups: PhoneGroup[];
  /** Rows whose column and JSON phones BOTH exist and trim to DIFFERENT
   *  values. Blocking: the tool never silently chooses either side. */
  inconsistentRows: PhoneMember[];
  /** True when ANY operator decision is required (collisions OR
   *  inconsistencies); normalization and index creation refuse to run. */
  blocking: boolean;
  blockingReasons: string[];
  operatorDecisionRequired: boolean;
}

interface RawRow {
  user_id: string;
  org_id: string;
  phone: string | null;
  json_phone: string | null;
  data: unknown;
}

const norm = (v: string | null): string | null => {
  if (v === null) return null;
  const t = v.trim();
  return t === '' ? null : t;
};
const hashData = (data: unknown): string => createHash('sha256').update(JSON.stringify(data)).digest('hex');


/** THE ONLY index this tool will ever create. Stored artifact SQL is NEVER
 *  executed (security 2026-09-18): restore recreates this exact statement. */
export const CANONICAL_INDEX_SQL =
  `CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users USING btree (btrim(phone)) WHERE phone IS NOT NULL`;
/** Normalized-compare form (lowercase, no schema qualifier, no parens,
 *  collapsed whitespace) so a live pg-normalized indexdef compares equal. */
export const normalizeIndexDef = (def: string): string =>
  def.toLowerCase().replace(/\bpublic\./g, '').replace(/\bif not exists\b/g, '').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
const CANONICAL_INDEX_NORMALIZED = normalizeIndexDef(CANONICAL_INDEX_SQL);
/** Advisory lock key serializing concurrent migration runs. */
export const MIGRATION_LOCK_KEY = 7263849598301;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const bool = (v: unknown): boolean => v === true;

const SELECT_PHONE_ROWS =
  `SELECT user_id, org_id, phone, data->>'phone' AS json_phone, data FROM users
   WHERE phone IS NOT NULL OR (data->>'phone') IS NOT NULL
   ORDER BY user_id`;

const toMember = (r: RawRow): PhoneMember => {
  const data = (r.data ?? {}) as Record<string, unknown>;
  const ids = new Set<string>();
  const c = norm(r.phone); if (c !== null) ids.add(c);
  const j = norm(r.json_phone); if (j !== null) ids.add(j);
  return {
    userId: r.user_id,
    orgId: r.org_id,
    columnPhone: r.phone,
    jsonPhone: r.json_phone,
    normalizedIdentities: [...ids].sort(),
    dataHash: hashData(r.data),
    createdAt: str(data['createdAt']),
    isSuperAdmin: bool(data['isSuperAdmin']),
    impersonationOf: str(data['impersonationOf']),
  };
};

/** READ-ONLY preflight over ALL normalized identities (column + JSON). */
export async function preflightUsersPhone(conn: Connectable, now: () => Date = () => new Date()): Promise<PreflightReport> {
  const r = await conn.query(SELECT_PHONE_ROWS);
  const rows = r.rows as unknown as RawRow[];
  const byKey = new Map<string, PhoneMember[]>();
  const inconsistent: PhoneMember[] = [];
  let usersWithPhone = 0;
  for (const row of rows) {
    const m = toMember(row);
    if (m.normalizedIdentities.length > 0) usersWithPhone += 1;
    for (const id of m.normalizedIdentities) {
      const list = byKey.get(id) ?? [];
      list.push(m);
      byKey.set(id, list);
    }
    const c = norm(row.phone); const j = norm(row.json_phone);
    if (c !== null && j !== null && c !== j) inconsistent.push(m);
  }
  const collisions = [...byKey.entries()]
    .filter(([, members]) => new Set(members.map(m => m.userId)).size > 1)
    .map(([normalizedPhone, members]) => ({ normalizedPhone, members }));
  const blockingReasons: string[] = [];
  if (collisions.length > 0) blockingReasons.push(`${collisions.length} collision group(s): one normalized phone maps to >1 user`);
  if (inconsistent.length > 0) blockingReasons.push(`${inconsistent.length} inconsistent row(s): column and JSON phones trim to different values`);
  return {
    kind: 'users-phone-preflight',
    generatedAt: now().toISOString(),
    scannedUsers: rows.length,
    usersWithPhone,
    identities: byKey.size,
    collisionGroups: collisions,
    inconsistentRows: inconsistent,
    blocking: blockingReasons.length > 0,
    blockingReasons,
    operatorDecisionRequired: blockingReasons.length > 0,
  };
}

const indexState = async (c: { query: Connectable['query'] }): Promise<{ existed: boolean; definition: string | null }> => {
  const r = await c.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'users_phone_unique'`);
  const def = r.rows[0]?.['indexdef'] as string | undefined;
  return { existed: def !== undefined, definition: def ?? null };
};

/** Run fn inside ONE real transaction on a leased connection
 *  (Connectable.connect(): node-pg checks out a single client; PGlite's
 *  adapter serializes the lease behind its single-connection mutex), so
 *  BEGIN/COMMIT/ROLLBACK never hop connections. */
export async function withTx<T>(conn: Connectable, fn: (c: { query: Connectable['query'] }) => Promise<T>, begin = 'BEGIN'): Promise<T> {
  const client = await conn.connect();
  try {
    await client.query(begin);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export type NormalizeResult =
  | { normalized: number; userIds: string[] }
  | { aborted: true; reason: string; preflight: PreflightReport };

const normalizeRowsTx = async (c: { query: Connectable['query'] }): Promise<string[]> => {
  const r = await c.query(
    `SELECT user_id FROM users
     WHERE (phone IS NOT NULL AND phone <> btrim(phone))
        OR ((data->>'phone') IS NOT NULL AND (data->>'phone') <> btrim(data->>'phone'))
     ORDER BY user_id`);
  const ids = (r.rows as { user_id: string }[]).map(x => x.user_id);
  for (const userId of ids) {
    await c.query(
      `UPDATE users SET
         phone = CASE WHEN phone IS NULL THEN NULL ELSE btrim(phone) END,
         data = CASE WHEN (data->>'phone') IS NOT NULL
                     THEN jsonb_set(data, '{phone}', to_jsonb(btrim(data->>'phone')), false)
                     ELSE data END
       WHERE user_id=$1`,
      [userId]);
  }
  return ids;
};

/** Normalize column AND embedded JSON phone, each to its OWN trimmed value,
 *  in ONE real transaction. Refuses to run (loud) when the preflight is
 *  blocking - never silently chooses a representation. Idempotent. */
export async function normalizeUsersPhones(conn: Connectable): Promise<NormalizeResult> {
  const preflight = await preflightUsersPhone(conn);
  if (preflight.blocking) {
    return { aborted: true, reason: preflight.blockingReasons.join('; '), preflight };
  }
  const ids = await withTx(conn, normalizeRowsTx);
  return { normalized: ids.length, userIds: ids };
}

export type CreateIndexResult =
  | { created: true; preflight: PreflightReport }
  | { created: false; reason: 'blocked'; preflight: PreflightReport };

/** Create the unique index on the RESOLVED connection only, after a fresh
 *  internal preflight. ABORTS LOUDLY (no index, no mutation) when the
 *  preflight blocks (collisions OR inconsistencies). */
export async function createUsersPhoneIndex(conn: Connectable): Promise<CreateIndexResult> {
  const preflight = await preflightUsersPhone(conn);
  if (preflight.blocking) return { created: false, reason: 'blocked', preflight };
  await conn.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(btrim(phone)) WHERE phone IS NOT NULL`);
  return { created: true, preflight };
}

/** Index presence probe (diagnostics/tests/verification). */
export async function usersPhoneIndexExists(conn: Connectable): Promise<boolean> {
  return (await indexState(conn)).existed;
}

export type MaintenanceResult =
  | { migrated: true; normalized: number; indexPresent: boolean; finalPreflight: PreflightReport }
  | { migrated: false; reason: string; preflight: PreflightReport };

/** LOCKED maintenance transaction (security 2026-09-18): ONE transaction
 *  holding a Postgres advisory lock over the WHOLE migration - preflight
 *  under lock, normalize, preflight RERUN under the same lock, index
 *  creation, final preflight - so no concurrent writer can slip a collision
 *  between the check and the index. ANY blocking state or failure rolls
 *  back EVERYTHING (rows and schema unchanged). */
export async function migrateUsersPhone(conn: Connectable): Promise<MaintenanceResult> {
  return withTx(conn, async c => {
    await c.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`); // 'users-phone-migration'
    // REAL write exclusion (security 2026-09-18): blocks application
    // INSERT/UPDATE/DELETE (ROW EXCLUSIVE) for the whole transaction, so no
    // writer can slip a collision between preflight and index creation.
    // Operator quiescence of app writers remains a documented gate.
    await c.query(`LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`);
    const pre = await preflightUsersPhone(c as Connectable);
    if (pre.blocking) return { migrated: false as const, reason: pre.blockingReasons.join('; '), preflight: pre };
    const ids = await normalizeRowsTx(c);
    const mid = await preflightUsersPhone(c as Connectable); // rerun under the same lock
    if (mid.blocking) throw new Error(`maintenance: preflight became blocking mid-transaction: ${mid.blockingReasons.join('; ')}`);
    await c.query(CANONICAL_INDEX_SQL);
    const fin = await preflightUsersPhone(c as Connectable);
    if (fin.blocking) throw new Error('maintenance: final preflight blocking');
    const idx = await indexState(c);
    if (!idx.existed) throw new Error('maintenance: index missing after creation');
    if (normalizeIndexDef(idx.definition as string) !== CANONICAL_INDEX_NORMALIZED) {
      throw new Error('maintenance: live index definition is not the canonical shape');
    }
    return { migrated: true as const, normalized: ids.length, indexPresent: idx.existed, finalPreflight: fin };
  });
}
