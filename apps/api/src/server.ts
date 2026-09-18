import { RBAC_MATRIX_VERSION } from '@contake/core';
import { buildApp } from './app.js';
import { AuthService, type OtpStateStore } from './auth.js';
import { MemoryGraphRepository } from './repo/memory.js';
import { PostgresGraphRepository, pgDispatchState, createPgOtpState } from './repo/postgres.js';
import { assertSchemaCurrent } from './migrations/runner.js';
import type { GraphRepository } from './repo/graph-repository.js';
import { applySeed, seedDemo } from './seed.js';
import { assertBootPolicy, resolveAuthSecret, resolveSeedMode } from './boot-config.js';
import { createRealtime } from './realtime.js';
import { createDispatcher, type DispatchStateStore, type MessageProvider } from './services/dispatch.js';
import { createTwilioProvider, twilioConfigFromEnv } from './services/twilio.js';
import { createWhatsAppCloudProvider, whatsAppCloudConfigFromEnv } from './services/whatsapp-cloud.js';
import { createLogPushProvider, createVapidPushProvider, vapidConfigFromEnv } from './services/webpush.js';
import { campDemoSeed, campWhitelistEntries } from './demo/camp-demo.js';
import { seedFilmShoot } from './seeds/film-shoot.seed.js';
import { seedEventProduction } from './seeds/event-production.seed.js';
import { seedEducation } from './seeds/education.seed.js';
import { seedAfterSchool } from './seeds/after-school.seed.js';
import { seedConference } from './seeds/conference.seed.js';
import { seedLogistics } from './seeds/logistics.seed.js';
import type { SeedData } from './repo/graph-repository.js';

// Deploy pin check (boot addendum 2026-09-17): the pinned matrix version is
// single-sourced HERE. Boot fails loudly when the loaded matrix drop-in does
// not match the pin. File-hash pinning happens at review/build time (the pinned
// sha256 is checked against TL-published hashes before deploy); the compiled
// runtime asserts the version marker of the actually-loaded matrix.
export const PINNED_MATRIX_VERSION = '1.6';
if (RBAC_MATRIX_VERSION !== PINNED_MATRIX_VERSION) {
  throw new Error(`RBAC matrix pin mismatch: expected v${PINNED_MATRIX_VERSION}, loaded v${RBAC_MATRIX_VERSION} - refusing to boot`);
}

// PR-1: env-selected storage adapter. DATABASE_URL set -> Postgres (real
// transactions, durable dispatch state); unset -> in-memory (test/dev default).
let repo: GraphRepository;
let dispatchState: DispatchStateStore | undefined;
let otpState: OtpStateStore | undefined;
// Seed policy (fail-closed hotfix 2026-09-17): a demo seed is applied ONLY on
// an explicit recognized CONTAKE_SEED value. UNSET or unrecognized means NO
// SEED - production boots seed-free.
//   CONTAKE_SEED=demo      compact QA demo seed
//   CONTAKE_SEED=camp-demo rich camp-day demo dataset (plan 3ח)
//   CONTAKE_SEED=all-demo  camp + all six vertical seeds (Stage 1: one org per
//                          vertical, D = current Jerusalem date at boot; memory
//                          mode only, re-anchoring free - restart fresh before a demo)
// Auth secret policy: CONTAKE_AUTH_SECRET is REQUIRED (non-empty) whenever
// DATABASE_URL is set; a postgres/production boot with it missing or empty
// REFUSES to boot (resolveAuthSecret throws before any DB work). Memory/dev
// uses an explicit non-deployable local constant.
const jerusalemToday = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
// Fail-closed FIRST, before any DB/network work: production invariants, then
// the secret. A violating boot dies here.
assertBootPolicy();
const seedMode = resolveSeedMode();
const authSecret = resolveAuthSecret();
const allDemoSeeds = (): SeedData[] => {
  const D = jerusalemToday();
  const verticals = [seedFilmShoot(D), seedEventProduction(D), seedEducation(D), seedAfterSchool(D), seedConference(D), seedLogistics(D)];
  // v1.18 §15: vertical phone users (focus workers) pre-approved; camp pilot
  // phones come from the shared campWhitelistEntries() source. Admin/manager
  // users authenticate email+password and need no whitelist row.
  return [
    { ...campDemoSeed(), whitelist: campWhitelistEntries() },
    ...verticals.map(seed => ({
      ...seed,
      whitelist: seed.users.filter(u => u.phone).map(u => ({
        phone: u.phone as string, status: 'approved' as const, orgId: u.orgId,
        assignedRole: u.role,
        ...(u.linkedResourceId ? { linkedResourceId: u.linkedResourceId } : {}),
        createdAt: new Date().toISOString(), decidedBy: 'system-seed', decidedAt: new Date().toISOString(),
      })),
    })),
  ];
};
if (process.env['DATABASE_URL']) {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
  // Release-migration architecture (2026-09-18): schema is owned ONLY by the
  // explicit versioned release-migration job; startup verifies the exact
  // expected migration versions and FAILS CLOSED on any mismatch. A Postgres
  // boot NEVER applies DDL and NEVER seeds: production is seed-free
  // (assertBootPolicy) and staging data comes only from the explicit
  // synthetic-only `seed:staging` job. The former boot-time demo/camp-demo PG
  // seeding path is removed with this change.
  // Independent security (2026-09-18): a Postgres boot must verify the
  // EXPECTED DEPLOYMENT against the database's stamped immutable identity
  // before serving - a runtime pointed at another deployment's database
  // fails closed. CONTAKE_DEPLOYMENT is required for every PG boot.
  const expectedDeployment = process.env['CONTAKE_DEPLOYMENT'];
  if (!expectedDeployment) {
    throw new Error('CONTAKE_DEPLOYMENT is required for a Postgres boot - the runtime must declare which deployment identity it expects (fail-closed)');
  }
  await assertSchemaCurrent(pool, undefined, { deployment: expectedDeployment });
  repo = PostgresGraphRepository.connect(pool);
  dispatchState = pgDispatchState(pool);
  otpState = await createPgOtpState(pool, { applyDdl: false }); // pilot-prep #4: shared OTP state (schema via migrations)
  console.log('Contake API: Postgres adapter (DATABASE_URL); schema at expected migration version; no boot seeding (release-migration architecture)');
} else if (seedMode === 'all-demo') {
  repo = new MemoryGraphRepository();
  for (const seed of allDemoSeeds()) await applySeed(repo, seed);
  console.log('Contake API: memory adapter, all-demo composite seed (camp + 6 verticals, D=' + jerusalemToday() + ')');
} else {
  repo = new MemoryGraphRepository();
  const seed = seedMode === 'demo' ? seedDemo() : seedMode === 'camp-demo' ? campDemoSeed() : undefined;
  if (seed) {
    await applySeed(repo, seed);
    console.log(`Contake API: memory adapter, ${seedMode} seed applied (explicit CONTAKE_SEED)`);
  } else {
    console.log('Contake API: memory adapter, CONTAKE_SEED unset/unrecognized - NO seed (production seed-free)');
  }
}
const auth = new AuthService(repo, authSecret, undefined, otpState);
const app = buildApp(repo, auth);

const port = Number(process.env['PORT'] ?? 3000);
app.listen({ port, host: '0.0.0.0' }).then(() => {
  createRealtime(app.server, repo, auth);
  // Notification providers (secrets env-only, QA-M3-4). Precedence:
  // WhatsApp Cloud API (PR-2, Meta-native) > Twilio sandbox (M3) > log-sandbox.
  // SMS is PARKED per TL ruling: only wired when Twilio env exists (already
  // built at M3), otherwise log-sandbox. Nothing connects externally without env.
  const waCloudCfg = whatsAppCloudConfigFromEnv();
  const twilioCfg = twilioConfigFromEnv();
  const sandbox = (name: 'whatsapp' | 'sms'): MessageProvider => ({
    name,
    send: (to, body) => { console.log(`[${name} sandbox] -> ${to}: ${body}`); return Promise.resolve({ ok: true, providerMessageId: `${name}-sandbox-${Date.now()}`, retryable: false }); },
  });
  const providers: { whatsapp: MessageProvider; sms: MessageProvider } = {
    whatsapp: waCloudCfg
      ? createWhatsAppCloudProvider(waCloudCfg)
      : twilioCfg ? createTwilioProvider('whatsapp', twilioCfg) : sandbox('whatsapp'),
    sms: twilioCfg ? createTwilioProvider('sms', twilioCfg) : sandbox('sms'),
  };
  console.log(`Notification providers: whatsapp=${waCloudCfg ? 'whatsapp-cloud' : twilioCfg ? 'twilio' : 'log-sandbox'}, sms=${twilioCfg ? 'twilio' : 'log-sandbox (SMS parked)'}`);
  // Web push (contracts v1.10): real VAPID only when keys are in env; otherwise
  // the log-only sandbox provider. No external account, no cost.
  const vapid = vapidConfigFromEnv();
  const pushProvider = vapid ? createVapidPushProvider(vapid) : createLogPushProvider();
  console.log(`Web push: ${vapid ? 'VAPID (web-push)' : 'log-sandbox (no VAPID keys)'}`);
  const dispatcher = createDispatcher({ repo, providers, push: pushProvider, ...(dispatchState ? { state: dispatchState } : {}) });
  const timer = setInterval(() => { void dispatcher.dispatchDue(); }, 5_000);
  timer.unref();
  console.log(`Contake API listening on :${port} (seed: ${seedMode ?? 'none - production seed-free'}; realtime + dispatch on)`);
});
