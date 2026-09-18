/** Release-migration runner (architecture convergence 2026-09-18; unified
 *  declarative redesign after QA FAILs of f9854cd6/9182487e/22267edb and the
 *  security verdicts + TL reconciliation of 2026-09-18).
 *
 *  ONE shared runner owns ALL schema evolution:
 *  - DECLARATIVE SQL ARTIFACTS ONLY. A migration is frozen TEXT: { version,
 *    name, description, sql } plus runner-owned declarative guard primitives.
 *    There are NO function steps, NO DO/CALL/PLpgSQL, NO arbitrary raw-query
 *    capability anywhere in the framework - code execution inside migrations
 *    is not a feature that exists.
 *  - EXACT EXECUTED+HASHED BINDING. The digest hashes the artifact text; the
 *    ONLY statements executed are the parse of that exact text (nothing else
 *    can be in it - trailing garbage fails the parse). Execution runs the
 *    parsed statements of the hashed text, one per driver call.
 *  - REAL-PARSER AST ALLOWLIST (not regex). Every artifact parses with a real
 *    PostgreSQL parser (pgsql-ast-parser); only declarative DDL+DML statement
 *    types are permitted (create/alter/drop table+index, comment, insert,
 *    update, delete). Transaction control, SELECT/CALL/DO, session advisory
 *    functions and anything unparseable (SAVEPOINT/SET/LOCK syntax) are
 *    rejected at registration - quoting, schema-qualification and comment
 *    tricks resolve to the same AST and cannot bypass it.
 *  - RUNNER-OWNED GUARD PRIMITIVES (TL reconciliation): assertions (named
 *    zero-row SELECT guards that HARD-FAIL inside the runner transaction),
 *    table locks, and the xact advisory lock are declared as structured step
 *    fields and executed BY THE RUNNER - they never live in migration text.
 *  - PER-STEP TRANSACTION on ONE leased client: BEGIN, primitives, artifact
 *    statements, version INSERT (rowCount must be exactly 1), COMMIT; any
 *    failure rolls the whole step back. Partial DDL can never persist.
 *  - WHOLE-RUN SERIALIZATION: one session-level pg_advisory_lock held on the
 *    leased client across bootstrap + every step; concurrent runners
 *    serialize and the loser no-ops.
 *  - APPLIED-STEP INTEGRITY: schema_migrations stores version+name+sha256
 *    (digest over the exact artifact + declared primitives). Runner and boot
 *    gate require exact equality for every applied step. NEVER edit a shipped
 *    migration - a change is a new version.
 *  - PRE-MUTATION TARGET BINDING: verifyTargetPreconditions (deployment label
 *    + optional instance pin) runs read-only BEFORE any write; the first-run
 *    stamp is an operator-attended TOFU gate, never authentication.
 *  - BOOT GATE: assertSchemaCurrent fails closed unless version sequence,
 *    digests and (when provided) deployment + instance identity match.
 *  - ROLE SEPARATION (Neon dual-URL): direct schema-owner endpoint only;
 *    '-pooler' hosts are refused. */
import { createHash, randomBytes } from 'node:crypto';
import { parse as parseSql, toSql } from 'pgsql-ast-parser';
import { GRAPH_DDL, OTP_DDL, type Connectable, type Queryable } from '../repo/postgres.js';

/** A runner-owned NAMED guard primitive (independent security, 2026-09-18):
 *  NO caller SQL anywhere - the guard's SQL is generated entirely by the
 *  runner from validated identifiers and closed operator sets. Callers pick a
 *  kind and name tables/columns; expressions, functions and subqueries are
 *  not representable, so no side-effecting call can ride in. Each guard must
 *  return NO rows; any returned row hard-fails the step (full rollback). */
export type MigrationAssertion =
  | { readonly kind: 'table-empty'; readonly table: string }
  | { readonly kind: 'no-nulls'; readonly table: string; readonly column: string }
  | { readonly kind: 'no-duplicates'; readonly table: string; readonly column: string; readonly normalize?: 'btrim' | 'none'; readonly skipNulls?: boolean };

/** Declarative migration step: frozen SQL text + declared primitives. */
export interface MigrationStep {
  /** Zero-padded, strictly increasing ('0001', '0002', ...). */
  readonly version: string;
  readonly name: string;
  readonly description: string;
  /** The EXACT SQL text: parsed, allowlisted, executed and hashed. Frozen
   *  once shipped - editing it is a new migration version. */
  readonly sql: string;
  /** Runner-executed zero-row guards (hard-fail), evaluated BEFORE sql. */
  readonly assertions?: readonly MigrationAssertion[];
  /** Runner-executed `LOCK TABLE <t> IN SHARE ROW EXCLUSIVE MODE` before sql. */
  readonly lockTables?: readonly string[];
  /** Runner-executed pg_advisory_xact_lock(key) first (step-scoped). */
  readonly xactLockKey?: number;
}

/** Declarative statement types permitted in migration artifacts (TL
 *  reconciliation: DDL+DML only - no DO/CALL/SELECT/functions/tx-control). */
const ARTIFACT_ALLOWLIST: ReadonlySet<string> = new Set([
  'create table', 'create index', 'alter table', 'drop table', 'drop index',
  'comment', 'insert', 'update', 'delete',
]);

/** PURE-FUNCTION allowlist (independent QA, 2026-09-18): the ONLY function
 *  calls permitted anywhere inside a migration artifact. Immutable string/
 *  math/logic helpers needed by declarative DDL+DML (SA's canonical index
 *  uses btrim). Everything else - side-effecting, volatile, session, lock,
 *  config, sequence, system - is rejected by absence from this list. This is
 *  an allowlist, not a growing forbidden-list. */
const PURE_FUNCTION_ALLOWLIST: ReadonlySet<string> = new Set([
  'btrim', 'trim', 'ltrim', 'rtrim', 'lower', 'upper', 'length', 'char_length',
  'character_length', 'coalesce', 'nullif', 'replace', 'substring', 'left',
  'right', 'concat', 'concat_ws', 'abs', 'round', 'floor', 'ceil', 'ceiling',
  'greatest', 'least',
  // STABLE timestamp for declarative column DEFAULTs (schema_migrations,
  // auth_audit) - transaction-consistent, non-side-effecting, no system or
  // session capability.
  'now',
]);

/** Recursively collects function call names from an AST (parser-normalized:
 *  quoted identifiers and schema qualification resolve to the same shape). */
function collectCalls(node: unknown, acc: string[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) collectCalls(n, acc); return; }
  const o = node as Record<string, unknown>;
  if (o['type'] === 'call') {
    const fn = o['function'] as { name?: string } | undefined;
    if (fn?.name) acc.push(fn.name.toLowerCase());
  }
  for (const v of Object.values(o)) collectCalls(v, acc);
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/i;

/** Registration-time artifact gate: real-parser AST allowlist. Throws
 *  (fail-closed) on unparseable text, non-declarative statement types,
 *  transaction control, or forbidden function calls. */
export function validateMigrationArtifact(sql: string): void {
  let stmts: { type: string }[];
  try {
    stmts = parseSql(sql) as { type: string }[];
  } catch (e) {
    throw new Error(`release-migrations: ARTIFACT refusal - unparsable SQL (fail-closed): ${(e as Error).message.split('\n')[0]}`);
  }
  if (stmts.length === 0) throw new Error('release-migrations: ARTIFACT refusal - empty artifact');
  for (const s of stmts) {
    if (!ARTIFACT_ALLOWLIST.has(s.type)) {
      throw new Error(
        `release-migrations: ARTIFACT refusal - statement type '${s.type}' is not declarative DDL+DML ` +
        `(allowed: ${[...ARTIFACT_ALLOWLIST].join(', ')}; transaction control, SELECT/CALL/DO and locks are runner-owned or forbidden)`,
      );
    }
  }
  // Closed recursive grammar: every function call anywhere in the AST
  // (expressions, defaults, index predicates, DML bodies, CTEs) must be a
  // pure allowlisted function. SELECT/DO/CALL/UDF/extension statement types
  // are already excluded above; this closes what remains.
  const calls: string[] = [];
  collectCalls(stmts, calls);
  for (const c of calls) {
    if (!PURE_FUNCTION_ALLOWLIST.has(c)) {
      throw new Error(
        `release-migrations: ARTIFACT refusal - function call '${c}' is not in the pure-function allowlist ` +
        `(declarative artifacts carry no side-effecting/volatile/session calls)`,
      );
    }
  }
}

/** Validates a named guard's identifiers and returns the runner-GENERATED
 *  guard SQL. Identifiers are validated and double-quoted by the runner;
 *  every other byte of the generated statement is a fixed runner template. */
export function buildAssertionQuery(a: MigrationAssertion): string {
  switch (a.kind) {
    case 'table-empty': {
      if (!IDENT.test(a.table)) throw new Error(`release-migrations: invalid assertion table ${JSON.stringify(a.table)}`);
      return `SELECT 1 AS violation FROM "${a.table}" LIMIT 1`;
    }
    case 'no-nulls': {
      if (!IDENT.test(a.table) || !IDENT.test(a.column)) throw new Error('release-migrations: invalid assertion identifier');
      return `SELECT 1 AS violation FROM "${a.table}" WHERE "${a.column}" IS NULL LIMIT 1`;
    }
    case 'no-duplicates': {
      if (!IDENT.test(a.table) || !IDENT.test(a.column)) throw new Error('release-migrations: invalid assertion identifier');
      const key = a.normalize === 'btrim' ? `btrim("${a.column}")` : `"${a.column}"`;
      const where = a.skipNulls === false ? '' : ` WHERE "${a.column}" IS NOT NULL`;
      return `SELECT 1 AS violation FROM "${a.table}"${where} GROUP BY ${key} HAVING count(*) > 1 LIMIT 1`;
    }
    default:
      throw new Error(`release-migrations: unknown assertion kind ${JSON.stringify((a as { kind?: string }).kind)} - named runner-owned kinds only`);
  }
}
export function validateAssertion(a: MigrationAssertion): void {
  buildAssertionQuery(a); // throws on invalid identifiers/kinds
}

/** The canonical executed form of an artifact: parsed statements re-serialized
 *  by the AST printer, one per driver call. Execution runs EXACTLY these
 *  serializations and the digest hashes EXACTLY this joined serialization -
 *  executed bytes and hashed bytes are the same object by construction. */
export function artifactStatements(sql: string): string[] {
  return parseSql(sql).map(st => toSql.statement(st));
}
export const canonicalArtifactSql = (sql: string): string => artifactStatements(sql).join(';\n');

/** Key-sorted canonical JSON for the declared-primitive digest component. */
const canonicalJson = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
};

/** Integrity digest over the EXACT artifact text + declared primitives:
 *  version + name + sql + canonical primitive declaration. Editing anything
 *  that executes changes the digest and FAILS the runner/boot history check.
 *  `description` is operator display metadata and is deliberately NOT
 *  integrity-protected; only executed content is. */
export const stepDigest = (m: MigrationStep): string =>
  createHash('sha256').update(
    `contake-migration/v5\n${m.version}\n${m.name}\n${canonicalArtifactSql(m.sql)}\n${canonicalJson({
      assertions: m.assertions ?? [], lockTables: m.lockTables ?? [], xactLockKey: m.xactLockKey ?? null,
    })}`,
  ).digest('hex');

/** 0001: the schema that used to be applied implicitly at server boot,
 *  extracted as a declarative artifact (frozen GRAPH_DDL/OTP_DDL - never edit
 *  in place). All IF NOT EXISTS: pre-migration databases adopt as a no-op
 *  baseline. */
export const MIGRATIONS: readonly MigrationStep[] = [
  {
    version: '0001',
    name: 'init-schema',
    description: 'Graph + OTP schema baseline (schema ownership moved out of app boot; idempotent IF NOT EXISTS).',
    sql: `${GRAPH_DDL};${OTP_DDL}`,
  },
  // SA lane plug-in contract (backend compatibility confirmed 2026-09-18;
  // TL reconciliation: declarative-only, guards as runner primitives):
  // register as '0002' when the SA track lands:
  // {
  //   version: '0002', name: 'users-phone-unique-index',
  //   description: 'users_phone_unique canonical partial unique index (SA lane)',
  //   xactLockKey: <SA migration lock key>,
  //   lockTables: ['users'],
  //   assertions: [
  //     { name: 'no_duplicate_normalized_phones', query: `SELECT phone FROM users WHERE phone IS NOT NULL GROUP BY btrim(phone) HAVING count(*) > 1` },
  //     { name: 'no_inconsistent_rows', query: `<SA inconsistency guard SELECT>` },
  //   ],
  //   sql: `CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(btrim(phone)) WHERE phone IS NOT NULL`,
  // }
  // Blocking guards hard-fail and roll back; normalization itself is set-based
  // DML in the artifact when SA ships it. The companion read-only structured
  // preflight remains operator evidence outside the migration. No second
  // runner may be introduced.
];

export const EXPECTED_SCHEMA_VERSIONS: readonly string[] = MIGRATIONS.map(m => m.version);

const RUNNER_LOCK_KEY = 841_000_001;

const RUNNER_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations(
  seq bigserial PRIMARY KEY,
  version text NOT NULL,
  name text NOT NULL,
  sha256 text NOT NULL,
  applied_by text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(version)
);
CREATE TABLE IF NOT EXISTS contake_db_identity(
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  deployment_label text NOT NULL,
  instance_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

export interface DbIdentity { deploymentLabel: string; instanceId: string }
export interface MigrationRunResult { identity: DbIdentity; stampedNow: boolean; appliedNow: string[]; versions: string[] }
export interface AppliedMigrationRow { version: string; name: string; sha256: string }

const DEPLOYMENT_LABEL = /^[a-z0-9][a-z0-9-]{0,62}$/;

export async function readDbIdentity(conn: Connectable | Queryable): Promise<DbIdentity | undefined> {
  const t = await conn.query(`SELECT to_regclass('contake_db_identity') AS r`);
  if (!t.rows[0]?.['r']) return undefined;
  const r = await conn.query(`SELECT deployment_label, instance_id FROM contake_db_identity WHERE id = 1`);
  const row = r.rows[0];
  return row ? { deploymentLabel: String(row['deployment_label']), instanceId: String(row['instance_id']) } : undefined;
}

/** PRE-MUTATION target binding (security): READ-ONLY. Verifies an already
 *  stamped database matches the expected deployment label and optional
 *  pre-provisioned instance pin BEFORE any write. An unstamped database is a
 *  first run: allowed here, stamped by runMigrations, and surfaced as an
 *  operator-attended TOFU gate (never authentication). */
export async function verifyTargetPreconditions(
  conn: Connectable | Queryable,
  opts: { deployment: string; expectInstanceId?: string },
): Promise<{ firstRun: boolean; identity?: DbIdentity }> {
  if (!DEPLOYMENT_LABEL.test(opts.deployment)) {
    throw new Error(`release-migrations: invalid deployment label ${JSON.stringify(opts.deployment)} (expected ${DEPLOYMENT_LABEL})`);
  }
  const identity = await readDbIdentity(conn);
  if (!identity) {
    if (opts.expectInstanceId !== undefined) {
      throw new Error(
        `release-migrations: INSTANCE BINDING refusal - an instance pin ('${opts.expectInstanceId}') was presented but this ` +
        `database carries NO stamped identity. A pin can only bind an existing stamp; omit --expect-instance-id for the ` +
        `attended first-run TOFU gate (refusing BEFORE any write).`,
      );
    }
    return { firstRun: true };
  }
  if (identity.deploymentLabel !== opts.deployment) {
    throw new Error(
      `release-migrations: CROSS-DEPLOYMENT refusal - this database is stamped '${identity.deploymentLabel}' ` +
      `(instance ${identity.instanceId}) but the job presented '${opts.deployment}'. Refusing BEFORE any write.`,
    );
  }
  if (opts.expectInstanceId !== undefined && identity.instanceId !== opts.expectInstanceId) {
    throw new Error(
      `release-migrations: INSTANCE BINDING refusal - operator pinned instance '${opts.expectInstanceId}' ` +
      `but this database is stamped '${identity.instanceId}'. Refusing BEFORE any write.`,
    );
  }
  return { firstRun: false, identity };
}

async function readAppliedRows(conn: Queryable): Promise<AppliedMigrationRow[]> {
  const t = await conn.query(`SELECT to_regclass('schema_migrations') AS r`);
  if (!t.rows[0]?.['r']) return [];
  const r = await conn.query(`SELECT version, name, sha256 FROM schema_migrations ORDER BY seq`);
  return r.rows.map(row => ({ version: String(row['version']), name: String(row['name']), sha256: String(row['sha256']) }));
}

function verifyHistoryPrefix(applied: AppliedMigrationRow[], migrations: readonly MigrationStep[]): void {
  for (let i = 0; i < applied.length; i += 1) {
    const reg = migrations[i];
    const row = applied[i]!;
    if (!reg || reg.version !== row.version) {
      throw new Error(
        `release-migrations: FORWARD-ONLY refusal - applied version ${row.version} at position ${i + 1} ` +
        `is not the registry prefix (expected ${reg?.version ?? 'none'}). Unknown/gapped/out-of-order history; manual review required.`,
      );
    }
    if (row.name !== reg.name || row.sha256 !== stepDigest(reg)) {
      throw new Error(
        `release-migrations: INTEGRITY refusal - applied '${row.version}' does not match the registered artifact ` +
        `(stored name='${row.name}' sha256=${row.sha256.slice(0, 12)}..., expected name='${reg.name}' sha256=${stepDigest(reg).slice(0, 12)}...). ` +
        `History was edited outside the runner or the artifact drifted; manual review required.`,
      );
    }
  }
}

/** Validates a full registry before anything executes (fail fast, pre-lock). */
export function validateRegistry(migrations: readonly MigrationStep[]): void {
  for (let i = 0; i < migrations.length; i += 1) {
    const m = migrations[i]!;
    if (m.version !== String(i + 1).padStart(4, '0')) {
      throw new Error(`release-migrations: registry is not strictly sequential at index ${i} (version ${m.version}) - refusing`);
    }
    validateMigrationArtifact(m.sql);
    for (const a of m.assertions ?? []) validateAssertion(a);
    for (const t of m.lockTables ?? []) {
      if (!IDENT.test(t)) throw new Error(`release-migrations: invalid lockTables identifier ${JSON.stringify(t)}`);
    }
    if (m.xactLockKey !== undefined && (!Number.isSafeInteger(m.xactLockKey) || m.xactLockKey < 0)) {
      throw new Error('release-migrations: xactLockKey must be a non-negative safe integer');
    }
  }
}

/** Applies every pending migration in registry order. */
export async function runMigrations(
  conn: Connectable,
  opts: { deployment: string; appliedBy?: string; migrations?: readonly MigrationStep[]; expectInstanceId?: string },
): Promise<MigrationRunResult> {
  const migrations = opts.migrations ?? MIGRATIONS;
  validateRegistry(migrations);

  const client = await conn.connect();
  let identity: DbIdentity;
  let stampedNow = false;
  let applied: AppliedMigrationRow[];
  const appliedNow: string[] = [];
  try {
    await client.query(`SELECT pg_advisory_lock(${RUNNER_LOCK_KEY})`);
    try {
      await client.query('BEGIN');
      try {
        for (const stmt of RUNNER_DDL.split(';').map(s => s.trim()).filter(Boolean)) await client.query(stmt);
        // Pre-mutation target binding is enforced inside the bootstrap tx as
        // well (the CLI also checks read-only before calling): any refusal
        // here still precedes every step write and rolls back.
        const pre = await verifyTargetPreconditions(client, { deployment: opts.deployment, expectInstanceId: opts.expectInstanceId });
        if (pre.firstRun) {
          identity = { deploymentLabel: opts.deployment, instanceId: randomBytes(8).toString('hex') };
          stampedNow = true;
          await client.query(
            `INSERT INTO contake_db_identity(id, deployment_label, instance_id) VALUES(1, $1, $2)`,
            [identity.deploymentLabel, identity.instanceId],
          );
        } else {
          identity = pre.identity!;
        }
        applied = await readAppliedRows(client);
        verifyHistoryPrefix(applied, migrations);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      }

      // Pending steps: ONE runner-owned transaction per step - guard
      // primitives, artifact statements AND the version record commit
      // together or roll back together.
      for (const m of migrations.slice(applied.length)) {
        await client.query('BEGIN');
        try {
          if (m.xactLockKey !== undefined) await client.query(`SELECT pg_advisory_xact_lock(${m.xactLockKey})`);
          for (const t of m.lockTables ?? []) await client.query(`LOCK TABLE "${t}" IN SHARE ROW EXCLUSIVE MODE`);
          for (const a of m.assertions ?? []) {
            const guard = await client.query(buildAssertionQuery(a));
            if (guard.rows.length > 0) {
              throw new Error(
                `release-migrations: ASSERTION refusal - guard '${a.kind}' in '${m.version}' found violating row(s); ` +
                `migration blocked - rolling back (hard-fail, never silent-skip)`,
              );
            }
          }
          for (const stmt of artifactStatements(m.sql)) await client.query(stmt);
          const ins = await client.query(
            `INSERT INTO schema_migrations(version, name, sha256, applied_by) VALUES($1, $2, $3, $4)
             ON CONFLICT (version) DO NOTHING`,
            [m.version, m.name, stepDigest(m), opts.appliedBy ?? 'release-job'],
          );
          if (ins.rowCount !== 1) {
            throw new Error(
              `release-migrations: version record for '${m.version}' collided inside its own transaction ` +
              `(rowCount=${ins.rowCount}) - history drift; rolling back the step`,
            );
          }
          await client.query('COMMIT');
          appliedNow.push(m.version);
        } catch (e) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw e;
        }
      }
    } finally {
      await client.query(`SELECT pg_advisory_unlock(${RUNNER_LOCK_KEY})`).catch(() => undefined);
    }
  } finally {
    client.release();
  }
  return { identity, stampedNow, appliedNow, versions: [...applied.map(r => r.version), ...appliedNow] };
}

/** Boot identity requirement (independent QA + security, 2026-09-18): EVERY
 *  PostgreSQL boot - production, staging, dev - MUST present the immutable
 *  database instance identity it expects (CONTAKE_DB_INSTANCE_ID) alongside
 *  the deployment label. Missing or malformed means fail closed: no runtime
 *  ever serves a database whose identity it did not declare. */
export function requiredBootIdentity(deployment: string, instanceId: string | undefined): { deployment: string; instanceId: string } {
  if (!DEPLOYMENT_LABEL.test(deployment)) {
    throw new Error(`release-migrations: invalid boot deployment label ${JSON.stringify(deployment)} (fail-closed)`);
  }
  if (instanceId === undefined || !/^[0-9a-f]{16}$/.test(instanceId)) {
    throw new Error(
      `release-migrations: PostgreSQL boot ('${deployment}') requires CONTAKE_DB_INSTANCE_ID (the 16-hex instance id ` +
      `stamped by the release job and verified out-of-band at the operator TOFU gate) - refusing to boot (fail-closed)`,
    );
  }
  return { deployment, instanceId };
}

/** Boot-time gate (fail-closed): exact version sequence + digest integrity,
 *  and when provided the expected deployment label and instance identity,
 *  verified BEFORE anything serves. */
export async function assertSchemaCurrent(
  conn: Connectable | Queryable,
  expected: readonly MigrationStep[] = MIGRATIONS,
  opts?: { deployment?: string; instanceId?: string },
): Promise<void> {
  const t = await conn.query(`SELECT to_regclass('schema_migrations') AS r`);
  if (!t.rows[0]?.['r']) {
    throw new Error(
      'release-migrations: schema_migrations is missing - this database was never initialized by the release-migration job. ' +
      'Run `pnpm --filter @contake/api migrate:release` (direct schema-owner endpoint) BEFORE booting the app - refusing to boot (fail-closed)',
    );
  }
  const applied = await readAppliedRows(conn);
  const expectedVersions = expected.map(m => m.version);
  const appliedVersions = applied.map(r => r.version);
  const missing = expectedVersions.filter(v => !appliedVersions.includes(v));
  const unknown = appliedVersions.filter(v => !expectedVersions.includes(v));
  if (missing.length > 0 || unknown.length > 0 || applied.length !== expected.length) {
    throw new Error(
      `release-migrations: schema version mismatch - refusing to boot (fail-closed). ` +
      `expected=[${expectedVersions.join(',')}] applied=[${appliedVersions.join(',')}]` +
      (missing.length ? ` missing=[${missing.join(',')}] - run the release-migration job` : '') +
      (unknown.length ? ` unknown=[${unknown.join(',')}] - database is ahead of/foreign to this build; manual review` : ''),
    );
  }
  try {
    verifyHistoryPrefix(applied, expected);
  } catch (e) {
    throw new Error(`release-migrations: ${(e as Error).message} - refusing to boot (fail-closed)`);
  }
  if (opts?.deployment !== undefined || opts?.instanceId !== undefined) {
    const identity = await readDbIdentity(conn);
    if (!identity) {
      throw new Error('release-migrations: no database identity stamped - refusing to boot (fail-closed)');
    }
    if (opts.deployment !== undefined && identity.deploymentLabel !== opts.deployment) {
      throw new Error(
        `release-migrations: DEPLOYMENT refusal - this database is stamped '${identity.deploymentLabel}' ` +
        `(instance ${identity.instanceId}) but this runtime expects '${opts.deployment}'. Refusing to serve another deployment's database (fail-closed).`,
      );
    }
    if (opts.instanceId !== undefined && identity.instanceId !== opts.instanceId) {
      throw new Error(
        `release-migrations: INSTANCE refusal - this database is instance '${identity.instanceId}' ` +
        `but this runtime expects '${opts.instanceId}'. Refusing to serve a different database (fail-closed).`,
      );
    }
  }
}

/** Role separation (Neon): release migrations and the staging seed run as
 *  schema owner over the DIRECT endpoint; '-pooler' is refused. Returns a
 *  credential-free descriptor safe to log. */
export function assertDirectDatabaseUrl(databaseUrl: string): { host: string; database: string } {
  let u: URL;
  try {
    u = new URL(databaseUrl);
  } catch {
    throw new Error('release-migrations: DATABASE_URL is not a valid URL');
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new Error(`release-migrations: DATABASE_URL protocol must be postgres(ql), got ${u.protocol}`);
  }
  if (u.hostname.includes('-pooler')) {
    throw new Error(
      'release-migrations: POOLED endpoint refused - schema/maintenance work requires the DIRECT schema-owner endpoint ' +
      '(Neon pooled connections are the runtime role and cannot own DDL). Use the unpooled DATABASE_URL.',
    );
  }
  return { host: u.hostname, database: u.pathname.replace(/^\//, '') };
}
