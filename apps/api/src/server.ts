import { RBAC_MATRIX_VERSION } from '@contake/core';
import { buildApp } from './app.js';
import { AuthService, type OtpStateStore } from './auth.js';
import { MemoryGraphRepository } from './repo/memory.js';
import { PostgresGraphRepository, pgDispatchState, createPgOtpState } from './repo/postgres.js';
import type { GraphRepository } from './repo/graph-repository.js';
import { applySeed, seedDemo } from './seed.js';
import { createRealtime } from './realtime.js';
import { createDispatcher, type DispatchStateStore, type MessageProvider } from './services/dispatch.js';
import { createTwilioProvider, twilioConfigFromEnv } from './services/twilio.js';
import { createWhatsAppCloudProvider, whatsAppCloudConfigFromEnv } from './services/whatsapp-cloud.js';
import { createLogPushProvider, createVapidPushProvider, vapidConfigFromEnv } from './services/webpush.js';
import { campDemoSeed, ensureCampDemoStaging } from './demo/camp-demo.js';

// Deploy pin check (contracts v1.12 / matrix v1.3): refuse boot on a wrong
// pinned matrix drop-in. File-hash pinning happens at review/build time (the
// pinned sha256 is checked against TL-published hashes before deploy); the
// compiled runtime asserts the version marker of the actually-loaded matrix.
const PINNED_MATRIX_VERSION = '1.3';
if (RBAC_MATRIX_VERSION !== PINNED_MATRIX_VERSION) {
  throw new Error(`RBAC matrix pin mismatch: expected v${PINNED_MATRIX_VERSION}, loaded v${RBAC_MATRIX_VERSION} - refusing to boot`);
}

// PR-1: env-selected storage adapter. DATABASE_URL set -> Postgres (real
// transactions, durable dispatch state); unset -> in-memory (test/dev default).
let repo: GraphRepository;
let dispatchState: DispatchStateStore | undefined;
let otpState: OtpStateStore | undefined;
// CONTAKE_SEED=camp-demo loads the rich camp-day demo dataset (plan 3ח);
// anything else (or unset) loads the compact QA demo seed.
const pickSeed = () => (process.env['CONTAKE_SEED'] === 'camp-demo' ? campDemoSeed() : seedDemo());
if (process.env['DATABASE_URL']) {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
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
  dispatchState = pgDispatchState(pool);
  otpState = await createPgOtpState(pool); // pilot-prep #4: shared OTP state
  console.log('Contake API: Postgres adapter (DATABASE_URL)');
} else {
  repo = MemoryGraphRepository.seeded(pickSeed());
}
const auth = new AuthService(repo, undefined, undefined, otpState);
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
  console.log(`Contake API listening on :${port} (seeded demo org: camp + film-shoot; realtime + dispatch on)`);
});
