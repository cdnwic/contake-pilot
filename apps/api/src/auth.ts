import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { ID, Principal, Role, Scope, WhitelistEntry, WhitelistStatus } from '@contake/core';
import type { GraphRepository, UserRecord } from './repo/graph-repository.js';
import { isCanonicalSandboxSession } from './repo/graph-repository.js';
import { SUPERADMIN_SANDBOX_ORG } from './services/superadmin.js';

/**
 * Alpha auth (architecture §2: JWT access 15' + OTP for field workers).
 * HMAC-signed bearer tokens; identity only — role/scopes are ALWAYS re-read from
 * the repository per request, so role changes and revocations take effect
 * immediately (QA AC-ISO-3), well inside the token TTL.
 */

const TOKEN_TTL_SEC = 15 * 60;
const OTP_TTL_SEC = 10 * 60;
const OTP_MAX_PER_WINDOW = 5;
const OTP_WINDOW_SEC = 10 * 60;
/** Pilot-prep #2: verify-attempt throttling. After this many consecutive wrong
 *  presentations against a LIVE code, the code is burned and verify locks. */
const OTP_VERIFY_MAX_ATTEMPTS = 5;
const OTP_LOCKOUT_SEC = 10 * 60;

const b64u = (buf: Buffer | string): string => Buffer.from(buf).toString('base64url');

export function hashPasswordPure(password: string): string {
  const salt = randomBytes(8).toString('hex');
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}

export interface OtpCodeEntry { code: string; exp: number }
export interface OtpVerifyState { attempts: number; lockedUntil?: number }
/** Pre-auth audit row (pilot-prep #2). Kept OUTSIDE the contracts AuditLogEntry:
 *  that shape requires orgId/eventId/actorUserId and its Action union is pinned
 *  (v1.9) — a pre-auth OTP event has neither an org context nor a pinned action. */
export interface AuthAuditEntry { phone: string; kind: string; detail?: unknown; createdAt?: string }

/** Pilot-prep #4: shared OTP state (multi-instance ready). Same adapter pattern
 *  as PR-1 DispatchStateStore: in-memory default for test/dev, Postgres adapter
 *  (createPgOtpState in repo/postgres.ts) when DATABASE_URL is set. */
export interface OtpStateStore {
  getCode(phone: string): Promise<OtpCodeEntry | undefined>;
  setCode(phone: string, entry: OtpCodeEntry): Promise<void>;
  deleteCode(phone: string): Promise<void>;
  /** Request-side rate-limit log: timestamps within the window (impl prunes on read). */
  recentRequests(phone: string, sinceMs: number): Promise<number[]>;
  recordRequest(phone: string, tsMs: number): Promise<void>;
  getVerifyState(phone: string): Promise<OtpVerifyState | undefined>;
  /** Atomic increment (multi-instance safe on the Postgres adapter). */
  incrementVerifyAttempts(phone: string): Promise<number>;
  /** Sets the lockout window and resets the attempt counter for the next window. */
  setLockout(phone: string, untilMs: number): Promise<void>;
  resetVerifyState(phone: string): Promise<void>;
  appendAuthAudit(entry: AuthAuditEntry): Promise<void>;
  listAuthAudit(phone?: string): Promise<AuthAuditEntry[]>;
}

export function memoryOtpState(): OtpStateStore {
  const codes = new Map<string, OtpCodeEntry>();
  const requests = new Map<string, number[]>();
  const verify = new Map<string, OtpVerifyState>();
  const auditLog: AuthAuditEntry[] = [];
  return {
    getCode: async p => codes.get(p),
    setCode: async (p, e) => { codes.set(p, e); },
    deleteCode: async p => { codes.delete(p); },
    recentRequests: async (p, since) => (requests.get(p) ?? []).filter(t => t > since),
    recordRequest: async (p, ts) => { requests.set(p, [...(requests.get(p) ?? []), ts]); },
    getVerifyState: async p => verify.get(p),
    incrementVerifyAttempts: async p => {
      const cur = verify.get(p) ?? { attempts: 0 };
      const next = { ...cur, attempts: cur.attempts + 1 };
      verify.set(p, next);
      return next.attempts;
    },
    setLockout: async (p, until) => { verify.set(p, { attempts: 0, lockedUntil: until }); },
    resetVerifyState: async p => { verify.delete(p); },
    appendAuthAudit: async e => { auditLog.push({ ...e, createdAt: e.createdAt ?? new Date().toISOString() }); },
    listAuthAudit: async p => (p ? auditLog.filter(a => a.phone === p) : [...auditLog]),
  };
}

/** Strict E.164 (pilot allowlist entries): + then 8-15 digits, first
 *  (country-code) digit non-zero. */
const E164_STRICT = /^\+[1-9]\d{7,14}$/;

/** QA lifecycle gate (2026-09-17): STRICT FAIL-LOUD parse of
 *  CONTAKE_SUPER_ADMIN_PHONES. Comma-separated, whitespace-trimmed, exact
 *  duplicates deduped; a malformed non-empty entry THROWS at boot (a
 *  mistyped allowlist must never silently run with fewer/more privileges
 *  than ops wrote). Empty/unset yields an EMPTY allowlist (fail CLOSED -
 *  no privileged phone), which is a valid, deliberate configuration.
 *  Approved real phone values live ONLY in the ops configuration record -
 *  never in code or tests. */
export function parseSuperAdminPhones(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const seg of raw.split(',')) {
    const entry = seg.trim();
    if (!entry) continue;
    if (!E164_STRICT.test(entry)) {
      throw new Error(`CONTAKE_SUPER_ADMIN_PHONES: malformed E.164 entry "${entry}" - refusing to boot with a corrupt allowlist`);
    }
    if (!seen.has(entry)) { seen.add(entry); out.push(entry); }
  }
  return out;
}

/** Super Admin phone allowlist (server-side, env-only). QA stop-ship
 *  (2026-09-17): FAIL CLOSED - there is NO hardcoded/default privileged
 *  phone. An unset CONTAKE_SUPER_ADMIN_PHONES means an empty allowlist: no
 *  phone enrolls as Super Admin, period. Ops sets the comma-separated
 *  allowlist explicitly per environment. Frontend state can never set this. */
// QA+security (2026-09-18): the backing array is MODULE-PRIVATE; the export
// is a detached FROZEN copy so no importer can mutate the live allowlist
// (same alias-hardening pattern as the auth-secret denylist).
const SUPER_ADMIN_PHONES_BACKING: readonly string[] = parseSuperAdminPhones(process.env['CONTAKE_SUPER_ADMIN_PHONES']);
export const SUPER_ADMIN_PHONES: readonly string[] = Object.freeze([...SUPER_ADMIN_PHONES_BACKING]);

/** QA lifecycle gate (2026-09-17): impersonation sessions expire
 *  server-side. Recommended pilot TTL: 15 minutes (matches the access-token
 *  TTL); enforced on EVERY authentication, never by the client. */
export const SANDBOX_SESSION_TTL_MS = 15 * 60 * 1000;

/** The pilot tenant a super admin enrolls into. */
export const SUPER_ADMIN_HOME_ORG = 'org-1';

/** Auth-secret + dev-OTP policy (SA hardening 2026-09-18, unified with the
 *  boot-config v2 fail-closed hotfix on the 282bbd3 merge 2026-09-19): the
 *  CANONICAL implementation lives in boot-config.ts - canonical 64-hex
 *  shape validation, denylist of known fallback + exposed public values,
 *  cycle/diversity refusal, explicit-test-mode gate for the dev fallback,
 *  and the deployed-boot refusal. This module re-exports that policy under
 *  the SA-lane names and adds the explicit-constructor-argument resolution
 *  form tests use. */
import {
  LOCAL_DEV_AUTH_SECRET, MIN_AUTH_SECRET_LENGTH, AuthSecretConfigError,
  isExplicitTestMode, resolveAuthSecret as resolveBootAuthSecret,
  devOtpEnabled, assertDeployedBoot,
} from './boot-config.js';

export { MIN_AUTH_SECRET_LENGTH, AuthSecretConfigError, isExplicitTestMode, assertDeployedBoot };

/** The explicit NON-DEPLOYABLE development secret (single constant, aliased:
 *  DEV_ONLY_AUTH_SECRET === LOCAL_DEV_AUTH_SECRET). It exists ONLY so
 *  hermetic tests can run without provisioning; it is reachable solely
 *  under explicit test mode and is refused as a managed value. A deployed
 *  build never sees it: the production entry point calls
 *  assertDeployedBoot(), which refuses test mode outright. */
export const DEV_ONLY_AUTH_SECRET = LOCAL_DEV_AUTH_SECRET;

/** Resolution order: an explicit constructor argument wins (tests inject
 *  their own); otherwise the fail-closed managed resolution in boot-config
 *  runs (managed env secret, or the dev fallback under explicit test mode
 *  only). */
export function resolveAuthSecret(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return explicit ?? resolveBootAuthSecret(env);
}

/** Dev OTP disclosure: exact 'true' opt-in AND explicit test mode
 *  (boot-config.devOtpEnabled). Aliased under the SA-lane name. */
export const devOtpDisclosureEnabled = devOtpEnabled;

export class AuthService {
  private readonly secret: string;

  constructor(
    private readonly repo: GraphRepository,
    secret?: string,
    private readonly now: () => number = () => Date.now(),
    private readonly otpStore: OtpStateStore = memoryOtpState(),
  ) {
    // Security (2026-09-18): NO silent default. Resolution is fail-closed via
    // resolveAuthSecret (managed env, strong; dev fallback under explicit
    // test mode only).
    this.secret = resolveAuthSecret(secret);
  }

  hashPassword(password: string): string {
    const salt = randomBytes(8).toString('hex');
    return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
  }

  verifyPassword(password: string, stored: string): boolean {
    const [salt, hash] = stored.split(':');
    if (!salt || !hash) return false;
    const candidate = scryptSync(password, salt, 32);
    return timingSafeEqual(Buffer.from(hash, 'hex'), candidate);
  }

  issueToken(userId: ID): string {
    const payload = b64u(JSON.stringify({ sub: userId, exp: Math.floor(this.now() / 1000) + TOKEN_TTL_SEC }));
    const sig = createHmac('sha256', this.secret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  /** Authenticates identity, then resolves the CURRENT record (role/scopes/active). */
  async authenticate(token: string | undefined): Promise<UserRecord | null> {
    if (!token) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = createHmac('sha256', this.secret).update(payload).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    let parsed: { sub?: ID; exp?: number };
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString());
    } catch {
      return null;
    }
    if (!parsed.sub || !parsed.exp) return null;
    const user = await this.repo.getUser(parsed.sub);
    if (!user) return null;
    // QA+security (2026-09-18): ANY impersonation-shaped record that is not
    // fully canonical (wrong/non-sandbox org in either representation,
    // malformed lifecycle shape) is rejected at authentication.
    if (user.impersonationOf !== undefined) {
      const withOrg = await this.repo.getUserWithStorageOrg(parsed.sub);
      if (!withOrg || !isCanonicalSandboxSession(withOrg.record, SUPERADMIN_SANDBOX_ORG, withOrg.storageOrgId)) return null;
    }
    // QA lifecycle gate (2026-09-17): server-side session expiry, enforced on
    // EVERY authentication of a sandbox impersonation identity. The first
    // request observed at/after expiresAt atomically transitions
    // active -> expired with an immutable audit row (single CAS - a burst of
    // concurrent requests writes exactly one expire audit), and the token is
    // rejected from then on. Crash/no-stop sessions expire exactly the same:
    // expiry needs no client cooperation. This check runs BEFORE the JWT's
    // own exp rejection: with equal 15-minute TTLs the JWT expires together
    // with the session, and the lazy transition + audit must still fire.
    if (user.impersonationOf !== undefined && user.expiresAt !== undefined
        && Date.parse(user.expiresAt) <= this.now()) {
      if ((user.sessionState ?? 'active') === 'active') {
        const impersonator = await this.repo.getUser(user.impersonationOf);
        const at = new Date(this.now()).toISOString();
        await this.repo.transitionImpersonationSession(user.userId, 'active', 'expired', at, {
          id: `aud_${this.now().toString(36)}_${randomBytes(4).toString('hex')}`,
          orgId: impersonator?.orgId ?? user.orgId,
          eventId: 'pending',
          actorUserId: user.impersonationOf,
          role: (impersonator?.role ?? 'admin') as UserRecord['role'],
          action: 'identity.impersonate.expire',
          entityType: 'user',
          entityId: user.userId,
          beforeJson: null,
          afterJson: JSON.stringify({
            expiredBy: 'server', impersonatorUserId: user.impersonationOf,
            targetRole: user.role, expiresAt: user.expiresAt, sandboxOrg: user.orgId,
          }),
          createdAt: at,
        }, 'server');
      }
      return null;
    }
    if (!user.active || parsed.exp * 1000 < this.now()) return null; // revocation / token expiry take effect immediately
    return user;
  }

  async login(email: string, password: string): Promise<{ token: string; principal: Principal } | null> {
    const user = await this.repo.findUserByEmail(email);
    if (!user?.passwordHash || !this.verifyPassword(password, user.passwordHash)) return null;
    return { token: this.issueToken(user.userId), principal: toPrincipal(user) };
  }

  /** Returns the code in dev mode so tests and the demo can log in without an SMS provider. */
  async requestOtp(phone: string): Promise<{ sent: boolean; devCode?: string; rateLimited: boolean }> {
    const windowStart = this.now() - OTP_WINDOW_SEC * 1000;
    const recent = await this.otpStore.recentRequests(phone, windowStart);
    if (recent.length >= OTP_MAX_PER_WINDOW) return { sent: false, rateLimited: true };
    await this.otpStore.recordRequest(phone, this.now());
    const code = String(Math.abs(scryptSync(phone + this.now(), 'otp', 8).readInt32BE(0)) % 1000000).padStart(6, '0');
    await this.otpStore.setCode(phone, { code, exp: this.now() + OTP_TTL_SEC * 1000 });
    return { sent: true, rateLimited: false, devCode: code };
  }

  /** Pilot-prep #2 semantics: every wrong presentation against a LIVE code
   *  increments a per-phone counter; at OTP_VERIFY_MAX_ATTEMPTS the code is
   *  burned, verify locks for OTP_LOCKOUT_SEC, and an otp.verify.lockout
   *  auth-audit row is written. Lockout, burn, expiry, wrong code and unknown
   *  phone all return null, so the 401 shape stays anti-enumeration identical. */
  async verifyOtp(phone: string, code: string): Promise<{ token: string; principal: Principal } | null> {
    const state = await this.otpStore.getVerifyState(phone);
    if (state?.lockedUntil !== undefined && state.lockedUntil > this.now()) return null;
    const entry = await this.otpStore.getCode(phone);
    if (entry && entry.exp >= this.now() && entry.code !== code) {
      const attempts = await this.otpStore.incrementVerifyAttempts(phone);
      if (attempts >= OTP_VERIFY_MAX_ATTEMPTS) {
        const lockedUntil = this.now() + OTP_LOCKOUT_SEC * 1000;
        await this.otpStore.deleteCode(phone); // code burned at the threshold
        await this.otpStore.setLockout(phone, lockedUntil);
        await this.otpStore.appendAuthAudit({
          phone,
          kind: 'otp.verify.lockout',
          detail: { attempts, maxAttempts: OTP_VERIFY_MAX_ATTEMPTS, lockedUntil, lockoutSec: OTP_LOCKOUT_SEC },
        });
      }
      return null;
    }
    if (!entry || entry.exp < this.now() || entry.code !== code) return null;
    await this.otpStore.deleteCode(phone);
    await this.otpStore.resetVerifyState(phone);
    let user = await this.repo.findUserByPhone(phone);
    if (SUPER_ADMIN_PHONES.includes(phone)) user = await this.ensureSuperAdmin(phone, user);
    if (!user || !user.active) return null;
    return { token: this.issueToken(user.userId), principal: toPrincipal(user) };
  }

  /** Super Admin enrollment: the allowlisted phone IS the credential-level
   *  identity. QA provisioning ruling (2026-09-17), fail-closed:
   *  - NO existing binding -> create the canonical record (pilot home org,
   *    role admin, isSuperAdmin true);
   *  - an EXACT canonical binding (isSuperAdmin===true, home org, role admin)
   *    -> idempotent return, no writes;
   *  - ANY other existing binding - cross-tenant, wrong role, or a regular
   *    home-org admin never claimed - FAILS LOUD with NO mutation. Silently
   *    upgrading/flipping a pre-existing record is exactly the confused-
   *    deputy path the ruling removes: re-binding requires an audited
   *    operator claim flow, which does not exist yet. */
  async ensureSuperAdmin(phone: string, existing?: UserRecord): Promise<UserRecord | undefined> {
    if (existing) {
      const canonical = existing.isSuperAdmin === true && existing.orgId === SUPER_ADMIN_HOME_ORG && existing.role === 'admin';
      if (canonical) return existing;
      throw new Error(
        `SUPER_ADMIN_BINDING_CONFLICT: allowlisted phone ${phone} is already bound to user ${existing.userId} ` +
        `(org=${existing.orgId}, role=${existing.role}, isSuperAdmin=${existing.isSuperAdmin === true}) - ` +
        'refusing silent claim; an audited operator claim flow must re-bind this identity first',
      );
    }
    const user: UserRecord = {
      userId: `u-superadmin-${phone.replace(/\D/g, '')}`,
      orgId: SUPER_ADMIN_HOME_ORG,
      name: 'Super Admin',
      role: 'admin',
      scopes: [],
      phone,
      active: true,
      isSuperAdmin: true,
    };
    return this.repo.createUser(user);
  }

  /** v1.18 §15 + QA integrity gate: the public whitelist surface (check /
   *  register / phone-login) appends EVERY outcome, including throttle hits, to
   *  the same append-only auth_audit channel as OTP (memory + PG). This is the
   *  independent immutable record for unauthenticated attempts; audit_log stays
   *  admin-mutations only (its role field is the strict Role union). */
  async appendWhitelistAudit(phone: string, kind: string, detail: Record<string, unknown>): Promise<void> {
    await this.otpStore.appendAuthAudit({ phone, kind, detail });
  }

  /** QA round-7: plain delegate - per-phone serialization lives IN the
   *  repository (memory: withWhitelistLock around the CAS; PG: row locks +
   *  CAS UPDATE), so admin invite/approve/reject and registration share ONE
   *  ordering domain. The sink is awaited inside the repo primitive's
   *  try/catch; no lock or compensation logic lives here. */
  async commitWhitelistRegistration(entry: WhitelistEntry, kind: string, detail: Record<string, unknown>): Promise<'applied' | 'duplicate'> {
    const audit = { phone: entry.phone, kind, detail };
    return this.repo.commitWhitelistRegistration(entry, audit, a => this.otpStore.appendAuthAudit(a));
  }

  /** v1.18 §15: whitelist-gated phone login. Approved entries log in with NO
   *  OTP challenge - the admin approval IS the credential. Any other state
   *  returns the status so the route can 403 with it (FE renders per-status). */
  async loginWithPhone(phone: string): Promise<{ token: string; principal: Principal } | { status: WhitelistStatus | 'unknown' }> {
    const entry = await this.repo.getWhitelistEntry(phone);
    if (!entry) return { status: 'unknown' };
    if (entry.status !== 'approved') return { status: entry.status };
    let user = await this.repo.findUserByPhone(phone);
    if (SUPER_ADMIN_PHONES.includes(phone)) user = await this.ensureSuperAdmin(phone, user);
    if (!user || !user.active) return { status: 'unknown' };
    return { token: this.issueToken(user.userId), principal: toPrincipal(user) };
  }
}

export const toPrincipal = (u: UserRecord): Principal => ({
  userId: u.userId,
  role: u.role as Role,
  scopes: u.scopes as Scope[],
  ...(u.linkedResourceId ? { linkedResourceId: u.linkedResourceId } : {}),
});
