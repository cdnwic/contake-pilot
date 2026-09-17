/** QA provisioning ruling (2026-09-17): Super Admin binding is fail-closed.
 *  - no binding -> canonical record created (home org, admin, isSuperAdmin);
 *  - exact canonical binding -> idempotent, no writes;
 *  - ANY other existing binding (cross-tenant, wrong role, regular home-org
 *    admin) -> FAILS LOUD, record byte-identical, no silent claim. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { process.env['CONTAKE_SUPER_ADMIN_PHONES'] = '+15550100001'; });
import { buildApp } from '../src/app.js';
import { AuthService, SUPER_ADMIN_HOME_ORG } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';

const PHONE = '+15550100001';
let repo: GraphRepository;
let auth: AuthService;

beforeEach(async () => {
  repo = await makeTestRepo();
  auth = new AuthService(repo);
});

const seedBinding = async (over: Record<string, unknown>) => {
  const u = await repo.createUser({
    userId: `u-pre-${Math.random().toString(36).slice(2, 8)}`,
    orgId: SUPER_ADMIN_HOME_ORG, name: 'Pre Existing', role: 'admin',
    scopes: [], phone: PHONE, active: true, ...over,
  } as never);
  return u;
};

describe('QA provisioning ruling: ensureSuperAdmin', () => {
  it('no binding -> creates the canonical super admin record', async () => {
    const u = await auth.ensureSuperAdmin(PHONE, undefined);
    expect(u).toBeDefined();
    expect(u!.orgId).toBe(SUPER_ADMIN_HOME_ORG);
    expect(u!.role).toBe('admin');
    expect(u!.isSuperAdmin).toBe(true);
    expect(u!.active).toBe(true);
  });

  it('exact canonical binding -> idempotent return, no mutation', async () => {
    const first = await auth.ensureSuperAdmin(PHONE, undefined);
    const again = await auth.ensureSuperAdmin(PHONE, await repo.findUserByPhone(PHONE));
    expect(again!.userId).toBe(first!.userId);
    const all = (await repo.listUsers(SUPER_ADMIN_HOME_ORG)).filter(x => x.isSuperAdmin === true);
    expect(all).toHaveLength(1);
  });

  it('regular home-org admin binding (never claimed) -> FAILS LOUD, record unchanged', async () => {
    const pre = await seedBinding({ orgId: SUPER_ADMIN_HOME_ORG, role: 'admin' });
    await expect(auth.ensureSuperAdmin(PHONE, await repo.findUserByPhone(PHONE)))
      .rejects.toThrow(/SUPER_ADMIN_BINDING_CONFLICT/);
    const after = await repo.getUser(pre.userId);
    expect(after!.isSuperAdmin).not.toBe(true); // NO silent upgrade
    expect(after!.orgId).toBe(SUPER_ADMIN_HOME_ORG);
    expect(after!.role).toBe('admin');
  });

  it('cross-tenant binding (org-2) -> FAILS LOUD, record unchanged', async () => {
    const pre = await seedBinding({ orgId: 'org-2', role: 'admin' });
    await expect(auth.ensureSuperAdmin(PHONE, await repo.findUserByPhone(PHONE)))
      .rejects.toThrow(/SUPER_ADMIN_BINDING_CONFLICT/);
    const after = await repo.getUser(pre.userId);
    expect(after!.isSuperAdmin).not.toBe(true);
    expect(after!.orgId).toBe('org-2');
  });

  it('wrong-role binding (home org, manager) -> FAILS LOUD, record unchanged', async () => {
    const pre = await seedBinding({ orgId: SUPER_ADMIN_HOME_ORG, role: 'manager' });
    await expect(auth.ensureSuperAdmin(PHONE, await repo.findUserByPhone(PHONE)))
      .rejects.toThrow(/SUPER_ADMIN_BINDING_CONFLICT/);
    const after = await repo.getUser(pre.userId);
    expect(after!.isSuperAdmin).not.toBe(true);
    expect(after!.role).toBe('manager');
  });

  it('isSuperAdmin=true but WRONG ORG is NOT canonical -> FAILS LOUD', async () => {
    await seedBinding({ orgId: 'org-2', role: 'admin', isSuperAdmin: true });
    await expect(auth.ensureSuperAdmin(PHONE, await repo.findUserByPhone(PHONE)))
      .rejects.toThrow(/SUPER_ADMIN_BINDING_CONFLICT/);
  });

  it('route-level: OTP login with a conflicting binding fails loudly, token NOT issued', async () => {
    await seedBinding({ orgId: 'org-2', role: 'admin' });
    const app = buildApp(repo, auth);
    await app.ready();
    const req = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: PHONE } });
    expect(req.statusCode).toBe(200);
    const res = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: PHONE, code: req.json().devCode } });
    expect(res.statusCode).toBe(500); // loud failure, no silent claim
    expect(res.json().token).toBeUndefined();
    await app.close();
  });
});
