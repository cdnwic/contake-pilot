import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService, hashPasswordPure } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepoFrom } from './helpers/repo.js';

let app: FastifyInstance;
let repo: GraphRepository;

const H = (t: string) => ({ authorization: `Bearer ${t}` });
const adminLogin = async (): Promise<string> => {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@x.local', password: 'admin123' } });
  return res.json().token as string;
};

beforeEach(async () => {
  repo = await makeTestRepoFrom({
    orgId: 'org-1',
    users: [
      { userId: 'u-admin', orgId: 'org-1', name: 'מנהל', role: 'admin', scopes: [], email: 'admin@x.local', passwordHash: hashPasswordPure('admin123'), active: true },
      { userId: 'u-fm', orgId: 'org-1', name: 'רכז', role: 'field_manager', scopes: [], email: 'fm@x.local', passwordHash: hashPasswordPure('fm12345'), active: true },
    ],
    channels: [], events: [], resources: [], tasks: [], dependencies: [],
  });
  app = buildApp(repo, new AuthService(repo));
});
afterEach(async () => { await app.close(); });

describe('whitelist onboarding (v1.18 §15 / matrix v1.4)', () => {
  it('full lifecycle: invite -> register -> approve -> phone login without OTP', async () => {
    const admin = await adminLogin();
    // invite
    let res = await app.inject({ method: 'POST', url: '/v1/whitelist', headers: H(admin), payload: { phone: '+972500999001' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('invited');
    // check (public)
    res = await app.inject({ method: 'POST', url: '/v1/auth/whitelist-check', payload: { phone: '+972500999001' } });
    expect(res.json().status).toBe('invited');
    // login before approval -> 403 invited
    res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { phone: '+972500999001' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('WHITELIST_INVITED');
    // register (public)
    res = await app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone: '+972500999001', displayName: 'דני חדש', requestedRole: 'focus_worker' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('pending_approval');
    // idempotent re-submit of same details
    res = await app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone: '+972500999001', displayName: 'דני חדש', requestedRole: 'focus_worker' } });
    expect(res.statusCode).toBe(200);
    // pending login -> 403 pending
    res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { phone: '+972500999001' } });
    expect(res.json().error.code).toBe('WHITELIST_PENDING_APPROVAL');
    // in_app notification recorded for the org admin
    const jobs = await repo.listNotificationJobsAll();
    expect(jobs.some(j => j.idempotencyKey.includes('whitelist') && j.targets.some(t => t.address === 'u-admin'))).toBe(true);
    // approve as focus_worker requires linkedResourceId
    res = await app.inject({ method: 'POST', url: '/v1/whitelist/+972500999001/approve', headers: H(admin), payload: { role: 'focus_worker' } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'POST', url: '/v1/whitelist/+972500999001/approve', headers: H(admin), payload: { role: 'focus_worker', linkedResourceId: 'r-x' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().entry.status).toBe('approved');
    // phone login now issues a session with NO OTP
    res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { phone: '+972500999001' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().principal.role).toBe('focus_worker');
  });

  it('reject path + re-invite reset', async () => {
    const admin = await adminLogin();
    await app.inject({ method: 'POST', url: '/v1/whitelist', headers: H(admin), payload: { phone: '+972500999002' } });
    await app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone: '+972500999002', displayName: 'פלוני', requestedRole: 'field_manager' } });
    let res = await app.inject({ method: 'POST', url: '/v1/whitelist/+972500999002/reject', headers: H(admin), payload: { reasonHe: 'לא מאושר' } });
    expect(res.json().status).toBe('rejected');
    res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { phone: '+972500999002' } });
    expect(res.json().error.code).toBe('WHITELIST_REJECTED');
    // re-invite resets to invited
    res = await app.inject({ method: 'POST', url: '/v1/whitelist', headers: H(admin), payload: { phone: '+972500999002' } });
    expect(res.json().status).toBe('invited');
  });

  it('matrix v1.4: non-admin is denied with a denied-audit row', async () => {
    const fmRes = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'fm@x.local', password: 'fm12345' } });
    const fm = fmRes.json().token as string;
    const res = await app.inject({ method: 'POST', url: '/v1/whitelist', headers: H(fm), payload: { phone: '+972500999003' } });
    expect(res.statusCode).toBe(403);
    const auditRows = await repo.listAudit('org-1');
    expect(auditRows.some(a => a.outcome === 'denied' && a.action === 'whitelist.invite')).toBe(true);
    // list is admin-only too (read deny, no audit row required)
    const list = await app.inject({ method: 'GET', url: '/v1/whitelist', headers: H(fm) });
    expect(list.statusCode).toBe(403);
  });

  it('unknown phone: check says unknown, login 403s, register 409s', async () => {
    let res = await app.inject({ method: 'POST', url: '/v1/auth/whitelist-check', payload: { phone: '+972500000000' } });
    expect(res.json().status).toBe('unknown');
    res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { phone: '+972500000000' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('WHITELIST_UNKNOWN');
    res = await app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone: '+972500000000', displayName: 'x', requestedRole: 'admin' } });
    expect(res.statusCode).toBe(409);
  });

  it('approve 409s when not pending_approval', async () => {
    const admin = await adminLogin();
    await app.inject({ method: 'POST', url: '/v1/whitelist', headers: H(admin), payload: { phone: '+972500999004' } });
    const res = await app.inject({ method: 'POST', url: '/v1/whitelist/+972500999004/approve', headers: H(admin), payload: { role: 'admin' } });
    expect(res.statusCode).toBe(409);
  });
});
