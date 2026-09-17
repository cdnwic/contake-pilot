/** Hotfix (priority-zero, 2026-09-17): fail-closed boot configuration.
 *  Every production-shaped knob resolves HERE, in one audited place:
 *  - CONTAKE_AUTH_SECRET: required (non-empty) whenever DATABASE_URL is set
 *    (postgres/production boot); missing/empty refuses to boot. Memory/dev
 *    falls back to an explicit NON-DEPLOYABLE local constant, never to a
 *    silent shared default.
 *  - CONTAKE_DEV_OTP: the OTP devCode is exposed by the API only when this is
 *    EXACTLY 'true'. Unset, empty, or any garbage value is closed.
 *  - CONTAKE_SEED: a demo seed is applied only on an EXPLICIT recognized
 *    value ('demo' | 'camp-demo' | 'all-demo'). Unset (or unrecognized) means
 *    NO seed - production boots seed-free. */

/** Explicit non-deployable local secret: memory-adapter dev and tests only.
 *  A postgres boot never sees this value (resolveAuthSecret throws first). */
export const LOCAL_DEV_AUTH_SECRET = 'contake-local-dev-secret-NOT-DEPLOYABLE';

export function resolveAuthSecret(env: NodeJS.ProcessEnv = process.env): string {
  const s = env['CONTAKE_AUTH_SECRET'];
  if (typeof s === 'string' && s.length > 0) return s;
  if (env['DATABASE_URL']) {
    throw new Error('CONTAKE_AUTH_SECRET is missing or empty while DATABASE_URL is set - refusing to boot (fail-closed)');
  }
  return LOCAL_DEV_AUTH_SECRET;
}

/** Exact-opt-in dev OTP exposure: only the literal string 'true' opens it. */
export function devOtpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['CONTAKE_DEV_OTP'] === 'true';
}

export type SeedMode = 'demo' | 'camp-demo' | 'all-demo' | undefined;

/** Seed only on an EXPLICIT recognized value; unset/unrecognized -> none. */
export function resolveSeedMode(env: NodeJS.ProcessEnv = process.env): SeedMode {
  const v = env['CONTAKE_SEED'];
  return v === 'demo' || v === 'camp-demo' || v === 'all-demo' ? v : undefined;
}
