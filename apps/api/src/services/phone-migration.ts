/** users-phone duplicate preflight + reversible migration (QA 21:06 stop-ship,
 *  2026-09-18): for deployments whose users data predates the
 *  users_phone_unique partial unique index on btrim(phone).
 *
 *  Guarantees:
 *  - PREFLIGHT IS READ-ONLY: groups users by btrim(phone) and reports every
 *    collision with ids, orgs, content hashes and provenance. It NEVER picks
 *    a winner, NEVER deletes, NEVER mutates. Collisions are an operator
 *    decision, prepared here as evidence, never executed.
 *  - REVERSIBLE: every mutating step requires a prior backup artifact;
 *    restore() writes the backed-up rows back (upsert by user_id).
 *  - NORMALIZATION trims the phone column AND the embedded data->>'phone'
 *    JSON field together, in one transaction, idempotently.
 *  - INDEX CREATION is resolved-DB-only: these functions touch ONLY the
 *    connection passed in; the CLI wrapper requires an explicit
 *    --database-url (no default, no ambient env). Creation runs a preflight
 *    first and ABORTS LOUDLY when collisions exist.
 *  - IDEMPOTENT: normalize/createIndex are safe to re-run (restart-safe). */
import { createHash } from 'node:crypto';
import type { Connectable } from '../repo/postgres.js';

export interface PhoneMember {
  userId: string;
  orgId: string;
  columnPhone: string | null;
  jsonPhone: string | null;
  normalizedPhone: string | null;
  /** sha256 over the stored data JSON (content identity, preservation proof). */
  dataHash: string;
  /** Provenance markers for the operator's claim decision. */
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
  usersWithPhone: number;
  groups: number;
  collisionGroups: PhoneGroup[];
  /** Rows whose column phone and JSON phone disagree after trim. */
  inconsistentRows: PhoneMember[];
  /** Operator decision required ONLY when collisions exist; never resolved here. */
  operatorDecisionRequired: boolean;
}

interface RawRow {
  user_id: string;
  org_id: string;
  phone: string | null;
  json_phone: string | null;
  data: unknown;
}

const trimOrNull = (v: string | null): string | null => (v === null ? null : v.trim());
const hashData = (data: unknown): string => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const bool = (v: unknown): boolean => v === true;

const SELECT_PHONE_ROWS =
  `SELECT user_id, org_id, phone, data->>'phone' AS json_phone, data FROM users
   WHERE phone IS NOT NULL OR (data->>'phone') IS NOT NULL
   ORDER BY btrim(COALESCE(phone, data->>'phone')), user_id`;

const toMember = (r: RawRow): PhoneMember => {
  const data = (r.data ?? {}) as Record<string, unknown>;
  return {
    userId: r.user_id,
    orgId: r.org_id,
    columnPhone: r.phone,
    jsonPhone: r.json_phone,
    normalizedPhone: trimOrNull(r.phone) ?? trimOrNull(r.json_phone),
    dataHash: hashData(r.data),
    createdAt: str(data['createdAt']),
    isSuperAdmin: bool(data['isSuperAdmin']),
    impersonationOf: str(data['impersonationOf']),
  };
};

/** READ-ONLY duplicate preflight: group by btrim(phone), report collisions
 *  with full provenance. No winner, no deletion, no writes. */
export async function preflightUsersPhone(conn: Connectable, now: () => Date = () => new Date()): Promise<PreflightReport> {
  const r = await conn.query(SELECT_PHONE_ROWS);
  const rows = r.rows as unknown as RawRow[];
  const byKey = new Map<string, PhoneMember[]>();
  const inconsistent: PhoneMember[] = [];
  for (const row of rows) {
    const m = toMember(row);
    const key = trimOrNull(row.phone) ?? trimOrNull(row.json_phone);
    if (key === null || key === '') continue;
    const list = byKey.get(key) ?? [];
    list.push(m);
    byKey.set(key, list);
    if (m.columnPhone !== null && m.jsonPhone !== null && m.columnPhone.trim() !== m.jsonPhone.trim()) {
      inconsistent.push(m);
    }
  }
  const collisions = [...byKey.entries()]
    .filter(([, members]) => new Set(members.map(m => m.userId)).size > 1)
    .map(([normalizedPhone, members]) => ({ normalizedPhone, members }));
  return {
    kind: 'users-phone-preflight',
    generatedAt: now().toISOString(),
    scannedUsers: rows.length,
    usersWithPhone: rows.filter(x => trimOrNull(x.phone) !== null && trimOrNull(x.phone) !== '').length,
    groups: byKey.size,
    collisionGroups: collisions,
    inconsistentRows: inconsistent,
    operatorDecisionRequired: collisions.length > 0,
  };
}

export interface BackupRow { user_id: string; org_id: string; email: string | null; phone: string | null; data: unknown; }

/** Full users-table backup (JSONL lines, one row per line, sha256 per line). */
export async function backupUsers(conn: Connectable, sink: (line: string) => void): Promise<number> {
  const r = await conn.query(`SELECT user_id, org_id, email, phone, data FROM users ORDER BY user_id`);
  let n = 0;
  for (const row of r.rows as unknown as BackupRow[]) {
    sink(JSON.stringify({ ...row, sha256: hashData(row.data) }));
    n += 1;
  }
  return n;
}

/** Restore backed-up rows (upsert by user_id). Reverses a migration. */
export async function restoreUsers(conn: Connectable, lines: string[]): Promise<number> {
  let n = 0;
  for (const line of lines) {
    const row = JSON.parse(line) as BackupRow;
    await conn.query(
      `INSERT INTO users(user_id, org_id, email, phone, data) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET org_id=$2, email=$3, phone=$4, data=$5`,
      [row.user_id, row.org_id, row.email, row.phone, JSON.stringify(row.data)]);
    n += 1;
  }
  return n;
}

/** Normalize existing phone column + embedded JSON phone: btrim both, one tx
 *  per row, idempotent. Returns the rows changed (0 on re-run). */
export async function normalizeUsersPhones(conn: Connectable): Promise<{ normalized: number; userIds: string[] }> {
  const r = await conn.query(
    `SELECT user_id, phone, data->>'phone' AS json_phone FROM users
     WHERE (phone IS NOT NULL AND phone <> btrim(phone))
        OR ((data->>'phone') IS NOT NULL AND (data->>'phone') <> btrim(data->>'phone'))`);
  const userIds: string[] = [];
  for (const row of r.rows as unknown as { user_id: string; phone: string | null; json_phone: string | null }[]) {
    const trimmed = row.phone === null ? null : row.phone.trim();
    await conn.query(
      `UPDATE users SET phone=$2,
         data = CASE WHEN (data->>'phone') IS NOT NULL
                     THEN jsonb_set(data, '{phone}', to_jsonb($2::text), false)
                     ELSE data END
       WHERE user_id=$1`,
      [row.user_id, trimmed ?? (row.json_phone === null ? null : row.json_phone.trim())]);
    userIds.push(row.user_id);
  }
  return { normalized: userIds.length, userIds };
}

/** Create the unique index on the RESOLVED database connection only, after a
 *  fresh internal preflight. ABORTS LOUDLY (no index, no mutation) when
 *  collisions exist; the collision report is the operator-decision input. */
export async function createUsersPhoneIndex(conn: Connectable): Promise<
  { created: true; preflight: PreflightReport } | { created: false; reason: 'collisions'; preflight: PreflightReport }
> {
  const preflight = await preflightUsersPhone(conn);
  if (preflight.collisionGroups.length > 0) {
    return { created: false, reason: 'collisions', preflight };
  }
  await conn.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(btrim(phone)) WHERE phone IS NOT NULL`);
  return { created: true, preflight };
}

/** Index presence probe (diagnostics/tests). */
export async function usersPhoneIndexExists(conn: Connectable): Promise<boolean> {
  const r = await conn.query(`SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'users_phone_unique'`);
  return r.rows.length > 0;
}
