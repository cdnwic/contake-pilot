/** Release-migration runner (architecture convergence 2026-09-18: external
 *  research + TL ruling + QA's SA v8 finding "migrateUsersPhone has no shipped
 *  standard runner/caller").
 *
 *  ONE shared runner owns ALL schema evolution:
 *  - VERSIONED, FORWARD-ONLY migrations with EXPLICIT invocation (12-factor
 *    admin process; Render free has no pre-deploy job, so this runs as a
 *    separately authorized release job: `pnpm --filter @contake/api migrate:release`).
 *  - App startup NEVER creates/migrates schema; it calls assertSchemaCurrent()
 *    and FAILS CLOSED on any mismatch (missing table, unknown version, gap).
 *  - Every migration step is responsible for its own atomicity and MUST be
 *    idempotent (a crash between a step and its version record re-runs the
 *    step). 0001 is all IF NOT EXISTS; function steps (e.g. SA's
 *    migrateUsersPhone, which holds its own advisory lock + table lock in one
 *    transaction) plug in through the MigrationStep contract below.
 *  - ROLE SEPARATION (Neon dual-URL): this runner requires the DIRECT
 *    (schema-owner) endpoint - a '-pooler' host is refused. The runtime app
 *    uses the pooled least-privileged endpoint and never runs this code path.
 *  - CROSS-DEPLOYMENT PROTECTION: the first run stamps a single-row
 *    contake_db_identity (deployment label + random instance id); every later
 *    run must present the SAME label or is refused. */
import { createHash, randomBytes } from 'node:crypto';
import { GRAPH_DDL, OTP_DDL, type Connectable } from '../repo/postgres.js';

export interface MigrationStep {
  /** Zero-padded, strictly increasing ('0001', '0002', ...). */
  readonly version: string;
  readonly name: string;
  readonly description: string;
  /** Must be atomic (own transaction) and idempotent. */
  readonly up: (conn: Connectable) => Promise<void>;
}

/** 0001: the schema that used to be applied implicitly at server boot
 *  (PostgresGraphRepository.create graph DDL + createPgOtpState OTP DDL),
 *  extracted into an explicit versioned step. All statements are
 *  IF NOT EXISTS, so pre-migration databases adopt the runner as a no-op
 *  baseline and fresh databases are built fully here. */
async function applyInitSchema(conn: Connectable): Promise<void> {
  for (const stmt of `${GRAPH_DDL};${OTP_DDL}`.split(';').map(s => s.trim()).filter(Boolean)) {
    await conn.query(stmt);
  }
}

export const MIGRATIONS: readonly MigrationStep[] = [
  {
    version: '0001',
    name: 'init-schema',
    description: 'Graph + OTP schema baseline (schema ownership moved out of app boot; idempotent IF NOT EXISTS).',
    up: applyInitSchema,
  },
  // SA lane plug-in contract (QA SA v8 finding, TL convergence 2026-09-18):
  // register migrateUsersPhone here as version '0002' when the SA track lands -
  // { version: '0002', name: 'users-phone-unique-index', up: async (conn) => {
  //   const r = await migrateUsersPhone(conn);
  //   if (!r.migrated) throw new Error(`users-phone migration blocked: ${r.reason}`);
  // } }
  // migrateUsersPhone is already one locked idempotent transaction, which is
  // exactly the MigrationStep contract. No second runner may be introduced.
];

/** The exact version sequence a healthy boot expects. */
export const EXPECTED_SCHEMA_VERSIONS: readonly string[] = MIGRATIONS.map(m => m.version);

/** Advisory lock serializing release-migration runs (distinct from SA's
 *  MIGRATION_LOCK_KEY; nested advisory locks are safe). */
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

const stepDigest = (m: MigrationStep): string =>
  createHash('sha256').update(`${m.version}:${m.name}:${m.description}`).digest('hex');

export interface DbIdentity { deploymentLabel: string; instanceId: string }

export interface MigrationRunResult {
  identity: DbIdentity;
  appliedNow: string[];
  versions: string[];
}

const DEPLOYMENT_LABEL = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Reads the stamped deployment identity; undefined when never stamped. */
export async function readDbIdentity(conn: Connectable): Promise<DbIdentity | undefined> {
  const t = await conn.query(`SELECT to_regclass('contake_db_identity') AS r`);
  if (!t.rows[0]?.['r']) return undefined;
  const r = await conn.query(`SELECT deployment_label, instance_id FROM contake_db_identity WHERE id = 1`);
  const row = r.rows[0];
  return row ? { deploymentLabel: String(row['deployment_label']), instanceId: String(row['instance_id']) } : undefined;
}

async function readAppliedVersions(conn: Connectable): Promise<string[]> {
  const t = await conn.query(`SELECT to_regclass('schema_migrations') AS r`);
  if (!t.rows[0]?.['r']) return [];
  const r = await conn.query(`SELECT version FROM schema_migrations ORDER BY seq`);
  return r.rows.map(row => String(row['version']));
}

/** Applies every pending migration in registry order. Forward-only:
 *  an applied version unknown to the registry, or an applied sequence that
 *  is not an exact registry prefix, refuses loudly (never skipped, never
 *  reordered, never rolled back silently). */
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

  // Bootstrap under ONE transaction + advisory lock: runner tables, deployment
  // identity stamping/verification, and the forward-only prefix check.
  const client = await conn.connect();
  let identity: DbIdentity;
  let applied: string[];
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(${RUNNER_LOCK_KEY})`);
    for (const stmt of RUNNER_DDL.split(';').map(s => s.trim()).filter(Boolean)) await client.query(stmt);
    const existing = await readDbIdentity(client as unknown as Connectable);
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
    applied = await readAppliedVersions(client as unknown as Connectable);
    for (let i = 0; i < applied.length; i += 1) {
      const reg = migrations[i];
      if (!reg || reg.version !== applied[i]) {
        throw new Error(
          `release-migrations: FORWARD-ONLY refusal - applied version ${applied[i]} at position ${i + 1} ` +
          `is not the registry prefix (expected ${reg?.version ?? 'none'}). Unknown/gapped/out-of-order history; manual review required.`,
        );
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }

  // Pending steps: each step owns its atomicity and is idempotent; the version
  // record follows the step. A crash between the two re-runs the step safely.
  const appliedNow: string[] = [];
  for (const m of migrations.slice(applied.length)) {
    await m.up(conn);
    await conn.query(
      `INSERT INTO schema_migrations(version, name, sha256, applied_by) VALUES($1, $2, $3, $4)
       ON CONFLICT (version) DO NOTHING`,
      [m.version, m.name, stepDigest(m), appliedBy],
    );
    appliedNow.push(m.version);
  }
  return { identity, appliedNow, versions: [...applied, ...appliedNow] };
}

/** Boot-time gate (fail-closed): the database must carry EXACTLY the expected
 *  version sequence - initialized, complete, no unknown or extra versions.
 *  Any deviation refuses the boot before any repository/auth/dispatch work. */
export async function assertSchemaCurrent(
  conn: Connectable,
  expected: readonly string[] = EXPECTED_SCHEMA_VERSIONS,
): Promise<void> {
  const t = await conn.query(`SELECT to_regclass('schema_migrations') AS r`);
  if (!t.rows[0]?.['r']) {
    throw new Error(
      'release-migrations: schema_migrations is missing - this database was never initialized by the release-migration job. ' +
      'Run `pnpm --filter @contake/api migrate:release` (direct schema-owner endpoint) BEFORE booting the app - refusing to boot (fail-closed)',
    );
  }
  const applied = await readAppliedVersions(conn);
  const missing = expected.filter(v => !applied.includes(v));
  const unknown = applied.filter(v => !expected.includes(v));
  if (missing.length > 0 || unknown.length > 0 || applied.length !== expected.length) {
    throw new Error(
      `release-migrations: schema version mismatch - refusing to boot (fail-closed). ` +
      `expected=[${expected.join(',')}] applied=[${applied.join(',')}]` +
      (missing.length ? ` missing=[${missing.join(',')}] - run the release-migration job` : '') +
      (unknown.length ? ` unknown=[${unknown.join(',')}] - database is ahead of/foreign to this build; manual review` : ''),
    );
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (applied[i] !== expected[i]) {
      throw new Error(`release-migrations: applied sequence out of order at position ${i + 1} - refusing to boot (fail-closed)`);
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
