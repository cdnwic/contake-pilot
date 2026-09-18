/** Release-migration runner (architecture convergence 2026-09-18: external
 *  research + TL ruling + QA's SA v8 finding "migrateUsersPhone has no shipped
 *  standard runner/caller"; hardened after independent QA FAIL of f9854cd6).
 *
 *  ONE shared runner owns ALL schema evolution:
 *  - VERSIONED, FORWARD-ONLY migrations with EXPLICIT invocation (12-factor
 *    admin process; Render free has no pre-deploy job, so this runs as a
 *    separately authorized release job: `pnpm --filter @contake/api migrate:release`).
 *  - App startup NEVER creates/migrates schema; it calls assertSchemaCurrent()
 *    and FAILS CLOSED on any mismatch (missing table, unknown version, gap,
 *    or integrity drift).
 *  - PER-STEP TRANSACTION (QA stop-ship #1): every step runs on ONE leased
 *    client inside ONE transaction - step body AND its version record commit
 *    together or roll back together. Partial DDL can never persist versionless.
 *    A step receives an ALREADY-TRANSACTIONAL client and must NOT begin,
 *    commit or roll back its own transaction (a function step that
 *    self-manages a tx is adapted at registration - see the SA contract).
 *  - WHOLE-RUN SERIALIZATION: one session-level advisory lock held on the
 *    leased client for the ENTIRE run (bootstrap + every step), so concurrent
 *    runners serialize; the second observes the first's committed history and
 *    becomes a no-op.
 *  - APPLIED-STEP INTEGRITY (QA stop-ship #2): schema_migrations stores
 *    version + name + sha256, where sha256 = digest over the step's ACTUAL
 *    artifact (exact SQL text / implementation source), not editable
 *    metadata. The runner and the boot gate require exact version+name+digest
 *    equality for every applied step. NEVER edit a shipped migration's
 *    artifact - a changed artifact is a new migration version.
 *  - ROLE SEPARATION (Neon dual-URL): this runner requires the DIRECT
 *    (schema-owner) endpoint - a '-pooler' host is refused. The runtime app
 *    uses the pooled least-privileged endpoint and never runs this code path.
 *  - CROSS-DEPLOYMENT PROTECTION: the first run stamps a single-row
 *    contake_db_identity (deployment label + random instance id); every later
 *    run must present the SAME label or is refused. */
import { createHash, randomBytes } from 'node:crypto';
import { GRAPH_DDL, OTP_DDL, type Connectable, type Queryable } from '../repo/postgres.js';

export interface MigrationStep {
  /** Zero-padded, strictly increasing ('0001', '0002', ...). */
  readonly version: string;
  readonly name: string;
  readonly description: string;
  /** The EXACT artifact this migration applies (SQL text / implementation
   *  source). Hashed into the integrity digest; frozen once shipped. */
  readonly artifact: string;
  /** Step body. Runs inside the runner's per-step transaction on an
   *  already-transactional client: MUST NOT BEGIN/COMMIT/ROLLBACK itself.
   *  Must be idempotent ONLY in the sense that a retry after full rollback
   *  succeeds; partial state cannot survive a failure. */
  readonly up: (tx: Queryable) => Promise<void>;
}

/** Integrity digest over the step's ACTUAL artifact (QA stop-ship #2):
 *  version + name + artifact bytes. Editing the artifact of a shipped
 *  migration changes the digest and FAILS the boot gate / runner history
 *  check - that is the enforcement, not a bug: ship a new version instead. */
export const stepDigest = (m: Pick<MigrationStep, 'version' | 'name' | 'artifact'>): string =>
  createHash('sha256').update(`contake-migration/v1\n${m.version}\n${m.name}\n${m.artifact}`).digest('hex');

/** 0001: the schema that used to be applied implicitly at server boot
 *  (PostgresGraphRepository.create graph DDL + createPgOtpState OTP DDL),
 *  extracted into an explicit versioned step. All statements are
 *  IF NOT EXISTS, so pre-migration databases adopt the runner as a no-op
 *  baseline and fresh databases are built fully here. */
async function applyInitSchema(tx: Queryable): Promise<void> {
  for (const stmt of `${GRAPH_DDL};${OTP_DDL}`.split(';').map(s => s.trim()).filter(Boolean)) {
    await tx.query(stmt);
  }
}

export const MIGRATIONS: readonly MigrationStep[] = [
  {
    version: '0001',
    name: 'init-schema',
    description: 'Graph + OTP schema baseline (schema ownership moved out of app boot; idempotent IF NOT EXISTS).',
    artifact: `${GRAPH_DDL};${OTP_DDL}`,
    up: applyInitSchema,
  },
  // SA lane plug-in contract (QA SA v8 finding, TL convergence 2026-09-18):
  // register migrateUsersPhone as version '0002' when the SA track lands.
  // IMPORTANT: up() receives an ALREADY-TRANSACTIONAL client. migrateUsersPhone
  // currently wraps itself in withTx(BEGIN/COMMIT); at integration the SA lane
  // must register a tx-scoped entry point (same preflight -> normalize ->
  // preflight -> index -> final preflight body, same advisory xact lock and
  // LOCK TABLE - both legal inside the runner's transaction) instead of its
  // own BEGIN/COMMIT. Example:
  // { version: '0002', name: 'users-phone-unique-index',
  //   artifact: migrateUsersPhoneTxSource,   // implementation source text
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
        `release-migrations: INTEGRITY refusal - applied '${row.version}' does not match the registry artifact ` +
        `(stored name='${row.name}' sha256=${row.sha256.slice(0, 12)}..., expected name='${reg.name}' sha256=${stepDigest(reg).slice(0, 12)}...). ` +
        `History was edited outside the runner or the artifact drifted; manual review required.`,
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
      // commit together or roll back together (QA stop-ship #1).
      for (const m of migrations.slice(applied.length)) {
        await client.query('BEGIN');
        try {
          await m.up(client);
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
  return { identity, appliedNow, versions: [...applied.map(r => r.version), ...appliedNow] };
}

/** Boot-time gate (fail-closed): the database must carry EXACTLY the expected
 *  version sequence with exact name+digest integrity per applied step -
 *  initialized, complete, no unknown/extra versions, no edited history.
 *  Any deviation refuses the boot before any repository/auth/dispatch work. */
export async function assertSchemaCurrent(
  conn: Connectable | Queryable,
  expected: readonly MigrationStep[] = MIGRATIONS,
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
