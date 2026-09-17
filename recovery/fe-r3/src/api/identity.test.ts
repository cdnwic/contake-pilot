// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  MockIdentityApi, IdentityError, showSwitcher, showImpersonationBadge,
  httpIdentityApi, beginImpersonationSession, endImpersonationSession, currentImpersonation,
  MOCK_SANDBOX_ORG, MOCK_OWNER, type WhoAmI,
} from './identity';

// FE counterpart contract: backend 5f39b4d3838cd6d557b01da211c1e480b2dfa2eb (wip/super-admin-profile-switch).
// Server authority only: gating reads whoami markers; no client-side role inference.
describe('Super Admin identity — server-authority contract', () => {
  let api: MockIdentityApi;
  beforeEach(() => { api = new MockIdentityApi(); localStorage.clear(); });

  it('whoami is the truth source: super admin owner marked, real tenant, no impersonation', async () => {
    const w = await api.whoami();
    expect(w.isSuperAdmin).toBe(true);
    expect(w.orgId).toBe(MOCK_OWNER.orgId);
    expect(w.impersonationOf).toBeNull();
    expect(w.sandbox).toBe(false);
    expect(showSwitcher(w)).toBe(true);
    expect(showImpersonationBadge(w)).toBe(false);
  });

  it('non-super user: picker hidden and start is denied with matrix_deny shape', async () => {
    const regular = new MockIdentityApi({ currentUserIsSuperAdmin: false });
    const w = await regular.whoami();
    expect(w.isSuperAdmin).toBe(false);
    expect(showSwitcher(w)).toBe(false);
    const err = await regular.startImpersonation('admin', 'camp').catch((e) => e);
    expect(err).toBeInstanceOf(IdentityError);
    expect(err.status).toBe(403);
    expect(err.denial).toMatchObject({ reason: 'matrix_deny', action: 'identity.impersonate.start' });
  });

  it('start mints a MARKED sandbox token; whoami on it shows sandbox + impersonationOf', async () => {
    const start = await api.startImpersonation('field_manager', 'film-shoot');
    expect(start.impersonation.marked).toBe(true);
    expect(start.impersonation.sandboxOrg).toBe(MOCK_SANDBOX_ORG);
    expect(start.impersonation.by).toBe(MOCK_OWNER.userId);
    api.currentToken = start.token;
    const w = await api.whoami();
    expect(w.sandbox).toBe(true);
    expect(w.impersonationOf).toBe(MOCK_OWNER.userId);
    expect(w.orgId).toBe(MOCK_SANDBOX_ORG);
    expect(showSwitcher(w)).toBe(false);       // no nested switching from inside the sandbox
    expect(showImpersonationBadge(w)).toBe(true);
    expect(api.audit.map((a) => a.action)).toContain('identity.impersonate.start');
  });

  it('stop kills the sandbox token immediately and audits; real user cannot be stopped', async () => {
    const start = await api.startImpersonation('focus_worker', 'camp');
    api.currentToken = start.token;
    const stopped = await api.stopImpersonation();
    expect(stopped.stopped).toBe(true);
    await expect(api.whoami()).rejects.toMatchObject({ status: 401 }); // token dead on re-read
    api.currentToken = 'mock-real-token';
    await expect(api.stopImpersonation(MOCK_OWNER.userId)).rejects.toMatchObject({ status: 404 });
    expect(api.audit.map((a) => a.action)).toContain('identity.impersonate.stop');
  });

  it('super admin can stop a specific sandbox identity by userId', async () => {
    const start = await api.startImpersonation('admin', 'logistics');
    const stopped = await api.stopImpersonation(start.principal.userId);
    expect(stopped.userId).toBe(start.principal.userId);
    api.currentToken = start.token;
    await expect(api.whoami()).rejects.toMatchObject({ status: 401 });
  });

  it('session-aside: sandbox token swaps in, real token restored on return', async () => {
    const real = { token: 'real-jwt', principal: { userId: MOCK_OWNER.userId, role: 'admin' } as WhoAmI['principal'] };
    const start = await api.startImpersonation('focus_worker', 'education');
    const aside = beginImpersonationSession(real, start);
    expect(aside.marked).toBe(true);
    expect(currentImpersonation()?.sandbox.token).toBe(start.token);
    expect(JSON.parse(localStorage.getItem('contake-session-v1')!).token).toBe(start.token); // live identity = sandbox
    const restored = endImpersonationSession();
    expect(restored?.token).toBe('real-jwt');
    expect(currentImpersonation()).toBeNull();
    expect(JSON.parse(localStorage.getItem('contake-session-v1')!).token).toBe('real-jwt');
  });

  it('http transport: exact paths, bearer token, bodies (fake fetch)', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fake = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/v1/whoami')) return new Response(JSON.stringify({ principal: { userId: 'u1' }, orgId: 'org-1', isSuperAdmin: true, impersonationOf: null, sandbox: false }), { status: 200 });
      if (url.endsWith('/v1/admin/impersonations')) return new Response(JSON.stringify({ token: 't', principal: { userId: 'sa-1', role: 'admin' }, impersonation: { by: 'u1', marked: true, sandboxOrg: MOCK_SANDBOX_ORG, sandboxEventId: 'ev-sandbox-camp' } }), { status: 200 });
      return new Response(JSON.stringify({ stopped: true, userId: 'sa-1' }), { status: 200 });
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = fake as typeof fetch;
    try {
      const api2 = httpIdentityApi(() => 'real-jwt');
      await api2.whoami();
      await api2.startImpersonation('admin', 'camp');
      await api2.stopImpersonation();
      expect(calls.map((c) => c.url)).toEqual([
        'http://localhost:3100/v1/whoami',
        'http://localhost:3100/v1/admin/impersonations',
        'http://localhost:3100/v1/admin/impersonations/stop',
      ]);
      expect((calls[0].init?.headers as Record<string, string>).authorization).toBe('Bearer real-jwt');
      expect(JSON.parse(String(calls[1].init?.body))).toEqual({ role: 'admin', domainProfileId: 'camp' });
    } finally { globalThis.fetch = realFetch; }
  });
});
