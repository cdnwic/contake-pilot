/** Fail-closed boot configuration (priority-zero hotfix v2, 2026-09-17;
 *  revised after independent QA/security FAIL of v1):
 *  - CONTAKE_AUTH_SECRET: trimmed, must NOT match a known fallback/dev value,
 *    must be >= MIN_AUTH_SECRET_LENGTH chars. Required whenever the boot is
 *    production-shaped (DATABASE_URL set OR NODE_ENV=production), regardless
 *    of which adapter ends up selected. Memory/dev-only boots fall back to an
 *    explicit NON-DEPLOYABLE local constant.
 *  - Production (NODE_ENV=production) invariants, enforced before any DB or
 *    network work: DATABASE_URL required (no silent memory fallback),
 *    CONTAKE_TEST_MODE=true forbidden, CONTAKE_SEED forbidden (production is
 *    seed-free), CONTAKE_DEV_OTP=true forbidden.
 *  - CONTAKE_DEV_OTP: the OTP devCode is exposed only for EXACTLY 'true'
 *    (and never in production, per the invariant above).
 *  - CONTAKE_SEED: demo seed only on an explicit recognized value
 *    ('demo' | 'camp-demo' | 'all-demo'), never in production. */

/** Explicit non-deployable local secret: memory-adapter dev and tests only.
 *  A production-shaped boot never sees this value (resolveAuthSecret throws
 *  first), and it is on the denylist if pasted into env. */
export const LOCAL_DEV_AUTH_SECRET = 'contake-local-dev-secret-NOT-DEPLOYABLE';

/** Defensible minimum for an HMAC signing secret: 32 chars. */
export const MIN_AUTH_SECRET_LENGTH = 32;

/** Values that must NEVER authenticate anything, anywhere. */
const KNOWN_FALLBACK_SECRETS: ReadonlySet<string> = new Set([
  'contake-dev-secret', // the removed v0 hardcoded fallback
  LOCAL_DEV_AUTH_SECRET,
]);

export function isProductionBoot(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['NODE_ENV'] === 'production';
}

export function resolveAuthSecret(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env['CONTAKE_AUTH_SECRET'];
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s.length > 0) {
    if (KNOWN_FALLBACK_SECRETS.has(s)) {
      throw new Error('CONTAKE_AUTH_SECRET matches a known fallback/dev value - refusing to boot (fail-closed)');
    }
    if (s.length < MIN_AUTH_SECRET_LENGTH) {
      throw new Error(`CONTAKE_AUTH_SECRET is shorter than ${MIN_AUTH_SECRET_LENGTH} characters - refusing to boot (fail-closed)`);
    }
    return s;
  }
  if (env['DATABASE_URL'] || isProductionBoot(env)) {
    throw new Error('CONTAKE_AUTH_SECRET is missing or empty in a production-shaped boot (DATABASE_URL and/or NODE_ENV=production) - refusing to boot (fail-closed)');
  }
  return LOCAL_DEV_AUTH_SECRET;
}

/** Production-boot invariants. Throws (refuses boot) on the first violation;
 *  a no-op outside NODE_ENV=production. */
export function assertBootPolicy(env: NodeJS.ProcessEnv = process.env): void {
  if (!isProductionBoot(env)) return;
  if (!env['DATABASE_URL']) {
    throw new Error('NODE_ENV=production requires DATABASE_URL - no memory-adapter fallback in production (fail-closed)');
  }
  if (env['CONTAKE_TEST_MODE'] === 'true') {
    throw new Error('CONTAKE_TEST_MODE=true is forbidden in production (test bypasses must never ship) - refusing to boot');
  }
  if (env['CONTAKE_DEV_OTP'] === 'true') {
    throw new Error('CONTAKE_DEV_OTP=true is forbidden in production (devCode must never ship) - refusing to boot');
  }
  const seed = env['CONTAKE_SEED'];
  if (seed !== undefined && seed !== '') {
    throw new Error('CONTAKE_SEED is forbidden in production - production boots seed-free (fail-closed)');
  }
}

/** Exact-opt-in dev OTP exposure: only the literal string 'true' opens it,
 *  and never in a production boot (assertBootPolicy). */
export function devOtpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['CONTAKE_DEV_OTP'] === 'true' && !isProductionBoot(env);
}

export type SeedMode = 'demo' | 'camp-demo' | 'all-demo' | undefined;

/** Seed only on an EXPLICIT recognized value; unset/unrecognized -> none.
 *  Production forbids every value (assertBootPolicy). */
export function resolveSeedMode(env: NodeJS.ProcessEnv = process.env): SeedMode {
  const v = env['CONTAKE_SEED'];
  return v === 'demo' || v === 'camp-demo' || v === 'all-demo' ? v : undefined;
}
