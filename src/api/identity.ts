/** Super Admin profile switching — FE counterpart of backend commit 5f39b4d3838cd6d557b01da211c1e480b2dfa2eb
 *  (wip/super-admin-profile-switch). SERVER AUTHORITY ONLY: every gate reads GET /v1/whoami;
 *  roles are never inferred client-side. The picker renders only when whoami.isSuperAdmin;
 *  whenever impersonationOf/sandbox markers are set the UI must show the test-impersonation badge;
 *  return-to-real-identity = POST /v1/admin/impersonations/stop + restoring the real token.
 *  Live transport hits the real API (apiBase); mock transport mirrors backend semantics for
 *  hermetic tests and the mock harness — same contract, same deny shapes. */
import type { Principal, Role } from '../contracts/contake-core-contracts.v1.1';
import { apiBase } from './liveApi';
import { isLiveMode, loadSession, saveSession, type AuthSession } from './session';

export interface WhoAmI {
  principal: Principal;
  orgId: string;
  isSuperAdmin: boolean;
  impersonationOf: string | null;
  sandbox: boolean;
}
export interface ImpersonationStart {
  token: string;
  principal: Principal;
  impersonation: { by: string; marked: true; sandboxOrg: string; sandboxEventId: string };
}
export interface IdentityApi {
  whoami(): Promise<WhoAmI>;
  startImpersonation(role: Role, domainProfileId: string): Promise<ImpersonationStart>;
  stopImpersonation(userId?: string): Promise<{ stopped: true; userId: string }>;
}
export class IdentityError extends Error {
  constructor(public status: number, public code: string, message: string, public denial?: Record<string, unknown>) { super(message); }
}

/** Gating rules (pure, unit-tested): the ONLY inputs are whoami markers. */
export const showSwitcher = (w: WhoAmI | null): boolean => !!w && w.isSuperAdmin && !w.sandbox;
export const showImpersonationBadge = (w: WhoAmI | null): boolean => !!w && (w.sandbox || w.impersonationOf != null);

/* ---------------- live transport ---------------- */
export function httpIdentityApi(getToken: () => string | null): IdentityApi {
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const token = getToken();
    const res = await fetch(`${apiBase()}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new IdentityError(res.status, (body as { code?: string }).code ?? 'ERROR', (body as { message?: string }).message ?? res.statusText, (body as { denial?: Record<string, unknown> }).denial);
    return body as T;
  };
  return {
    whoami: () => call<WhoAmI>('/v1/whoami'),
    startImpersonation: (role, domainProfileId) => call<ImpersonationStart>('/v1/admin/impersonations', { method: 'POST', body: JSON.stringify({ role, domainProfileId }) }),
    stopImpersonation: (userId) => call('/v1/admin/impersonations/stop', { method: 'POST', body: JSON.stringify(userId ? { userId } : {}) }),
  };
}

/* ---------------- mock transport (backend semantics, hermetic) ---------------- */
export const MOCK_SANDBOX_ORG = 'org-superadmin-sandbox';
export const MOCK_OWNER = { userId: 'u-chaim', phone: '+972587700852', orgId: 'org-1', name: 'חיים' };
interface MockUser { userId: string; orgId: string; role: Role; isSuperAdmin?: boolean; impersonationOf?: string; active: boolean }
export class MockIdentityApi implements IdentityApi {
  users = new Map<string, MockUser>();
  tokens = new Map<string, string>(); // token -> userId
  audit: { action: string; actorUserId: string; entityId: string; after?: unknown }[] = [];
  private seq = 0;
  constructor(opts: { currentUserIsSuperAdmin?: boolean } = {}) {
    const superAdmin = opts.currentUserIsSuperAdmin ?? true;
    this.users.set(MOCK_OWNER.userId, { userId: MOCK_OWNER.userId, orgId: MOCK_OWNER.orgId, role: 'admin', isSuperAdmin: superAdmin, active: true });
    this.tokens.set('mock-real-token', MOCK_OWNER.userId);
    this.currentToken = 'mock-real-token';
  }
  currentToken: string;
  private me(token?: string): MockUser {
    const uid = this.tokens.get(token ?? this.currentToken);
    const u = uid ? this.users.get(uid) : undefined;
    if (!u || !u.active) throw new IdentityError(401, 'UNAUTHENTICATED', 'לא מחובר');
    return u;
  }
  private principalOf(u: MockUser): Principal {
    return { userId: u.userId, orgId: u.orgId, role: u.role, scopes: [] } as Principal;
  }
  async whoami(): Promise<WhoAmI> {
    const u = this.me();
    return { principal: this.principalOf(u), orgId: u.orgId, isSuperAdmin: u.isSuperAdmin === true, impersonationOf: u.impersonationOf ?? null, sandbox: u.orgId === MOCK_SANDBOX_ORG };
  }
  async startImpersonation(role: Role, domainProfileId: string): Promise<ImpersonationStart> {
    const u = this.me();
    if (u.isSuperAdmin !== true) {
      throw new IdentityError(403, 'FORBIDDEN', 'אין לך הרשאה לפעולה זו', { reason: 'matrix_deny', action: 'identity.impersonate.start', entityType: 'user', entityId: u.userId, eventId: 'pending' });
    }
    if (role !== 'admin' && role !== 'field_manager' && role !== 'focus_worker') throw new IdentityError(400, 'BAD_REQUEST', 'חסר role חוקי');
    const su: MockUser = { userId: `sa-imp-${++this.seq}`, orgId: MOCK_SANDBOX_ORG, role, active: true, impersonationOf: u.userId };
    this.users.set(su.userId, su);
    const token = `mock-sandbox-token-${this.seq}`;
    this.tokens.set(token, su.userId);
    this.audit.push({ action: 'identity.impersonate.start', actorUserId: u.userId, entityId: su.userId, after: { by: u.userId, byPhone: MOCK_OWNER.phone, targetRole: role, domainProfileId, sandboxOrg: MOCK_SANDBOX_ORG, sandboxEventId: `ev-sandbox-${domainProfileId}` } });
    return { token, principal: this.principalOf(su), impersonation: { by: u.userId, marked: true, sandboxOrg: MOCK_SANDBOX_ORG, sandboxEventId: `ev-sandbox-${domainProfileId}` } };
  }
  async stopImpersonation(userId?: string): Promise<{ stopped: true; userId: string }> {
    const actor = this.me();
    let target: MockUser | undefined;
    if (actor.impersonationOf !== undefined) target = actor;
    else if (actor.isSuperAdmin === true && userId !== undefined) target = this.users.get(userId);
    else throw new IdentityError(403, 'FORBIDDEN', 'אין לך הרשאה לפעולה זו', { reason: 'matrix_deny', action: 'identity.impersonate.stop', entityType: 'user', entityId: actor.userId, eventId: 'pending' });
    if (!target || target.impersonationOf === undefined || !target.active) throw new IdentityError(404, 'NOT_FOUND', 'ההתחזות לא נמצאה');
    target.active = false; // per-request active re-read kills the token immediately
    this.audit.push({ action: 'identity.impersonate.stop', actorUserId: actor.userId, entityId: target.userId });
    return { stopped: true, userId: target.userId };
  }
}

/** Transport selection mirrors client.ts: live mode → real API, otherwise mock. */
export function selectIdentityApi(): IdentityApi {
  if (isLiveMode()) return httpIdentityApi(() => loadSession()?.token ?? null);
  return mockIdentitySingleton;
}
export const mockIdentitySingleton = new MockIdentityApi();

/* ---------------- session-aside (real identity kept aside during test impersonation) ---------------- */
const IMP_KEY = 'contake-impersonation-v1';
export interface ImpersonationAside { real: AuthSession; sandbox: AuthSession; marked: true; role: Role; domainProfileId: string }
export function currentImpersonation(): ImpersonationAside | null {
  try {
    const raw = localStorage.getItem(IMP_KEY);
    if (!raw) return null;
    const a = JSON.parse(raw) as Partial<ImpersonationAside>;
    if (a?.marked !== true || !a.real?.token || !a.sandbox?.token) return null;
    return a as ImpersonationAside;
  } catch { return null; }
}
export function beginImpersonationSession(real: AuthSession, start: ImpersonationStart): ImpersonationAside {
  const aside: ImpersonationAside = {
    real,
    sandbox: { token: start.token, principal: start.principal },
    marked: true,
    role: start.principal.role,
    domainProfileId: start.impersonation.sandboxEventId.replace(/^ev-sandbox-/, ''),
  };
  localStorage.setItem(IMP_KEY, JSON.stringify(aside));
  saveSession(aside.sandbox); // sandbox token becomes the live session identity
  return aside;
}
export function endImpersonationSession(): AuthSession | null {
  const aside = currentImpersonation();
  localStorage.removeItem(IMP_KEY);
  if (aside) saveSession(aside.real); // real token restored; sandbox token is dead server-side
  return aside?.real ?? null;
}
