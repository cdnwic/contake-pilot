/** Super Admin test impersonation (server-authorized, audited, sandbox-scoped).
 *  Covers: phone-allowlist enrollment, sandbox identity minting, tenant
 *  isolation, deny matrix, session stop + token revocation, audit trail. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
// Fail-closed allowlist (QA stop-ship): tests opt in explicitly.
vi.hoisted(() => { process.env['CONTAKE_SUPER_ADMIN_PHONES'] = '+972587700852'; });
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService, SUPER_ADMIN_PHONES } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';
import { SUPERADMIN_SANDBOX_ORG, sandboxEventId, sandboxResourceId } from '../src/services/superadmin.js';

let app: FastifyInstance;
let repo: GraphRepository;

const H = (t: string): { authorization: string } => ({ authorization: `Bearer ${t}` });

const otpLogin = async (phone: string): Promise<string> => {
  const req = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } });
  expect(req.statusCode).toBe(200);
  const res = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code: req.json().devCode } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
};
const superToken = (): Promise<string> => otpLogin('+972587700852');

const whoami = async (token: string) => {
  const res = await app.inject({ method: 'GET', url: '/v1/whoami', headers: H(token) });
  return { status: res.statusCode, body: res.json() };
};

beforeEach(async () => {
  repo = await makeTestRepo();
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
});

describe('super admin enrollment', () => {
  it('enrolls the verified owner phone directly as the real Super Admin identity', async () => {
    expect(SUPER_ADMIN_PHONES).toContain('+972587700852');
    const token = await superToken();
    const { status, body } = await whoami(token);
    expect(status).toBe(200);
    expect(body.isSuperAdmin).toBe(true);
    expect(body.principal.role).toBe('admin');
    expect(body.orgId).toBe('org-1'); // real pilot tenant, not the sandbox
    expect(body.sandbox).toBe(false);
    expect(body.impersonationOf).toBeNull();
    // Re-login is idempotent: exactly one durable super-admin record.
    await superToken();
    const users = await repo.listUsers('org-1');
    expect(users.filter(u => u.isSuperAdmin === true)).toHaveLength(1);
  });

  it('does NOT enroll a regular pilot phone as super admin', async () => {
    const token = await otpLogin('+972500000001'); // seeded camp worker
    const { body } = await whoami(token);
    expect(body.isSuperAdmin).toBe(false);
    expect(body.principal.role).toBe('focus_worker');
  });
});

describe('test impersonation (profile switching)', () => {
  it('mints a marked sandbox identity for the requested role/profile and audits the switch', async () => {
    const token = await superToken();
    const meBody = (await whoami(token)).body;
    const res = await app.inject({
      method: 'POST', url: '/v1/admin/impersonations', headers: H(token),
      payload: { role: 'focus_worker', domainProfileId: 'education' },
    });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.impersonation.by).toBe(meBody.principal.userId);
    expect(j.impersonation.marked).toBe(true);
    expect(j.impersonation.sandboxOrg).toBe(SUPERADMIN_SANDBOX_ORG);
    expect(j.impersonation.sandboxEventId).toBe(sandboxEventId('education'));
    expect(j.principal.role).toBe('focus_worker');
    expect(j.principal.linkedResourceId).toBe(sandboxResourceId('education'));
    const w = (await whoami(j.token)).body;
    expect(w.sandbox).toBe(true);
    expect(w.orgId).toBe(SUPERADMIN_SANDBOX_ORG);
    expect(w.isSuperAdmin).toBe(false);
    expect(w.impersonationOf).toBe(meBody.principal.userId);
    const auditRows = await repo.listAudit('org-1');
    const starts = auditRows.filter(r => r.action === 'identity.impersonate.start');
    expect(starts).toHaveLength(1);
    expect(starts[0]?.actorUserId).toBe(meBody.principal.userId);
    expect(JSON.parse(starts[0]?.afterJson ?? '{}')['targetRole']).toBe('focus_worker');
  });

  it('isolates the sandbox identity from real tenants (no access to real events/data)', async () => {
    const token = await superToken();
    const res = await app.inject({
      method: 'POST', url: '/v1/admin/impersonations', headers: H(token),
      payload: { role: 'field_manager', domainProfileId: 'camp' },
    });
    const j = res.json();
    const ev = await app.inject({ method: 'GET', url: '/v1/events', headers: H(j.token) });
    const ids = (ev.json().events as { id: string }[]).map(e => e.id);
    expect(ids).toEqual([sandboxEventId('camp')]); // ONLY the sandbox event
    expect(ids).not.toContain('e1');
    expect(ids).not.toContain('e2');
    // And the super admin's own session is untouched: still sees real tenant data.
    const real = await app.inject({ method: 'GET', url: '/v1/events', headers: H(token) });
    const realIds = (real.json().events as { id: string }[]).map(e => e.id);
    expect(realIds).toContain('e1');
    expect(realIds).not.toContain(sandboxEventId('camp'));
  });

  it('denies impersonation to non-super admins with a matrix-style denial', async () => {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@camp.local', password: 'admin123' } });
    const res = await app.inject({
      method: 'POST', url: '/v1/admin/impersonations', headers: H(login.json().token),
      payload: { role: 'focus_worker' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    const denied = await repo.listAudit('org-1');
    expect(denied.filter(r => r.action === 'identity.impersonate.start' && (r as { outcome?: string }).outcome === 'denied')).toHaveLength(1);
  });
});

describe('impersonation stop', () => {
  it('self-stop deactivates the sandbox identity, kills its token immediately, and audits', async () => {
    const token = await superToken();
    const res = await app.inject({
      method: 'POST', url: '/v1/admin/impersonations', headers: H(token),
      payload: { role: 'focus_worker', domainProfileId: 'camp' },
    });
    const j = res.json();
    const stop = await app.inject({ method: 'POST', url: '/v1/admin/impersonations/stop', headers: H(j.token), payload: {} });
    expect(stop.statusCode).toBe(200);
    expect(stop.json().stopped).toBe(true);
    expect((await whoami(j.token)).status).toBe(401); // token dead right away
    expect((await whoami(token)).status).toBe(200); // super admin unaffected
    const stops = (await repo.listAudit('org-1')).filter(r => r.action === 'identity.impersonate.stop');
    expect(stops).toHaveLength(1);
    expect(stops[0]?.entityId).toBe(j.principal.userId);
  });

  it('super admin can stop a specific sandbox identity, but never a real user', async () => {
    const token = await superToken();
    const res = await app.inject({
      method: 'POST', url: '/v1/admin/impersonations', headers: H(token),
      payload: { role: 'admin', domainProfileId: 'film-shoot' },
    });
    const j = res.json();
    const stop = await app.inject({
      method: 'POST', url: '/v1/admin/impersonations/stop', headers: H(token),
      payload: { userId: j.principal.userId },
    });
    expect(stop.statusCode).toBe(200);
    expect((await whoami(j.token)).status).toBe(401);
    // Refuse to deactivate a real (non-impersonation) user via this route.
    const bad = await app.inject({
      method: 'POST', url: '/v1/admin/impersonations/stop', headers: H(token),
      payload: { userId: 'u-w1' },
    });
    expect(bad.statusCode).toBe(404);
    expect((await repo.getUser('u-w1'))?.active).toBe(true);
  });
});
