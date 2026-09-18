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

/** Defensible minimum for an HMAC signing secret: 32 chars. NOTE: length alone
 *  is NOT sufficient - the encoding policy below is the real gate. */
export const MIN_AUTH_SECRET_LENGTH = 32;

/** Encoding policy (independent security review v2, 2026-09-18): the ONLY
 *  accepted representation is canonical 64-char lowercase hex of exactly 32
 *  bytes (decode/re-encode equality holds by construction; uppercase is
 *  non-canonical and rejected). Generate with `openssl rand -hex 32`, never
 *  by hand. The runtime validates SHAPE ONLY - it cannot prove randomness;
 *  CSPRNG generation is an operational requirement enforced by review and by
 *  the documented-generator release checks, not by this parser. Anything
 *  else - passphrases, base64 variants, padded/truncated encodings, repeated
 *  cycles - fails closed. */
const SECRET_HEX64_CANONICAL = /^[0-9a-f]{64}$/;

/** Values that must NEVER authenticate anything, anywhere. */
const KNOWN_FALLBACK_SECRETS: ReadonlySet<string> = new Set([
  'contake-dev-secret', // the removed v0 hardcoded fallback
  LOCAL_DEV_AUTH_SECRET,
  // PERMANENTLY DENIED (independent security, 2026-09-18): real CSPRNG outputs
  // that were exposed in committed public fixtures/evidence. Shape-valid but
  // publicly known - must never authenticate anywhere.
  '37115fa1d12be597cd6c1aba5cbf92508072d305edfc59082cc6c963e1d0a674',
  'aKhvRtkVHp1roRMXlvPw6QamCfBEPoeRt107EaxlDH8',
]);

/** Exported for the denial regression test: every entry must be refused. */
export const DENIED_SECRETS: ReadonlySet<string> = KNOWN_FALLBACK_SECRETS;

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
    if (/^(.)\1+$/.test(s)) {
      throw new Error('CONTAKE_AUTH_SECRET is a single repeated character - refusing to boot (fail-closed)');
    }
    if (!SECRET_HEX64_CANONICAL.test(s)) {
      throw new Error('CONTAKE_AUTH_SECRET must be exactly 32 random bytes as canonical 64-char lowercase hex (openssl rand -hex 32) - refusing to boot (fail-closed)');
    }
    // Shape is not entropy: reject periodic/cyclic values ('abab...',
    // '0123456789abcdef' x4) and low-diversity placeholders outright.
    for (let p = 1; p <= 32; p += 1) {
      if (64 % p === 0 && s === s.slice(0, p).repeat(64 / p)) {
        throw new Error('CONTAKE_AUTH_SECRET is a repeated cycle (placeholder-grade, format-matching but predictable) - refusing to boot (fail-closed)');
      }
    }
    if (new Set(s).size < 12) {
      throw new Error('CONTAKE_AUTH_SECRET has too little character diversity (placeholder-grade) - refusing to boot (fail-closed)');
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
