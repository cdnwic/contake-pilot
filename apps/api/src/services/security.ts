import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** v1.20.2 remediation security primitives. */

// ---- status tokens (§24.1א): HMAC-SHA256(token, pepper), pepper env-only ----
export interface PepperSet { current: string; previous?: string }

export function peppersFromEnv(): PepperSet {
  const current = process.env['CONTAKE_TOKEN_PEPPER_CURRENT'] ?? process.env['CONTAKE_TOKEN_PEPPER'];
  const previous = process.env['CONTAKE_TOKEN_PEPPER_PREVIOUS'];
  if (current) return previous ? { current, previous } : { current };
  if (process.env['CONTAKE_TEST_MODE'] === 'true') return { current: 'contake-test-pepper' };
  // Fail-closed like the webhook secret: no pepper configured outside explicit
  // test mode means token issuance/verification cannot run.
  throw new Error('CONTAKE_TOKEN_PEPPER_CURRENT (or CONTAKE_TOKEN_PEPPER) is required outside CONTAKE_TEST_MODE=true');
}

export function hashToken(pepper: string, token: string): string {
  return createHmac('sha256', pepper).update(token).digest('hex');
}

/** >=128 bit entropy (24 random bytes, base64url). Never Date.now/Math.random. */
export function mintStatusToken(): string {
  return randomBytes(24).toString('base64url');
}

export function tokenTtlMs(): number {
  const hours = Number(process.env['CONTAKE_TOKEN_TTL_HOURS'] ?? 72);
  return (Number.isFinite(hours) && hours > 0 ? hours : 72) * 3_600_000;
}

// ---- timing-safe secret compare (§25.1א) ----
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    // Compare against self to keep the timing path, then report unequal.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

// ---- audit PII masking (v2.1 #7): sha256(address)[:12] + last 4 digits ----
export function maskAddress(address: string): string {
  const h = createHash('sha256').update(address).digest('hex').slice(0, 12);
  const digits = address.replace(/\D/g, '');
  return `${h}:${digits.slice(-4)}`;
}

export const normalizeAddress = (a: string): string => a.trim();

export const bodyHashOf = (s: string): string => createHash('sha256').update(s).digest('hex');

// ---- idempotency requestHash: sha256 of the normalized (key-sorted) body ----
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}
export const requestHashOf = (body: unknown): string => createHash('sha256').update(stableStringify(body ?? null)).digest('hex');

// ---- tiny in-memory fixed-window rate limiter (per process) ----
const buckets = new Map<string, { count: number; resetAt: number }>();
/** Returns true when the call is within the limit. */
export function rateOk(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count += 1;
  return true;
}
/** Test hook: clear all buckets. */
export function rateResetAll(): void { buckets.clear(); }
