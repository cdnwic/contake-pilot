import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService, hashPasswordPure, memoryOtpState, type OtpStateStore } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestBackendFrom, type AuditHook } from './helpers/repo.js';

let app: FastifyInstance;
let repo: GraphRepository;
let otp: OtpStateStore;
let setAuditHook: (hook?: AuditHook) => void;

const H = (t: string) => ({ authorization: `Bearer ${t}` });
const adminLogin = async (): Promise<string> => {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@x.local', password: 'admin123' } });
  return res.json().token as string;
};

beforeEach(async () => {
  // Whitelist-PG gate (harness lane): bind repo + OTP/audit to the SAME adapter
  // so observations and fault injection land on the channel the adapter really
  // writes (memory store under memory, PG auth_audit under postgres).
  const backend = await makeTestBackendFrom({
    orgId: 'org-1',
    users: [
      { userId: 'u-admin', orgId: 'org-1', name: 'מנהל', role: 'admin', scopes: [], email: 'admin@x.local', passwordHash: hashPasswordPure('admin123'), active: true },
      { userId: 'u-fm', orgId: 'org-1', name: 'רכז', role: 'field_manager', scopes: [], email: 'fm@x.local', passwordHash: hashPasswordPure('fm12345'), active: true },
      { userId: 'u-fw', orgId: 'org-1', name: 'עובד', role: 'focus_worker', scopes: [], email: 'fw@x.local', passwordHash: hashPasswordPure('fw12345'), active: true },
    ],
    channels: [], events: [], resources: [], tasks: [], dependencies: [],
  });
  repo = backend.repo;
  otp = backend.otpStore;
  setAuditHook = backend.setAuditHook;
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

  it('round-7: admin approve cannot interleave a PAUSED registration audit - defined ordering, no stale overwrite', async () => {
    const admin = await adminLogin();
    const phone = '+972500999050';
    await app.inject({ method: 'POST', url: '/v1/whitelist', headers: H(admin), payload: { phone } });
    // Audit channel pauses on the committed append: registration holds the
    // per-phone lock (memory) / open tx (PG) mid-commit
    let calls = 0;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    const enteredP = new Promise<void>(res => { entered = res; });
    setAuditHook((_e, real) => {
      calls += 1;
      if (calls === 2) { entered(); return gate.then(() => real()); } // paused, then REALLY appends
      return real();
    });
    const app2 = buildApp(repo, new AuthService(repo, undefined, undefined, otp));
    const regP = app2.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone, displayName: 'מועמד', requestedRole: 'field_manager' } });
    await enteredP; // registration is mid-commit, holding the repo lock
    const approveP = app2.inject({ method: 'POST', url: `/v1/whitelist/${phone}/approve`, headers: H(admin), payload: { role: 'field_manager' } });
    let approveSettled = false;
    void approveP.then(() => { approveSettled = true; });
    await new Promise(r => setTimeout(r, 30));
    expect(approveSettled).toBe(false); // BLOCKED by the repository lock while the audit is paused
    release();
    const [reg, approve] = await Promise.all([regP, approveP]);
    expect(reg.statusCode).toBe(200);
    expect(approve.statusCode).toBe(200);
    const entry = (await repo.getWhitelistEntry(phone))!;
    expect(entry.status).toBe('approved'); // the admin's LATER state is intact
    expect(entry.assignedRole).toBe('field_manager');
    const rows = (await otp.listAuthAudit()).filter(r => r.phone === phone && r.kind === 'whitelist.register');
    expect(rows.filter(r => (r.detail as { reasonCode?: string }).reasonCode === 'committed')).toHaveLength(1);
    await app2.close();
  });

  it('round-7: a REJECTED registration audit rolls back BEFORE a racing re-invite - no stale overwrite', async () => {
    const admin = await adminLogin();
    const phone = '+972500999051';
    await app.inject({ method: 'POST', url: '/v1/whitelist', headers: H(admin), payload: { phone } });
    let calls = 0;
    let failGate!: (e: Error) => void;
    let entered!: () => void;
    const gate = new Promise<void>((res, rej) => { failGate = rej; });
    const enteredP = new Promise<void>(res => { entered = res; });
    setAuditHook((_e, real) => {
      calls += 1;
      if (calls === 2) { entered(); return gate; }
      return real();
    });
    const app2 = buildApp(repo, new AuthService(repo, undefined, undefined, otp));
    const regP = app2.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone, displayName: 'מועמד', requestedRole: 'focus_worker' } });
    await enteredP; // mid-commit, lock held
    const reinviteP = app2.inject({ method: 'POST', url: '/v1/whitelist', headers: H(admin), payload: { phone } });
    let reinviteSettled = false;
    void reinviteP.then(() => { reinviteSettled = true; });
    await new Promise(r => setTimeout(r, 30));
    expect(reinviteSettled).toBe(false); // BLOCKED: admin mutation queues behind the registration
    failGate(new Error('auth_audit store down mid-commit'));
    const [reg, reinvite] = await Promise.all([regP, reinviteP]);
    expect(reg.statusCode).toBe(500); // fail loud
    expect(reinvite.statusCode).toBe(200); // runs only AFTER the rollback: defined ordering
    const entry = (await repo.getWhitelistEntry(phone))!;
    expect(entry.status).toBe('invited'); // rolled back, then re-invited - the rollback never overwrote the admin's write
    // zero committed rows from the failed attempt; a fresh retry is unambiguous
    let rows = (await otp.listAuthAudit()).filter(r => r.phone === phone && r.kind === 'whitelist.register');
    expect(rows.filter(r => (r.detail as { reasonCode?: string }).reasonCode === 'committed')).toHaveLength(0);
    const retry = await app2.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone, displayName: 'מועמד', requestedRole: 'focus_worker' } });
    expect(retry.statusCode).toBe(200);
    rows = (await otp.listAuthAudit()).filter(r => r.phone === phone && r.kind === 'whitelist.register');
    expect(rows.filter(r => (r.detail as { reasonCode?: string }).reasonCode === 'committed')).toHaveLength(1);
    await app2.close();
  });

  it('round-5 concurrency: Promise.all same-phone register yields exactly one winner, one committed row, deterministic loser', async () => {
    const admin = await adminLogin();
    const phone = '+972500999033';
    await app.inject({ method: 'POST', url: '/v1/whitelist', headers: H(admin), payload: { phone } });
    // Distinct names close the idempotent-resubmit branch for the loser: every
    // interleaving ends 200/409 deterministically.
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone, displayName: 'מתמודד א', requestedRole: 'focus_worker' } }),
      app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone, displayName: 'מתמודד ב', requestedRole: 'focus_worker' } }),
    ]);
    expect([a.statusCode, b.statusCode].sort((x, y) => x - y)).toEqual([200, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().error.code).toBe('WHITELIST_NOT_INVITED');
    // exactly one state transition, never a stale rollback of the winner
    const entry = (await repo.getWhitelistEntry(phone))!;
    expect(entry.status).toBe('pending_approval');
    expect(['מתמודד א', 'מתמודד ב']).toContain(entry.displayName);
    const rows = (await otp.listAuthAudit()).filter(r => r.phone === phone && r.kind === 'whitelist.register');
    const det = (r: { detail?: unknown }) => r.detail as { outcome?: string; reasonCode?: string };
    expect(rows.filter(r => det(r).reasonCode === 'committed')).toHaveLength(1); // exactly one committed row
    expect(rows.filter(r => det(r).outcome === 'accepted').length).toBeGreaterThanOrEqual(1); // every attempt that reaches commit records accepted
    expect(rows.filter(r => det(r).reasonCode === 'concurrent_lost') .length + rows.filter(r => det(r).reasonCode === 'not_invited').length).toBe(1); // one deterministic loser record
  });

  it('round-4 atomicity: failed committed append rolls the mutation back; retry is exactly-once', async () => {
    const admin = await adminLogin();
    const phone = '+972500999032';
    await app.inject({ method: 'POST', url: '/v1/whitelist', headers: H(admin), payload: { phone } });
    // Audit channel fails only on its SECOND append (the committed write, mid-commit)
    let calls = 0;
    // QA round-6 contract: the double REJECTS asynchronously - the awaited
    // sink must catch it (rollback) with NO unhandled rejection escaping
    setAuditHook((_e, real) => {
      calls += 1;
      return calls === 2 ? Promise.reject(new Error('auth_audit store down mid-commit')) : real();
    });
    const unhandled: unknown[] = [];
    const onRej = (r: unknown): void => { unhandled.push(r); };
    process.on('unhandledRejection', onRej);
    const app2 = buildApp(repo, new AuthService(repo, undefined, undefined, otp));
    // attempt 1: accepted row lands, upsert+committed pair fails -> rolled back
    const r1 = await app2.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone, displayName: 'חדש', requestedRole: 'focus_worker' } });
    expect(r1.statusCode).toBe(500);
    expect((await repo.getWhitelistEntry(phone))!.status).toBe('invited'); // compensating rollback
    const detail = (r: { detail?: unknown }) => r.detail as { outcome?: string; reasonCode?: string };
    let rows = (await otp.listAuthAudit()).filter(r => r.phone === phone && r.kind === 'whitelist.register');
    expect(rows.some(r => detail(r).outcome === 'accepted')).toBe(true); // request record survives
    expect(rows.some(r => detail(r).outcome === 'success')).toBe(false); // NO false success ledger
    // retry (healthy store): unambiguous - entry is invited again
    const r2 = await app2.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone, displayName: 'חדש', requestedRole: 'focus_worker' } });
    expect(r2.statusCode).toBe(200);
    expect((await repo.getWhitelistEntry(phone))!.status).toBe('pending_approval');
    rows = (await otp.listAuthAudit()).filter(r => r.phone === phone && r.kind === 'whitelist.register');
    expect(rows.filter(r => detail(r).reasonCode === 'committed')).toHaveLength(1); // exactly once
    await new Promise(r => setImmediate(r)); // let any stray rejection surface
    process.off('unhandledRejection', onRej);
    expect(unhandled).toHaveLength(0); // no escaped rejection
    await app2.close();
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
