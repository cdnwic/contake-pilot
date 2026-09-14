import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService, hashPasswordPure, memoryOtpState, type OtpStateStore } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepoFrom } from './helpers/repo.js';

let app: FastifyInstance;
let repo: GraphRepository;
let otp: OtpStateStore;

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
      { userId: 'u-fw', orgId: 'org-1', name: 'עובד', role: 'focus_worker', scopes: [], email: 'fw@x.local', passwordHash: hashPasswordPure('fw12345'), active: true },
    ],
    channels: [], events: [], resources: [], tasks: [], dependencies: [],
  });
  otp = memoryOtpState();
  app = buildApp(repo, new AuthService(repo, undefined, undefined, otp));
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

  it('auth_audit integrity: every outcome recorded with kind/outcome/reasonCode/requestId (QA gate)', async () => {
    const admin = await adminLogin();
    const phone = '+972500999010';
    // success path: invite -> register -> duplicate register -> approve -> phone login
    await app.inject({ method: 'POST', url: '/v1/whitelist', headers: H(admin), payload: { phone } });
    await app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone, displayName: 'חדש', requestedRole: 'field_manager' } });
    await app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone, displayName: 'חדש', requestedRole: 'field_manager' } });
    await app.inject({ method: 'POST', url: `/v1/whitelist/${phone}/approve`, headers: H(admin), payload: { role: 'field_manager' } });
    await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { phone } });
    // status rejection: denied login before approval (fresh invited phone)
    await app.inject({ method: 'POST', url: '/v1/whitelist', headers: H(admin), payload: { phone: '+972500999011' } });
    await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { phone: '+972500999011' } });
    // 409 paths: unknown-phone register + check
    await app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone: '+972500000000', displayName: 'x', requestedRole: 'admin' } });
    await app.inject({ method: 'POST', url: '/v1/auth/whitelist-check', payload: { phone: '+972500000000' } });
    // malformed: missing fields (phone known), missing phone entirely
    await app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone } });
    await app.inject({ method: 'POST', url: '/v1/auth/whitelist-check', payload: {} });
    // 429 path: 11 checks inside the minute window
    let last = 0;
    for (let i = 0; i < 11; i += 1) {
      const r = await app.inject({ method: 'POST', url: '/v1/auth/whitelist-check', payload: { phone: '+972500000001' } });
      last = r.statusCode;
    }
    expect(last).toBe(429);

    const rows = await otp.listAuthAudit();
    const codes = (ph: string, kind: string) => rows.filter(r => r.phone === ph && r.kind === kind).map(r => (r.detail as { reasonCode?: string }).reasonCode);
    expect(codes(phone, 'whitelist.register')).toContain('pending_approval');
    // round-3 audit semantics: pre-write ACCEPTED row + post-upsert committed
    // SUCCESS row - never a bare success for an uncommitted write
    const outcomes = (ph: string, kind: string) => rows.filter(r => r.phone === ph && r.kind === kind).map(r => (r.detail as { outcome?: string }).outcome);
    expect(outcomes(phone, 'whitelist.register')).toContain('accepted');
    expect(codes(phone, 'whitelist.register')).toContain('committed');
    const successRow = rows.find(r => r.phone === phone && r.kind === 'whitelist.register' && (r.detail as { outcome?: string }).outcome === 'success');
    expect((successRow!.detail as { reasonCode?: string }).reasonCode).toBe('committed');
    expect(codes(phone, 'whitelist.register')).toContain('already_pending');
    expect(codes(phone, 'whitelist.register')).toContain('missing_fields');
    expect(codes(phone, 'whitelist.login')).toContain('approved');
    expect(codes('+972500999011', 'whitelist.login')).toContain('not_approved');
    expect(codes('+972500000000', 'whitelist.register')).toContain('unknown_phone');
    expect(codes('+972500000000', 'whitelist.check')).toContain('no_entry');
    expect(codes('unknown', 'whitelist.check')).toContain('missing_phone');
    expect(codes('+972500000001', 'whitelist.check')).toContain('throttle_429');
    // every row: createdAt + requestId + deviceClass; never IP / OTP / devCode / token
    for (const r of rows) {
      expect(r.createdAt).toBeTruthy();
      const d = r.detail as Record<string, unknown>;
      expect(d['requestId']).toBeTruthy();
      expect(d['deviceClass']).toBeDefined();
      const blob = JSON.stringify(r).toLowerCase();
      expect(blob).not.toContain('devcode');
      expect(blob).not.toContain('"ip"');
      expect(blob).not.toContain('token');
    }
  });

  it('route-wiring RBAC: focus_worker denied on all four whitelist endpoints (denied-audit on mutations)', async () => {
    const admin = await adminLogin();
    const fw = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'fw@x.local', password: 'fw12345' } })).json().token as string;
    // pending entry to attempt approve/reject against
    await app.inject({ method: 'POST', url: '/v1/whitelist', headers: H(admin), payload: { phone: '+972500999020' } });
    await app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone: '+972500999020', displayName: 'מועמד', requestedRole: 'focus_worker' } });
    expect((await app.inject({ method: 'POST', url: '/v1/whitelist', headers: H(fw), payload: { phone: '+972500999021' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/whitelist', headers: H(fw) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v1/whitelist/+972500999020/approve', headers: H(fw), payload: { role: 'focus_worker', linkedResourceId: 'r-x' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v1/whitelist/+972500999020/reject', headers: H(fw), payload: {} })).statusCode).toBe(403);
    const denied = (await repo.listAudit('org-1')).filter(a => a.outcome === 'denied' && a.actorUserId === 'u-fw');
    const actions = denied.map(a => a.action).sort();
    expect(actions).toEqual(['whitelist.approve', 'whitelist.invite', 'whitelist.reject']);
    // entry untouched by the denied attempts
    expect((await repo.getWhitelistEntry('+972500999020'))!.status).toBe('pending_approval');
  });

  it('field_manager denied on approve/reject (not only invite/list)', async () => {
    const admin = await adminLogin();
    const fm = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'fm@x.local', password: 'fm12345' } })).json().token as string;
    await app.inject({ method: 'POST', url: '/v1/whitelist', headers: H(admin), payload: { phone: '+972500999022' } });
    await app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone: '+972500999022', displayName: 'מועמד', requestedRole: 'admin' } });
    expect((await app.inject({ method: 'POST', url: '/v1/whitelist/+972500999022/approve', headers: H(fm), payload: { role: 'admin' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v1/whitelist/+972500999022/reject', headers: H(fm), payload: {} })).statusCode).toBe(403);
    expect((await repo.getWhitelistEntry('+972500999022'))!.status).toBe('pending_approval');
  });

  it('route-level 429: whitelist-register throttles inside the window with a rate_limited audit row', async () => {
    const phone = '+972500999031';
    let last = 0;
    for (let i = 0; i < 11; i += 1) {
      last = (await app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone, displayName: 'x', requestedRole: 'admin' } })).statusCode;
    }
    expect(last).toBe(429);
    const reg = (await otp.listAuthAudit()).filter(r => r.phone === phone && r.kind === 'whitelist.register');
    expect(reg.some(r => {
      const d = r.detail as { outcome?: string; reasonCode?: string };
      return d.outcome === 'rate_limited' && d.reasonCode === 'throttle_429';
    })).toBe(true);
  });

  it('injected appendWhitelistAudit failure fails LOUD (500) and aborts the mutation - no silent drop', async () => {
    const admin = await adminLogin();
    await app.inject({ method: 'POST', url: '/v1/whitelist', headers: H(admin), payload: { phone: '+972500999030' } });
    const broken = memoryOtpState();
    broken.appendAuthAudit = () => Promise.reject(new Error('auth_audit store down'));
    const app2 = buildApp(repo, new AuthService(repo, undefined, undefined, broken));
    const res = await app2.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone: '+972500999030', displayName: 'חדש', requestedRole: 'focus_worker' } });
    expect(res.statusCode).toBe(500); // fail loud
    expect((await repo.getWhitelistEntry('+972500999030'))!.status).toBe('invited'); // mutation aborted
    await app2.close();
  });
});
