/** users-phone duplicate preflight + reversible migration (QA 21:06 stop-ship,
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
 *  - DURABLE CLI PUBLICATION: temp-write with restrictive (0600)
 *    permissions, fsync, atomic rename, then independent readback
 *    validation (full artifact validation + MAC) before reporting
 *    success. No partial publication: a failed backup leaves no final
 *    file. Existing files are never overwritten without --overwrite-backup.
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
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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

/** Deterministic canonical JSON: object keys sorted recursively, so digests
 *  are stable across JSONB round-trips (jsonb reorders keys). */
const canonical = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
};
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** sha256 over the CANONICAL full row: user_id, org_id, email, phone, data. */
export const rowDigest = (r: { user_id: string; org_id: string; email: string | null; phone: string | null; data: unknown }): string =>
  sha256(canonical({ user_id: r.user_id, org_id: r.org_id, email: r.email, phone: r.phone, data: r.data }));

/** sha256 binding the header (type/version/createdAt/rowCount/index state)
 *  AND the ordered row digest set: any header, order, or membership change
 *  without a recomputed manifest is detected. */
export const manifestDigest = (
  h: { type: string; version: number; createdAt: string; rowCount: number; usersPhoneUniqueIndex: { existed: boolean; definition: string | null } },
  orderedRowDigests: string[],
): string => sha256(canonical({
  type: h.type, version: h.version, createdAt: h.createdAt, rowCount: h.rowCount,
  usersPhoneUniqueIndex: h.usersPhoneUniqueIndex, rowDigests: orderedRowDigests,
}));

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

/** External MAC credentials for artifact authentication. The KEY ITSELF
 *  comes ONLY from managed secrets (vault / secret-manager env): never
 *  committed, never passed via argv, never stored inside the artifact.
 *  keyId identifies the key VERSION (rotation); env binds the artifact to
 *  one environment/domain (cross-env replay is refused). */
export interface ArtifactAuth {
  key: string | Buffer;
  keyId: string;
  env: string;
}

const requireAuth = (auth: ArtifactAuth | undefined): ArtifactAuth => {
  if (!auth || (typeof auth.key === 'string' ? auth.key.length === 0 : auth.key.length === 0) || !auth.keyId || !auth.env) {
    throw new Error('artifact auth: external MAC key, keyId and env are REQUIRED (key from managed secrets only - never committed, never argv, never stored in the artifact)');
  }
  return auth;
};

/** HMAC-SHA256 over the FULL canonical artifact content: the header
 *  without its MAC field plus every row line, in order. */
export const artifactMac = (key: string | Buffer, headerSansMac: Record<string, unknown>, rows: Record<string, unknown>[]): string =>
  createHmac('sha256', key).update(canonical({ header: headerSansMac, rows })).digest('hex');
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

export interface BackupRow { user_id: string; org_id: string; email: string | null; phone: string | null; data: unknown; }
export interface BackupHeader {
  type: 'users-phone-backup-header';
  version: 2;
  createdAt: string;
  rowCount: number;
  /** Index state at backup time. `definition` is EVIDENCE ONLY - never
   *  executed; restore recreates CANONICAL_INDEX_SQL and refuses artifacts
   *  whose evidence is not the canonical shape (closed schema). */
  usersPhoneUniqueIndex: { existed: boolean; definition: string | null };
  /** sha256 manifest binding header + index state + ordered row digests. */
  manifestSha256: string;
  /** Key VERSION id (rotation) - not the key itself. */
  keyId: string;
  /** Environment/domain binding (cross-env replay refused). */
  env: string;
  /** HMAC-SHA256 over the full canonical artifact (external key). */
  macSha256: string;
}

const indexState = async (c: { query: Connectable['query'] }): Promise<{ existed: boolean; definition: string | null }> => {
  const r = await c.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'users_phone_unique'`);
  const def = r.rows[0]?.['indexdef'] as string | undefined;
  return { existed: def !== undefined, definition: def ?? null };
};

/** Full AUTHENTICATED backup on ONE leased connection: BEGIN ISOLATION
 *  LEVEL REPEATABLE READ, then the ONE documented lock order (advisory
 *  FIRST, then LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE) so rows +
 *  index state are a consistent snapshot and concurrent row/schema
 *  mutation BLOCKS for the backup's duration. Emits a v2 header (row
 *  count, index state as existence + evidence, manifest, keyId, env, MAC)
 *  then every users row as JSONL with a canonical full-row digest. */
export async function backupUsers(conn: Connectable, sink: (line: string) => void, opts: { now?: () => Date; auth: ArtifactAuth }): Promise<number> {
  const auth = requireAuth(opts.auth);
  const now = opts.now ?? (() => new Date());
  return withTx(conn, async c => {
    await c.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`); // 1st: advisory
    await c.query(`LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`); // 2nd: table (blocks row AND schema mutation)
    const r = await c.query(`SELECT user_id, org_id, email, phone, data FROM users ORDER BY user_id`);
    const rows = r.rows as unknown as BackupRow[];
    const digests = rows.map(rowDigest);
    const base = {
      type: 'users-phone-backup-header' as const, version: 2 as const, createdAt: now().toISOString(),
      rowCount: rows.length, usersPhoneUniqueIndex: await indexState(c),
    };
    const headerSansMac = { ...base, manifestSha256: manifestDigest(base, digests), keyId: auth.keyId, env: auth.env };
    const rowLines = rows.map((row, i) => ({ ...row, rowSha256: digests[i]! }));
    const header: BackupHeader = { ...headerSansMac, macSha256: artifactMac(auth.key, headerSansMac, rowLines) };
    sink(JSON.stringify(header));
    for (const rl of rowLines) sink(JSON.stringify(rl));
    return rows.length;
  }, 'BEGIN ISOLATION LEVEL REPEATABLE READ');
}

interface ValidatedArtifact {
  header: BackupHeader;
  rows: (BackupRow & { rowSha256: string })[];
}

/** Validate the FULL backup artifact BEFORE any mutation (security
 *  2026-09-18): header type/version, rowCount == actual rows, unique user
 *  ids, required fields, and every row's sha256 against its data. ANY
 *  violation refuses the restore - nothing is ever written. */
export function validateBackupArtifact(lines: string[], auth: ArtifactAuth): ValidatedArtifact {
  const parsed = lines.filter(l => l.trim() !== '').map((l, i) => {
    try { return JSON.parse(l) as Record<string, unknown>; }
    catch { throw new Error(`restore: line ${i + 1} is not valid JSON`); }
  });
  const header = parsed[0] as unknown as BackupHeader | undefined;
  if (!header || header.type !== 'users-phone-backup-header') throw new Error('restore: first line is not a users-phone backup header');
  if (header.version !== 2) throw new Error(`restore: unsupported backup version ${String(header.version)}`);
  // AUTHENTICATION FIRST (QA/security 2026-09-18): unsigned artifacts,
  // key-version mismatches, cross-environment replays and any
  // rehashed-but-unkeyed substitution are refused before anything else.
  if (typeof header.keyId !== 'string' || typeof header.env !== 'string' ||
      typeof header.macSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(header.macSha256)) {
    throw new Error('restore: unsigned artifact (missing keyId/env/macSha256) - refused');
  }
  requireAuth(auth);
  if (header.keyId !== auth.keyId) throw new Error(`restore: key version mismatch (artifact keyId "${header.keyId}" != provided "${auth.keyId}")`);
  if (header.env !== auth.env) throw new Error(`restore: cross-environment replay refused (artifact env "${header.env}" != provided "${auth.env}")`);
  const rowsForMac = parsed.slice(1) as Record<string, unknown>[];
  const { macSha256, ...headerSansMac } = header as unknown as Record<string, unknown> & { macSha256: string };
  const expected = artifactMac(auth.key, headerSansMac, rowsForMac);
  const macA = Buffer.from(expected, 'utf8'); const macB = Buffer.from(macSha256, 'utf8');
  if (macA.length !== macB.length || !timingSafeEqual(macA, macB)) throw new Error('restore: artifact MAC mismatch - wrong key or tampered artifact');
  if (typeof header.rowCount !== 'number' || header.rowCount < 0) throw new Error('restore: header rowCount missing/invalid');
  if (typeof header.usersPhoneUniqueIndex?.existed !== 'boolean') throw new Error('restore: header index state missing/invalid');
  if (header.usersPhoneUniqueIndex.existed && typeof header.usersPhoneUniqueIndex.definition !== 'string') {
    throw new Error('restore: header index evidence definition missing for an existed=true backup');
  }
  if (header.usersPhoneUniqueIndex.existed &&
      normalizeIndexDef(header.usersPhoneUniqueIndex.definition as string) !== CANONICAL_INDEX_NORMALIZED) {
    throw new Error('restore: non-canonical index definition in artifact (appended SQL / different expression, predicate, table, or schema) - closed schema refuses unknown index shapes; artifact SQL is NEVER executed');
  }
  if (typeof (header as { manifestSha256?: unknown }).manifestSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test((header as { manifestSha256?: string }).manifestSha256!)) {
    throw new Error('restore: header manifestSha256 missing/invalid');
  }
  const rows = parsed.slice(1) as unknown as (BackupRow & { rowSha256?: string })[];
  if (rows.length !== header.rowCount) {
    throw new Error(`restore: header rowCount ${header.rowCount} != actual rows ${rows.length} (truncated or tampered artifact)`);
  }
  const seen = new Set<string>();
  for (const [i, row] of rows.entries()) {
    if (typeof row.user_id !== 'string' || row.user_id === '') throw new Error(`restore: row ${i + 1} missing user_id`);
    if (seen.has(row.user_id)) throw new Error(`restore: duplicate user_id "${row.user_id}" in artifact`);
    seen.add(row.user_id);
    if (typeof row.org_id !== 'string' || row.org_id === '') throw new Error(`restore: row ${i + 1} (${row.user_id}) missing org_id`);
    if (row.email !== null && typeof row.email !== 'string') throw new Error(`restore: row ${i + 1} (${row.user_id}) email must be string|null`);
    if (row.phone !== null && typeof row.phone !== 'string') throw new Error(`restore: row ${i + 1} (${row.user_id}) phone must be string|null`);
    if (typeof row.data !== 'object' || row.data === null) throw new Error(`restore: row ${i + 1} (${row.user_id}) missing data object`);
    if (typeof row.rowSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.rowSha256)) throw new Error(`restore: row ${i + 1} (${row.user_id}) missing rowSha256`);
    if (rowDigest(row as BackupRow) !== row.rowSha256) throw new Error(`restore: row ${i + 1} (${row.user_id}) row digest mismatch - tampered or corrupt artifact (canonical full-row digest over user_id/org_id/email/phone/data)`);
  }
  const { manifestSha256, ...base } = header;
  if (manifestDigest(base, rows.map(r => (r as unknown as { rowSha256: string }).rowSha256)) !== manifestSha256) {
    throw new Error('restore: manifest digest mismatch - header, index state, row order, or row set tampered');
  }
  return { header, rows: rows as unknown as (BackupRow & { rowSha256: string })[] };
}

export interface RestoreResult {
  restoredRows: number;
  /** FULL-RESTORE contract: rows present in the database but NOT in the
   *  artifact are post-backup creations - removed EXPLICITLY and reported. */
  removedPostBackupRows: string[];
  indexRestored: boolean;
  verified: true;
}

/** FULL RESTORE (security 2026-09-18): validates the whole artifact BEFORE
 *  any mutation, then performs schema + rows + post-backup row policy +
 *  exact index definition + final verification in ONE transaction; ANY
 *  mismatch rolls back everything.
 *  - backup had no index: the current index is dropped INSIDE the
 *    transaction BEFORE rows are written, so colliding artifact rows load.
 *  - backup had an index: dropped, then recreated from the EXACT stored
 *    definition after rows are in place.
 *  - final verification inside the tx: exact row count, exact id set, and
 *    per-row org_id/email/phone/data-sha256 against the artifact, plus the
 *    index definition/absence. */
export async function restoreUsers(conn: Connectable, lines: string[], auth: ArtifactAuth): Promise<RestoreResult> {
  const { header, rows } = validateBackupArtifact(lines, auth); // BEFORE any mutation
  const artifactIds = new Set(rows.map(r => r.user_id));
  return withTx(conn, async c => {
    // ONE documented lock order (security 2026-09-18): advisory FIRST...
    await c.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
    // ...then the table lock: real write exclusion (blocks app writers)
    await c.query(`LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`);
    // schema first: make the target state reachable
    await c.query(`DROP INDEX IF EXISTS users_phone_unique`); // before colliding rows load
    for (const row of rows) {
      await c.query(
        `INSERT INTO users(user_id, org_id, email, phone, data) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (user_id) DO UPDATE SET org_id=$2, email=$3, phone=$4, data=$5`,
        [row.user_id, row.org_id, row.email, row.phone, JSON.stringify(row.data)]);
    }
    // explicit post-backup row policy (full restore): remove + report
    const cur = await c.query(`SELECT user_id FROM users`);
    const extra = (cur.rows as { user_id: string }[]).map(x => x.user_id).filter(id => !artifactIds.has(id));
    for (const id of extra) {
      await c.query(`DELETE FROM users WHERE user_id=$1`, [id]);
    }
    // index recreate: ONLY the hardcoded canonical statement - artifact
    // SQL is NEVER executed (security 2026-09-18)
    if (header.usersPhoneUniqueIndex.existed) {
      await c.query(CANONICAL_INDEX_SQL);
    }
    // ---- final verification INSIDE the transaction ----
    const all = await c.query(`SELECT user_id, org_id, email, phone, data FROM users ORDER BY user_id`);
    const dbRows = all.rows as unknown as BackupRow[];
    if (dbRows.length !== rows.length) throw new Error(`restore verify: count ${dbRows.length} != artifact ${rows.length}`);
    const byId = new Map(rows.map(r => [r.user_id, r] as const));
    for (const d of dbRows) {
      const a = byId.get(d.user_id);
      if (!a) throw new Error(`restore verify: unexpected id ${d.user_id}`);
      if (d.org_id !== a.org_id || d.email !== a.email || d.phone !== a.phone) {
        throw new Error(`restore verify: column mismatch for ${d.user_id}`);
      }
      if (rowDigest(d) !== a.rowSha256) throw new Error(`restore verify: full-row digest mismatch for ${d.user_id}`);
    }
    const idx = await indexState(c);
    if (header.usersPhoneUniqueIndex.existed) {
      if (!idx.existed) throw new Error('restore verify: index missing after recreate');
      if (normalizeIndexDef(idx.definition as string) !== CANONICAL_INDEX_NORMALIZED) {
        throw new Error(`restore verify: live index definition is not the canonical shape (got ${idx.definition ?? 'null'})`);
      }
    } else if (idx.existed) {
      throw new Error('restore verify: index present after verified drop');
    }
    return { restoredRows: rows.length, removedPostBackupRows: extra.sort(), indexRestored: header.usersPhoneUniqueIndex.existed, verified: true as const };
  });
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
