/** Release-migration runner (architecture convergence 2026-09-18: external
 *  research + TL ruling + QA's SA v8 finding "migrateUsersPhone has no shipped
 *  standard runner/caller"; hardened after independent QA FAILs of f9854cd6
 *  and 9182487e).
 *
 *  ONE shared runner owns ALL schema evolution:
 *  - VERSIONED, FORWARD-ONLY migrations with EXPLICIT invocation (12-factor
 *    admin process; Render free has no pre-deploy job, so this runs as a
 *    separately authorized release job: `pnpm --filter @contake/api migrate:release`).
 *  - App startup NEVER creates/migrates schema; it calls assertSchemaCurrent()
 *    and FAILS CLOSED on any mismatch (missing table, unknown version, gap,
 *    or integrity drift).
 *  - PER-STEP TRANSACTION (QA #1): every step runs on ONE leased client
 *    inside ONE transaction - step body AND its version record commit
 *    together or roll back together. Partial DDL can never persist versionless.
 *  - RESTRICTED TX CAPABILITY (QA v2 #2): steps NEVER see the raw client.
 *    They receive a restricted capability whose query() mechanically REJECTS
 *    transaction-control statements (BEGIN/START/COMMIT/ROLLBACK/ABORT/END/
 *    SAVEPOINT/RELEASE/PREPARE TRANSACTION/SET TRANSACTION/SET CONSTRAINTS),
 *    tolerant of case, whitespace and SQL comment disguise. A step cannot
 *    escape the runner's transaction; a rejected statement throws, the step
 *    rolls back, nothing persists.
 *  - MECHANICALLY BOUND ARTIFACT DIGESTS (QA v2 #1): the integrity digest is
 *    computed over the EXACT thing that executes, not a caller-declared label:
 *      * sql steps: the runner executes step.sql verbatim (single query call)
 *        and hashes step.sql. The hashed bytes ARE the executed bytes.
 *      * fn steps: the digest covers up.toString() - the exact function source
 *        that runs. Any implementation-only edit changes the digest and fails
 *        the runner history check and the boot gate.
 *  - WHOLE-RUN SERIALIZATION: one session-level advisory lock held on the
 *    leased client for the ENTIRE run (bootstrap + every step), so concurrent
 *    runners serialize; the second observes the first's committed history and
 *    becomes a no-op.
 *  - APPLIED-STEP INTEGRITY (QA #2): schema_migrations stores version + name
 *    + sha256 (the mechanically bound digest above). The runner and the boot
 *    gate require exact version+name+digest equality for every applied step.
 *    NEVER edit a shipped migration - a changed implementation is a new
 *    migration version.
 *  - ROLE SEPARATION (Neon dual-URL): this runner requires the DIRECT
 *    (schema-owner) endpoint - a '-pooler' host is refused. The runtime app
 *    uses the pooled least-privileged endpoint and never runs this code path.
 *  - CROSS-DEPLOYMENT PROTECTION: the first run stamps a single-row
 *    contake_db_identity (deployment label + random instance id); every later
 *    run must present the SAME label or is refused. */
import { createHash, randomBytes } from 'node:crypto';
import { GRAPH_DDL, OTP_DDL, type Connectable, type Queryable } from '../repo/postgres.js';

/** A migration step is one of two mechanically bound shapes:
 *  - sql: declarative artifact ONLY. The runner executes `sql` verbatim and
 *    hashes the same bytes. There is no code path where executed SQL and
 *    hashed SQL can diverge.
 *  - fn: an escape hatch for migrations that need programmatic logic (the SA
 *    users-phone preflight). The digest covers up.toString() - the exact
 *    source of the function that runs - so an implementation-only edit is an
 *    integrity failure. fn steps run on the restricted tx capability. */
interface StepBase {
  /** Zero-padded, strictly increasing ('0001', '0002', ...). */
  readonly version: string;
  readonly name: string;
  readonly description: string;
}
export interface SqlMigrationStep extends StepBase {
  readonly kind: 'sql';
  /** The EXACT SQL text executed verbatim by the runner (and hashed). Frozen
   *  once shipped: editing it is a new migration version. */
  readonly sql: string;
}
export interface FnMigrationStep extends StepBase {
  readonly kind: 'fn';
  /** Step body on the RESTRICTED transaction capability. The digest covers
   *  this function's exact source (up.toString()). Transaction-control
   *  statements are mechanically rejected; the runner owns the tx. */
  readonly up: (tx: Queryable) => Promise<void>;
}
export type MigrationStep = SqlMigrationStep | FnMigrationStep;

/** The bytes a step's integrity digest mechanically binds to: the exact SQL
 *  text for sql steps, the exact function source for fn steps. */
export const stepArtifactBytes = (m: MigrationStep): string =>
  m.kind === 'sql' ? m.sql : m.up.toString();

/** Integrity digest over the step's EXECUTED implementation (QA #2, QA v2 #1):
 *  version + name + exact-executed bytes. Editing the implementation of a
 *  shipped migration changes the digest and FAILS the boot gate / runner
 *  history check - ship a new version instead. */
export const stepDigest = (m: MigrationStep): string =>
  createHash('sha256').update(`contake-migration/v2\n${m.version}\n${m.name}\n${stepArtifactBytes(m)}`).digest('hex');

/** Transaction-control statements a step must never issue (the runner owns
 *  the transaction). Matched per statement after comment stripping, first
 *  keyword only, case-insensitive (QA v2 #2). */
const TX_CONTROL = /^(?:begin|start|commit|rollback|abort|end|savepoint|release|prepare\s+transaction|set\s+transaction|set\s+constraints)\b/i;

/** Strips SQL line and block comments (block comments nest in PostgreSQL) so
 *  comment-disguised transaction control is still caught. String literals are
 *  NOT parsed: a statement whose first post-comment keyword is transaction
 *  control is rejected even inside an exotic literal - fail closed. */
export function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  let depth = 0;
  while (i < sql.length) {
    if (depth === 0 && sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
      out += ' ';
    } else if (sql.startsWith('/*', i)) {
      depth += 1;
      i += 2;
      out += ' ';
    } else if (depth > 0 && sql.startsWith('*/', i)) {
      depth -= 1;
      i += 2;
      out += ' ';
    } else {
      out += depth === 0 ? sql[i] : ' ';
      i += 1;
    }
  }
  return out;
}

/** Session-scoped advisory-lock functions a step must never call: unlocking
 *  would drop the runner's whole-run serialization from inside a step, and
 *  taking a second session lock mutates session state the runner owns. The
 *  transaction-scoped family (pg_advisory_xact_lock / pg_try_advisory_xact_lock)
 *  stays legal - SA's migration body uses it inside the runner's tx. */
const SESSION_LOCK_ESCAPE = /\bpg_(?:try_)?advisory_(?:lock|unlock|unlock_all)\s*\(/i;

/** Rejects transaction-control statements and session-lock escape anywhere in
 *  a (possibly multi-statement) SQL text. Throws on the first hit. */
export function assertNoTransactionControl(sql: string): void {
  const stripped = stripSqlComments(sql);
  for (const stmt of stripped.split(';')) {
    const t = stmt.trim();
    if (t && TX_CONTROL.test(t)) {
      throw new Error(
        `release-migrations: TRANSACTION-CONTROL refusal - a migration step attempted ${JSON.stringify(t.slice(0, 40))}... ` +
        `The runner owns the transaction; steps receive a restricted capability and cannot BEGIN/COMMIT/ROLLBACK/SAVEPOINT/... themselves.`,
      );
    }
    if (SESSION_LOCK_ESCAPE.test(t)) {
      throw new Error(
        `release-migrations: SESSION-LOCK refusal - a migration step attempted a session-scoped advisory-lock call ` +
        `(${JSON.stringify(t.slice(0, 40))}...). The runner owns the session lock for the whole run; only transaction-scoped ` +
        `pg_advisory_xact_lock is legal inside a step.`,
      );
    }
  }
}

/** The restricted transaction capability handed to every step (QA v2 #2): a
 *  mechanical wrapper over the leased client whose query() rejects
 *  transaction-control statements (case/whitespace/comment tolerant). The raw
 *  client never reaches step code. */
export function restrictTx(client: Queryable): Queryable {
  return {
    query: (text: string, params?: unknown[]) => {
      assertNoTransactionControl(text);
      return client.query(text, params);
    },
  };
}

/** 0001: the schema that used to be applied implicitly at server boot
 *  (PostgresGraphRepository.create graph DDL + createPgOtpState OTP DDL),
 *  extracted into an explicit versioned step. Declarative SQL artifact ONLY:
 *  the runner executes exactly these bytes and hashes exactly these bytes.
 *  All statements are IF NOT EXISTS, so pre-migration databases adopt the
 *  runner as a no-op baseline and fresh databases are built fully here. */
export const MIGRATIONS: readonly MigrationStep[] = [
  {
    kind: 'sql',
    version: '0001',
    name: 'init-schema',
    description: 'Graph + OTP schema baseline (schema ownership moved out of app boot; idempotent IF NOT EXISTS).',
    sql: `${GRAPH_DDL};${OTP_DDL}`,
  },
  // SA lane plug-in contract (QA SA v8 finding, TL convergence 2026-09-18):
  // register migrateUsersPhone as version '0002' when the SA track lands.
  // It is a fn step (programmatic preflight): the integrity digest covers the
  // registered function's EXACT source (up.toString()), and it runs on the
  // RESTRICTED tx capability - migrateUsersPhone currently wraps itself in
  // withTx(BEGIN/COMMIT), so at integration the SA lane must register a
  // tx-scoped entry point (same preflight -> normalize -> preflight -> index
  // -> final preflight body, same advisory xact lock and LOCK TABLE - both
  // legal inside the runner's transaction). Example:
  // { kind: 'fn', version: '0002', name: 'users-phone-unique-index',
  //   up: async (tx) => { await migrateUsersPhoneTx(tx); } }
  // No second runner may be introduced.
];

/** The exact version sequence a healthy boot expects. */
export const EXPECTED_SCHEMA_VERSIONS: readonly string[] = MIGRATIONS.map(m => m.version);

/** Session-level advisory lock serializing ENTIRE release-migration runs
 *  (distinct from SA's MIGRATION_LOCK_KEY). Held on the leased client across
 *  the bootstrap and every per-step transaction. */
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

export interface MigrationRunResult {
  identity: DbIdentity;
  /** True when THIS run stamped the identity (operator-attended TOFU gate). */
  stampedNow: boolean;
  appliedNow: string[];
  versions: string[];
}

export interface AppliedMigrationRow { version: string; name: string; sha256: string }

const DEPLOYMENT_LABEL = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Reads the stamped deployment identity; undefined when never stamped. */
export async function readDbIdentity(conn: Connectable | Queryable): Promise<DbIdentity | undefined> {
  const t = await conn.query(`SELECT to_regclass('contake_db_identity') AS r`);
  if (!t.rows[0]?.['r']) return undefined;
  const r = await conn.query(`SELECT deployment_label, instance_id FROM contake_db_identity WHERE id = 1`);
  const row = r.rows[0];
  return row ? { deploymentLabel: String(row['deployment_label']), instanceId: String(row['instance_id']) } : undefined;
}

async function readAppliedRows(conn: Queryable): Promise<AppliedMigrationRow[]> {
  const t = await conn.query(`SELECT to_regclass('schema_migrations') AS r`);
  if (!t.rows[0]?.['r']) return [];
  const r = await conn.query(`SELECT version, name, sha256 FROM schema_migrations ORDER BY seq`);
  return r.rows.map(row => ({ version: String(row['version']), name: String(row['name']), sha256: String(row['sha256']) }));
}

/** Executes one step on the restricted capability: sql steps run their exact
 *  sql text verbatim (single multi-statement query - the hashed bytes ARE the
 *  executed bytes); fn steps run their exact hashed function source. */
async function executeStep(m: MigrationStep, tx: Queryable): Promise<void> {
  if (m.kind === 'sql') {
    // The digest hashes m.sql and ONLY m.sql is executed: the text is scanned
    // whole by the restricted capability, then run statement-by-statement
    // (drivers on the extended protocol reject multi-statement strings; the
    // executed statements are exactly the hashed text, nothing else).
    for (const stmt of m.sql.split(';').map(x => x.trim()).filter(Boolean)) {
      await tx.query(stmt);
    }
  } else {
    await m.up(tx);
  }
}

/** History gate shared by the runner and the boot check: the applied rows must
 *  be an EXACT registry prefix with exact version+name+digest integrity. */
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
        `release-migrations: INTEGRITY refusal - applied '${row.version}' does not match the registered implementation ` +
        `(stored name='${row.name}' sha256=${row.sha256.slice(0, 12)}..., expected name='${reg.name}' sha256=${stepDigest(reg).slice(0, 12)}...). ` +
        `History was edited outside the runner or the implementation drifted; manual review required.`,
      );
    }
  }
}

/** Applies every pending migration in registry order. */
export async function runMigrations(
  conn: Connectable,
  opts: { deployment: string; appliedBy?: string; migrations?: readonly MigrationStep[] },
): Promise<MigrationRunResult> {
  const migrations = opts.migrations ?? MIGRATIONS;
  if (!DEPLOYMENT_LABEL.test(opts.deployment)) {
    throw new Error(`release-migrations: invalid deployment label ${JSON.stringify(opts.deployment)} (expected ${DEPLOYMENT_LABEL})`);
  }
  for (let i = 0; i < migrations.length; i += 1) {
    const m = migrations[i]!;
    if (m.version !== String(i + 1).padStart(4, '0')) {
      throw new Error(`release-migrations: registry is not strictly sequential at index ${i} (version ${m.version}) - refusing`);
    }
  }
  const appliedBy = opts.appliedBy ?? 'release-job';

  // ONE leased client for the WHOLE run; ONE session-level advisory lock held
  // across the bootstrap and every per-step transaction (concurrent runners
  // serialize; the loser replays history and no-ops).
  const client = await conn.connect();
  let identity: DbIdentity;
  let stampedNow = false;
  let applied: AppliedMigrationRow[];
  const appliedNow: string[] = [];
  try {
    await client.query(`SELECT pg_advisory_lock(${RUNNER_LOCK_KEY})`);
    try {
      // Bootstrap tx: runner tables, identity stamping/verification, history check.
      await client.query('BEGIN');
      try {
        for (const stmt of RUNNER_DDL.split(';').map(s => s.trim()).filter(Boolean)) await client.query(stmt);
        const existing = await readDbIdentity(client);
        if (existing) {
          if (existing.deploymentLabel !== opts.deployment) {
            throw new Error(
              `release-migrations: CROSS-DEPLOYMENT refusal - this database is stamped '${existing.deploymentLabel}' ` +
              `(instance ${existing.instanceId}) but the job presented '${opts.deployment}'. Refusing to touch another deployment's database.`,
            );
          }
          identity = existing;
        } else {
          identity = { deploymentLabel: opts.deployment, instanceId: randomBytes(8).toString('hex') };
          stampedNow = true;
          await client.query(
            `INSERT INTO contake_db_identity(id, deployment_label, instance_id) VALUES(1, $1, $2)`,
            [identity.deploymentLabel, identity.instanceId],
          );
        }
        applied = await readAppliedRows(client);
        verifyHistoryPrefix(applied, migrations);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      }

      // Pending steps: ONE transaction per step - body AND version record
      // commit together or roll back together (QA #1). Step code only ever
      // sees the RESTRICTED capability (QA v2 #2): transaction control is
      // mechanically rejected before it can reach the connection.
      const tx = restrictTx(client);
      for (const m of migrations.slice(applied.length)) {
        await client.query('BEGIN');
        try {
          await executeStep(m, tx);
          const ins = await client.query(
            `INSERT INTO schema_migrations(version, name, sha256, applied_by) VALUES($1, $2, $3, $4)
             ON CONFLICT (version) DO NOTHING`,
            [m.version, m.name, stepDigest(m), appliedBy],
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

/** Boot-time gate (fail-closed): the database must carry EXACTLY the expected
 *  version sequence with exact name+digest integrity per applied step -
 *  initialized, complete, no unknown/extra versions, no edited history.
 *  Any deviation refuses the boot before any repository/auth/dispatch work. */
export async function assertSchemaCurrent(
  conn: Connectable | Queryable,
  expected: readonly MigrationStep[] = MIGRATIONS,
  opts?: { deployment?: string },
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
  if (opts?.deployment !== undefined) {
    const identity = await readDbIdentity(conn);
    if (!identity) {
      throw new Error('release-migrations: no database identity stamped - refusing to boot (fail-closed)');
    }
    if (identity.deploymentLabel !== opts.deployment) {
      throw new Error(
        `release-migrations: DEPLOYMENT refusal - this database is stamped '${identity.deploymentLabel}' ` +
        `(instance ${identity.instanceId}) but this runtime expects '${opts.deployment}'. Refusing to serve ` +
        `another deployment's database (fail-closed).`,
      );
    }
  }
}

/** Role separation (Neon): release migrations and the staging seed run as
 *  schema owner over the DIRECT endpoint; the pooled '-pooler' endpoint is the
 *  runtime's least-privileged DML role and is REFUSED here. Returns a
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
