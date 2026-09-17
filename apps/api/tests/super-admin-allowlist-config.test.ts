/** Super Admin allowlist CONFIGURATION CONTRACT (QA lifecycle gate
 *  2026-09-17): CONTAKE_SUPER_ADMIN_PHONES is the ONLY source of Super Admin
 *  privilege - env-only, fail-closed when empty, FAIL-LOUD strict E.164
 *  parsing with dedupe. The owner-approved pilot values live ONLY in the
 *  ops configuration record; this file uses SYNTHETIC numbers by design
 *  (no real phone numbers in code or tests).
 *  Runs in all lanes (memory / PGlite / realpg). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.hoisted(() => { process.env['CONTAKE_SUPER_ADMIN_PHONES'] = ' +15550100001 , +15550100002 , +15550100001 '; });

import { buildApp } from '../src/app.js';
import { AuthService, SUPER_ADMIN_PHONES, parseSuperAdminPhones } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';

let repo: GraphRepository;
let app: FastifyInstance;
beforeEach(async () => {
  repo = await makeTestRepo();
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
});
afterEach(async () => { await app.close(); });

const H = (t: string) => ({ authorization: `Bearer ${t}` });
const otpLogin = async (phone: string) => {
  const q = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } });
  return (await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code: q.json().devCode } })).json().token as string;
};

describe('parseSuperAdminPhones: strict fail-loud E.164 + dedupe', () => {
  it('trims whitespace, dedupes exact duplicates, keeps order', () => {
    expect(parseSuperAdminPhones(' +15550100001 , +15550100002 , +15550100001 ')).toEqual(['+15550100001', '+15550100002']);
  });
  it('empty / unset is a valid EMPTY allowlist (fail closed, not loud)', () => {
    expect(parseSuperAdminPhones(undefined)).toEqual([]);
    expect(parseSuperAdminPhones('')).toEqual([]);
    expect(parseSuperAdminPhones('   ,  , ')).toEqual([]);
  });
  it.each(['not-a-phone', '15550100001', '+abc', '+0', '+15550100001234567890', '++15550100001', '+1 5550100001'])(
    'malformed entry %j throws at parse time (fail loud)', bad => {
      expect(() => parseSuperAdminPhones(`+15550100001,${bad}`)).toThrow(/malformed E.164 entry/);
    });
  it('module-level SUPER_ADMIN_PHONES honored the hoisted env (trimmed + deduped)', () => {
    expect(SUPER_ADMIN_PHONES).toEqual(['+15550100001', '+15550100002']);
  });
});

describe('allowlist contract (synthetic values)', () => {
  it.each(['+15550100001', '+15550100002'])('%s enrolls as Super Admin on first OTP login', async phone => {
    const t = await otpLogin(phone);
    const me = await app.inject({ method: 'GET', url: '/v1/whoami', headers: H(t) });
    expect(me.statusCode).toBe(200);
    expect(me.json().isSuperAdmin).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/v1/admin/impersonations', headers: H(t), payload: { role: 'admin', domainProfileId: 'camp' } })).statusCode).toBe(200);
  });

  it('any non-allowlisted phone is never privileged', async () => {
    const w = await otpLogin('+972500000001'); // seeded focus worker, synthetic fixture
    const me = await app.inject({ method: 'GET', url: '/v1/whoami', headers: H(w) });
    expect(me.json().isSuperAdmin).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/v1/admin/impersonations', headers: H(w), payload: { role: 'admin', domainProfileId: 'camp' } })).statusCode).toBe(403);
  });
});
