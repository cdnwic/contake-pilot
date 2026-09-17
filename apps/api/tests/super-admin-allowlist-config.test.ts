/** Super Admin allowlist CONFIGURATION CONTRACT (owner decision 2026-09-17,
 *  relayed via parent; WhatsApp approval wamid.HBgMOTcyNTg3NzAwODUyFQIAEhggQUM5QTFFODE2NEM3NjM5QjdFNjcxN0VBQkRDMEEzQTUA):
 *  the pilot allowlist is EXACTLY +972587700852 and +13477700776, provisioned
 *  only via CONTAKE_SUPER_ADMIN_PHONES. No hardcoded/default phone. These
 *  probes pin the contract: both approved phones enroll as Super Admin, a
 *  third phone never does, and the env parser tolerates whitespace.
 *  Runs in all lanes (memory / PGlite / realpg). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.hoisted(() => { process.env['CONTAKE_SUPER_ADMIN_PHONES'] = ' +972587700852 , +13477700776 '; });

import { buildApp } from '../src/app.js';
import { AuthService, SUPER_ADMIN_PHONES } from '../src/auth.js';
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

describe('allowlist configuration contract (owner-approved pilot values)', () => {
  it('parser: comma-separated, whitespace-trimmed, exactly the two approved phones', () => {
    expect([...SUPER_ADMIN_PHONES].sort()).toEqual(['+13477700776', '+972587700852']);
  });

  it.each(['+972587700852', '+13477700776'])('%s enrolls as Super Admin on first OTP login', async phone => {
    const t = await otpLogin(phone);
    const me = await app.inject({ method: 'GET', url: '/v1/whoami', headers: H(t) });
    expect(me.statusCode).toBe(200);
    expect(me.json().isSuperAdmin).toBe(true);
    const start = await app.inject({ method: 'POST', url: '/v1/admin/impersonations', headers: H(t), payload: { role: 'admin', domainProfileId: 'camp' } });
    expect(start.statusCode).toBe(200);
  });

  it('any other phone is never privileged', async () => {
    const w = await otpLogin('+972500000001'); // seeded focus worker, not allowlisted
    const me = await app.inject({ method: 'GET', url: '/v1/whoami', headers: H(w) });
    expect(me.json().isSuperAdmin).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/v1/admin/impersonations', headers: H(w), payload: { role: 'admin', domainProfileId: 'camp' } })).statusCode).toBe(403);
  });
});
