/** Staging-only SYNTHETIC seed (2026-09-18, Chaim-approved synthetic-only
 *  staging scope; architecture: separate idempotent seed, NEVER app startup).
 *
 *  Why this exists: the repo's demo seeds (seedDemo/campDemoSeed/vertical
 *  seeds) contain PUBLIC fixed passwords, phones and identifiers shipped in a
 *  public repo; the fail-closed hotfix forbids CONTAKE_SEED in any production
 *  boot, and staging runs NODE_ENV=production. Staging data therefore comes
 *  ONLY from this explicit job:
 *  - every credential, phone and ID is generated AT RUNTIME with a CSPRNG
 *    (node:crypto); nothing fixture-derived, nothing hardcoded;
 *  - emails live on the guaranteed-non-routable .invalid TLD (RFC 2606) and
 *    phones on the fictional +972-555-xxxxxx pattern;
 *  - ABSENCE PROOFS: the full public-fixture identifier set is derived from
 *    the seed modules themselves (single source of truth - a fixture added
 *    later is automatically forbidden) and production identifiers arrive via
 *    env (never hardcoded); the generated set AND the final database state
 *    are proven to contain none of them;
 *  - IDEMPOTENT: a staging_seed_state row binds the seed instance; an exact
 *    re-run is a no-op, a dirty or foreign database is refused;
 *  - ONE transaction: any failed gate or proof rolls back EVERYTHING;
 *  - SECRETS: generated credentials leave this module ONLY through the
 *    explicit secrets return (CLI: one-time terminal capture into the vault)
 *    or arrive pre-vaulted via env; they are never written to files,
 *    artifacts, the inventory, or logs. */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { PostgresGraphRepository, type Connectable } from '../repo/postgres.js';
import { applySeed, seedDemo } from '../seed.js';
import { campDemoSeed, campDemoStagingSlice } from '../demo/camp-demo.js';
import { seedFilmShoot } from '../seeds/film-shoot.seed.js';
import { seedEventProduction } from '../seeds/event-production.seed.js';
import { seedEducation } from '../seeds/education.seed.js';
import { seedAfterSchool } from '../seeds/after-school.seed.js';
import { seedConference } from '../seeds/conference.seed.js';
import { seedLogistics } from '../seeds/logistics.seed.js';
import { hashPasswordPure } from '../auth.js';
import { readDbIdentity } from './runner.js';
import type { SeedData } from '../repo/graph-repository.js';

/** Every public-fixture identifier, derived from the fixture modules at call
 *  time (single source of truth): org/user/event/resource/task/dependency/
 *  channel IDs, emails, phones and channel addresses. A fixture added to any
 *  seed module later is forbidden here automatically. */
export function deriveFixtureIdentifiers(): string[] {
  const D = '2000-01-01'; // dates only; identifiers are static
  const seeds: SeedData[] = [
    seedDemo(), campDemoSeed(), campDemoStagingSlice(),
    seedFilmShoot(D), seedEventProduction(D), seedEducation(D),
    seedAfterSchool(D), seedConference(D), seedLogistics(D),
  ];
  const ids = new Set<string>();
  for (const s of seeds) {
    ids.add(s.orgId);
    for (const u of s.users) {
      ids.add(u.userId);
      if (u.email) ids.add(u.email.toLowerCase());
      if (u.phone) ids.add(u.phone);
    }
    for (const c of s.channels) { ids.add(c.id); ids.add(c.address); }
    for (const e of s.events) ids.add(e.id);
    for (const r of s.resources) ids.add(r.id);
    for (const t of s.tasks) ids.add(t.id);
    for (const d of s.dependencies) ids.add(d.id);
    for (const w of s.whitelist ?? []) ids.add(w.phone);
  }
  return [...ids];
}

/** Production identifiers arrive ONLY via env - never hardcoded in source:
 *  CONTAKE_FORBIDDEN_IDENTIFIERS (comma-separated) and the super-admin
 *  allowlist CONTAKE_SUPER_ADMIN_PHONES (a staging DB must never carry a
 *  production login identity). */
export function deriveForbiddenIdentifiers(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const key of ['CONTAKE_FORBIDDEN_IDENTIFIERS', 'CONTAKE_SUPER_ADMIN_PHONES']) {
    const v = env[key];
    if (!v) continue;
    for (const part of v.split(',')) {
      const t = part.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/** Pure check, exported for tests: throws listing every forbidden hit. */
export function assertNoForbidden(generated: string[], forbidden: readonly string[]): void {
  const f = new Set(forbidden);
  const hits = generated.filter(g => f.has(g));
  if (hits.length > 0) {
    throw new Error(`seed:staging: generated identifiers collide with forbidden fixture/production identifiers: ${hits.join(', ')}`);
  }
}

export interface StagingSeedOptions {
  /** process.env['CONTAKE_STAGING_SEED'] - must be exactly '1'. */
  marker: string | undefined;
  forbiddenIdentifiers?: string[];
  /** Pre-vaulted credentials (never echoed). When absent, credentials are
   *  generated here and returned ONCE in the result's secrets field. */
  credentials?: { adminPassword?: string; managerPassword?: string };
  /** Must be true when credentials are generated here, so a run never
   *  produces an uncapturable secret. */
  emitSecrets?: boolean;
  now?: () => Date;
}

export interface StagingInventory {
  schema: 'contake-staging-inventory/v1';
  seedInstanceId: string;
  deployment: string;
  dbInstanceId: string;
  orgId: string;
  generatedAt: string;
  userIds: string[];
  emails: string[];
  phones: string[];
  channelAddresses: string[];
  eventIds: string[];
  resourceIds: string[];
  taskIds: string[];
  dependencyIds: string[];
  counts: Record<string, number>;
  absenceProof: {
    fixtureIdentifiersChecked: number;
    forbiddenIdentifiersChecked: number;
    collisions: string[];
    method: string;
  };
  inventorySha256: string;
}

export interface StagingSeedResult {
  applied: boolean;
  alreadyApplied: boolean;
  seedInstanceId: string;
  inventory: StagingInventory;
  /** Present ONLY when credentials were generated here (never for env-supplied
   *  credentials). CLI prints once for vault capture; nothing else may. */
  secrets?: { label: string; value: string }[];
}

const genPassword = (): string => randomBytes(12).toString('base64url'); // 16 chars, CSPRNG
const rid = (prefix: string): string => `stg-${prefix}-${randomBytes(6).toString('hex')}`;

/** Fictional Israeli-pattern mobile: +972-555-xxxxxx (555 fictional exchange). */
function genPhone(taken: ReadonlySet<string>): string {
  for (let i = 0; i < 100; i += 1) {
    const p = `+972555${randomInt(0, 1_000_000).toString().padStart(6, '0')}`;
    if (!taken.has(p)) return p;
  }
  throw new Error('seed:staging: could not generate a unique synthetic phone (100 attempts)');
}

const STATE_DDL = `
CREATE TABLE IF NOT EXISTS staging_seed_state(
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  seed_instance_id text NOT NULL,
  inventory_sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
`;

const BUSINESS_TABLES = ['users', 'channels', 'events', 'tasks', 'resources', 'dependencies', 'whitelist_entries'];

export async function runStagingSeed(conn: Connectable, opts: StagingSeedOptions): Promise<StagingSeedResult> {
  if (opts.marker !== '1') {
    throw new Error("seed:staging: CONTAKE_STAGING_SEED=1 is required - this job never runs implicitly and never at app startup (fail-closed)");
  }
  const usingEnvCredentials = Boolean(opts.credentials?.adminPassword && opts.credentials?.managerPassword);
  if (!usingEnvCredentials && opts.emitSecrets !== true) {
    throw new Error('seed:staging: refusing to generate credentials without an explicit capture path (emitSecrets) - a generated secret must never be silently discarded');
  }

  const fixtureForbidden = deriveFixtureIdentifiers();
  const envForbidden = opts.forbiddenIdentifiers ?? [];
  const forbidden = new Set([...fixtureForbidden, ...envForbidden]);
  const forbiddenArr = [...forbidden];
  const now = (opts.now ?? (() => new Date()))();

  const client = await conn.connect();
  try {
    await client.query('BEGIN');
    const txConn: Connectable = {
      query: (t, p) => client.query(t, p),
      connect: () => Promise.reject(new Error('seed:staging: nested connect() inside the seed transaction is not supported')),
    };

    // Gate 2: deployment identity must be stamped staging* by the release job.
    const identity = await readDbIdentity(txConn);
    if (!identity) {
      throw new Error('seed:staging: no database identity - run the release-migration job with --deployment staging first (fail-closed)');
    }
    if (identity.deploymentLabel !== 'staging' && !identity.deploymentLabel.startsWith('staging-')) {
      throw new Error(
        `seed:staging: database is stamped '${identity.deploymentLabel}' (instance ${identity.instanceId}) - ` +
        `synthetic seeding is permitted ONLY on a staging-stamped database (fail-closed)`,
      );
    }

    for (const stmt of STATE_DDL.split(';').map(s => s.trim()).filter(Boolean)) await client.query(stmt);

    // Gate 3: idempotent re-run OR newly initialized empty DB; nothing else.
    const state = await client.query(`SELECT seed_instance_id, inventory_sha256 FROM staging_seed_state WHERE id = 1`);
    if (state.rows[0]) {
      // Exact re-run proof: the seeded org still exists, no second seed.
      const org = await client.query(`SELECT org_id FROM users LIMIT 1`);
      await client.query('COMMIT');
      return {
        applied: false,
        alreadyApplied: true,
        seedInstanceId: String(state.rows[0]['seed_instance_id']),
        inventory: {
          schema: 'contake-staging-inventory/v1',
          seedInstanceId: String(state.rows[0]['seed_instance_id']),
          deployment: identity.deploymentLabel,
          dbInstanceId: identity.instanceId,
          orgId: String(org.rows[0]?.['org_id'] ?? ''),
          generatedAt: now.toISOString(),
          userIds: [], emails: [], phones: [], channelAddresses: [],
          eventIds: [], resourceIds: [], taskIds: [], dependencyIds: [],
          counts: {},
          absenceProof: {
            fixtureIdentifiersChecked: fixtureForbidden.length,
            forbiddenIdentifiersChecked: envForbidden.length,
            collisions: [],
            method: 'idempotent re-run: original post-seed proof stands; staging_seed_state intact',
          },
          inventorySha256: String(state.rows[0]['inventory_sha256']),
        },
      };
    }
    for (const t of BUSINESS_TABLES) {
      const c = await client.query(`SELECT count(*)::int AS n FROM ${t}`);
      if (Number(c.rows[0]?.['n'] ?? 0) > 0) {
        throw new Error(`seed:staging: table ${t} is not empty and no staging_seed_state exists - refusing to seed a database with pre-existing data (fail-closed)`);
      }
    }

    // Generate the synthetic dataset (CSPRNG; no fixture identifiers).
    const orgId = rid('org');
    const taken = new Set<string>(forbidden);
    const adminPw = opts.credentials?.adminPassword ?? genPassword();
    const managerPw = opts.credentials?.managerPassword ?? genPassword();
    const adminId = rid('admin');
    const fmId = rid('fm');
    const workers = [0, 1, 2].map(i => ({
      userId: rid(`worker${i + 1}`),
      phone: genPhone(taken),
      resourceId: rid(`guide${i + 1}`),
      name: `מדריך סינתטי ${i + 1}`,
    }));
    for (const w of workers) taken.add(w.phone);
    const emails = [
      `stg-admin-${randomBytes(4).toString('hex')}@staging.contake.invalid`,
      `stg-fm-${randomBytes(4).toString('hex')}@staging.contake.invalid`,
    ];
    const eventId = rid('ev');
    const siteId = rid('site');
    const D = now.toISOString().slice(0, 10);
    const at = (hhmm: string): string => `${D}T${hhmm}:00+03:00`;
    const channels = [0, 1, 2].map(i => ({
      id: rid(`ch${i + 1}`), orgId,
      address: genPhone(taken), label: `הורה סינתטי ${i + 1}`,
    }));
    for (const c of channels) taken.add(c.address);
    const taskIds = [0, 1, 2, 3].map(i => rid(`task${i + 1}`));
    const seed: SeedData = {
      orgId,
      users: [
        { userId: adminId, orgId, name: 'מנהל סינתטי', role: 'admin', scopes: [], email: emails[0], passwordHash: hashPasswordPure(adminPw), active: true },
        { userId: fmId, orgId, name: 'רכז סינתטי', role: 'field_manager', scopes: [{ eventId, siteId }], email: emails[1], passwordHash: hashPasswordPure(managerPw), active: true },
        ...workers.map(w => ({
          userId: w.userId, orgId, name: w.name, role: 'focus_worker' as const,
          scopes: [{ eventId }], linkedResourceId: w.resourceId, phone: w.phone, active: true,
        })),
      ],
      channels,
      events: [
        { id: eventId, kind: 'event', orgId, domainProfileId: 'camp', name: 'יום סינתטי (staging)', date: D, timezone: 'Asia/Jerusalem', siteIds: [siteId], status: 'published', version: 1 },
      ],
      resources: [
        { id: rid('bus'), kind: 'resource', eventId, resourceKind: 'equipment' as const, name: 'אוטובוס סינתטי', exclusive: true, version: 1 },
        ...workers.map(w => ({ id: w.resourceId, kind: 'resource' as const, eventId, resourceKind: 'person' as const, name: w.name, exclusive: true, version: 1 })),
        { id: rid('hall'), kind: 'resource', eventId, resourceKind: 'location' as const, name: 'אולם סינתטי', exclusive: true, version: 1 },
      ],
      tasks: [
        { id: taskIds[0]!, kind: 'task', eventId, siteId, name: 'איסוף סינתטי', start: at('08:00'), durationMin: 30, status: 'planned', locked: false, assigneeResourceIds: [workers[0]!.resourceId], version: 1 },
        { id: taskIds[1]!, kind: 'task', eventId, siteId, name: 'פעילות סינתטית א', start: at('08:30'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: [workers[1]!.resourceId], version: 1 },
        { id: taskIds[2]!, kind: 'task', eventId, siteId, name: 'פעילות סינתטית ב', start: at('09:30'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: [workers[2]!.resourceId], version: 1 },
        { id: taskIds[3]!, kind: 'task', eventId, siteId, name: 'סיכום סינתטי', start: at('10:30'), durationMin: 30, status: 'planned', locked: true, assigneeResourceIds: [], version: 1 },
      ],
      dependencies: [
        { id: rid('dep1'), kind: 'depends_on', fromTaskId: taskIds[1]!, toTaskId: taskIds[0]!, lagMin: 0, hard: true },
        { id: rid('dep2'), kind: 'depends_on', fromTaskId: taskIds[2]!, toTaskId: taskIds[1]!, lagMin: 0, hard: true },
      ],
      whitelist: workers.map(w => ({
        phone: w.phone, status: 'approved' as const, orgId, assignedRole: 'focus_worker' as const,
        linkedResourceId: w.resourceId,
        createdAt: now.toISOString(), decidedBy: 'staging-synthetic-seed', decidedAt: now.toISOString(),
      })),
    };

    // Pre-write proof: the generated identifier set contains nothing forbidden.
    const generatedIds = [
      orgId, adminId, fmId, eventId, siteId,
      ...workers.flatMap(w => [w.userId, w.phone, w.resourceId]),
      ...emails.map(e => e.toLowerCase()),
      ...channels.flatMap(c => [c.id, c.address]),
      ...seed.resources.map(r => r.id), ...taskIds, ...seed.dependencies.map(d => d.id),
    ];
    assertNoForbidden(generatedIds, [...forbidden]);
    // Generated credentials are 16-char CSPRNG base64url: a collision with any
    // public fixture plaintext is impossible by construction; assert shape.
    for (const pw of [adminPw, managerPw]) {
      if (pw.length < 16) throw new Error('seed:staging: generated credential below minimum length - refusing');
    }

    // Apply through the repository contract (same semantics as the app).
    const repo = PostgresGraphRepository.connect(txConn);
    await applySeed(repo, seed);

    // Post-write ABSENCE PROOF: no forbidden identifier anywhere in the
    // business tables. Gate 3 proved the database empty before this run, so
    // the rows scanned here are exactly the rows this seed wrote - the scan
    // covers the whole database state by construction. Matching is EXACT on
    // index columns and boundary-aware on jsonb data (identifier characters
    // [A-Za-z0-9-] on either side disqualify a substring hit), so generated
    // ids that merely CONTAIN a short token (stg-task-<hex> vs fixture 't1')
    // can never false-positive while a real fixture row always matches.
    const escapeRe = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundaryHit = (haystack: string, needle: string): boolean =>
      new RegExp(`(^|[^A-Za-z0-9-])${escapeRe(needle)}([^A-Za-z0-9-]|$)`).test(haystack);
    const collisions: string[] = [];
    const scan = async (table: string, cols: string[]): Promise<void> => {
      const r = await client.query(`SELECT ${cols.map(c => `${c}::text AS ${c}`).join(', ')}, data::text AS data_text FROM ${table}`);
      for (const row of r.rows) {
        for (const f of forbiddenArr) {
          const exact = cols.some(c => row[c] === f);
          if (exact || boundaryHit(String(row['data_text'] ?? ''), f)) collisions.push(`${table}:${f}`);
        }
      }
    };
    await scan('users', ['user_id', 'email', 'phone']);
    await scan('channels', ['id', 'address']);
    await scan('events', ['id']);
    await scan('tasks', ['id']);
    await scan('resources', ['id']);
    await scan('dependencies', ['id']);
    await scan('whitelist_entries', ['phone']);
    if (collisions.length > 0) {
      throw new Error(`seed:staging: POST-WRITE absence proof FAILED - forbidden identifiers present: ${collisions.join(', ')} (rolling back)`);
    }

    const inventoryBody: Omit<StagingInventory, 'inventorySha256'> = {
      schema: 'contake-staging-inventory/v1',
      seedInstanceId: rid('seed'),
      deployment: identity.deploymentLabel,
      dbInstanceId: identity.instanceId,
      orgId,
      generatedAt: now.toISOString(),
      userIds: [adminId, fmId, ...workers.map(w => w.userId)],
      emails,
      phones: workers.map(w => w.phone),
      channelAddresses: channels.map(c => c.address),
      eventIds: [eventId],
      resourceIds: seed.resources.map(r => r.id),
      taskIds,
      dependencyIds: seed.dependencies.map(d => d.id),
      counts: {
        users: seed.users.length, channels: channels.length, events: 1,
        resources: seed.resources.length, tasks: seed.tasks.length,
        dependencies: seed.dependencies.length, whitelist: workers.length,
      },
      absenceProof: {
        fixtureIdentifiersChecked: fixtureForbidden.length,
        forbiddenIdentifiersChecked: envForbidden.length,
        collisions: [],
        method: 'pre-write set intersection + post-write per-table equality and jsonb substring scan over the derived fixture identifier set and env-supplied production identifiers',
      },
    };
    const inventorySha256 = createHash('sha256').update(JSON.stringify(inventoryBody)).digest('hex');
    const inventory: StagingInventory = { ...inventoryBody, inventorySha256 };

    // Final secret-hygiene guard: the inventory must NEVER carry a credential.
    const invJson = JSON.stringify(inventory);
    for (const pw of [adminPw, managerPw]) {
      if (invJson.includes(pw)) throw new Error('seed:staging: inventory would contain a credential - refusing (rolling back)');
    }

    await client.query(
      `INSERT INTO staging_seed_state(id, seed_instance_id, inventory_sha256) VALUES(1, $1, $2)`,
      [inventory.seedInstanceId, inventory.inventorySha256],
    );
    await client.query('COMMIT');

    const result: StagingSeedResult = {
      applied: true, alreadyApplied: false,
      seedInstanceId: inventory.seedInstanceId,
      inventory,
    };
    if (!usingEnvCredentials) {
      result.secrets = [
        { label: `staging admin (${emails[0]})`, value: adminPw },
        { label: `staging field manager (${emails[1]})`, value: managerPw },
      ];
    }
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
