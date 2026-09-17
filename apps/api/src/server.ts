import { RBAC_MATRIX_VERSION } from '@contake/core';
import { buildApp } from './app.js';
import { AuthService, type OtpStateStore } from './auth.js';
import { MemoryGraphRepository } from './repo/memory.js';
import { PostgresGraphRepository, pgDispatchState, createPgOtpState } from './repo/postgres.js';
import type { GraphRepository } from './repo/graph-repository.js';
import { applySeed, seedDemo } from './seed.js';
import { createRealtime } from './realtime.js';
import { assembleServer } from './server-assembly.js';
import type { MessageProvider } from './services/dispatch.js';
import { createTwilioProvider, twilioConfigFromEnv } from './services/twilio.js';
import { createWhatsAppCloudProvider, whatsAppCloudConfigFromEnv } from './services/whatsapp-cloud.js';
import { createLogPushProvider, createVapidPushProvider, vapidConfigFromEnv } from './services/webpush.js';
import { campDemoSeed, campWhitelistEntries, ensureCampDemoStaging, ensureCampWhitelist } from './demo/camp-demo.js';
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
let serverPool: import('./repo/postgres.js').Queryable | undefined;
let otpState: OtpStateStore | undefined;
// CONTAKE_SEED=camp-demo loads the rich camp-day demo dataset (plan 3ח);
// CONTAKE_SEED=all-demo loads camp + all six vertical seeds (Stage 1: one org
// per vertical, D = current Jerusalem date at boot; memory-mode re-seed makes
// re-anchoring free - restart with a fresh D before a demo);
// anything else (or unset) loads the compact QA demo seed.
const jerusalemToday = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const pickSeed = () => (process.env['CONTAKE_SEED'] === 'camp-demo' ? campDemoSeed() : seedDemo());
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
  serverPool = pool as unknown as import('./repo/postgres.js').Queryable;
  repo = await PostgresGraphRepository.create(pool);
  const seed = pickSeed();
  if ((await repo.listEvents(seed.orgId)).length === 0) {
    await applySeed(repo, seed);
    console.log('Postgres: empty database, demo seed applied');
  } else if (process.env['CONTAKE_SEED'] === 'camp-demo') {
    // TL 2026-09-14: QA staging slice is additive-if-absent - the prod DB already
    // holds cd-ev1 (Chaim's live event), which this never touches.
    await ensureCampDemoStaging(repo);
    console.log('Postgres: camp-demo QA staging slice ensured (additive-if-absent)');
  }
  // v1.18 §15 camp protection: pilot phones pre-approved on every boot
  // (idempotent upsert on phone; zero camp behavior change).
  await ensureCampWhitelist(repo);
  otpState = await createPgOtpState(pool); // pilot-prep #4: shared OTP state
  console.log('Contake API: Postgres adapter (DATABASE_URL)');
} else if (process.env['CONTAKE_SEED'] === 'all-demo') {
  repo = new MemoryGraphRepository();
  for (const seed of allDemoSeeds()) await applySeed(repo, seed);
  console.log('Contake API: memory adapter, all-demo composite seed (camp + 6 verticals, D=' + jerusalemToday() + ')');
} else {
  repo = MemoryGraphRepository.seeded(pickSeed());
}
const auth = new AuthService(repo, undefined, undefined, otpState);

// Notification providers (secrets env-only, QA-M3-4). Precedence:
// WhatsApp Cloud API (PR-2, Meta-native) > Twilio sandbox (M3) > log-sandbox.
// SMS is PARKED per TL ruling: only wired when Twilio env exists (already
// built at M3), otherwise log-sandbox. Nothing connects externally without env.
const waCloudCfg = whatsAppCloudConfigFromEnv();
const twilioCfg = twilioConfigFromEnv();
const sandboxProvider = (name: 'whatsapp' | 'sms'): MessageProvider => ({
  name,
  send: (to, body) => { console.log(`[${name} sandbox] -> ${to}: ${body}`); return Promise.resolve({ ok: true, providerMessageId: `${name}-sandbox-${Date.now()}`, retryable: false }); },
});
const providers: { whatsapp: MessageProvider; sms: MessageProvider } = {
  whatsapp: waCloudCfg
    ? createWhatsAppCloudProvider(waCloudCfg)
    : twilioCfg ? createTwilioProvider('whatsapp', twilioCfg) : sandboxProvider('whatsapp'),
  sms: twilioCfg ? createTwilioProvider('sms', twilioCfg) : sandboxProvider('sms'),
};
// Web push (contracts v1.10): real VAPID only when keys are in env; otherwise
// the log-only sandbox provider. No external account, no cost.
const vapid = vapidConfigFromEnv();
const pushProvider = vapid ? createVapidPushProvider(vapid) : createLogPushProvider();
// G2 stop-ship (2026-09-17): THE server assembly creates exactly ONE
// DispatchStateStore (pg when DATABASE_URL, memory otherwise) and injects the
// SAME object into buildApp and the send-side dispatcher, unconditionally.
const { app, dispatcher } = assembleServer({
  repo, auth, providers, push: pushProvider,
  ...(serverPool ? { pool: serverPool } : {}),
});
const port = Number(process.env['PORT'] ?? 3000);
app.listen({ port, host: '0.0.0.0' }).then(() => {
  createRealtime(app.server, repo, auth);
  console.log(`Notification providers: whatsapp=${waCloudCfg ? 'whatsapp-cloud' : twilioCfg ? 'twilio' : 'log-sandbox'}, sms=${twilioCfg ? 'twilio' : 'log-sandbox (SMS parked)'}`);
  console.log(`Web push: ${vapid ? 'VAPID (web-push)' : 'log-sandbox (no VAPID keys)'}`);
  const timer = setInterval(() => { void dispatcher.dispatchDue(); }, 5_000);
  timer.unref();
  console.log(`Contake API listening on :${port} (seeded demo org: camp + film-shoot; realtime + dispatch on)`);
});
