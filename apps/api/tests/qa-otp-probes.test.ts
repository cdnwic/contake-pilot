/** QA OTP-surface probes (QA-owned, adversarial) — gates the v11 OTP login drop's backend half. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';

let repo: GraphRepository;
beforeEach(async () => { repo = await makeTestRepo(); });
const PHONE = '+972500000001'; // u-w1 seeded phone

describe('QA-OTP: request/verify surface', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = buildApp(repo, new AuthService(repo)); await app.ready(); });
  afterEach(async () => { await app.close(); });

  it('OTP-1: happy path — devCode, verify 200, token authenticates, code is single-use', async () => {
    const req = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: PHONE } });
    expect(req.statusCode).toBe(200);
    const code = req.json().devCode as string;
    expect(code).toMatch(/^\d{6}$/);
    const ver = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: PHONE, code } });
    expect(ver.statusCode).toBe(200);
    const { token, principal } = ver.json() as { token: string; principal: { userId: string; role: string } };
    expect(principal.userId).toBe('u-w1');
    const authed = await app.inject({ method: 'GET', url: '/v1/events', headers: { authorization: `Bearer ${token}` } });
    expect(authed.statusCode).toBe(200);
    const replay = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: PHONE, code } });
    expect(replay.statusCode).toBe(401); // single-use
  });

  it('OTP-2: verify-attempt lockout (pilot-prep #2) — below 5 wrong the code survives; the 5th burns it + locks verify', async () => {
    // NEW semantics, superseding the pre-lockout NOTE: wrong presentations against a LIVE
    // code increment a per-phone counter; at 5 the code is burned and verify locks 10 min.
    const req = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: PHONE } });
    const code = req.json().devCode as string;
    const wrong = code === '000000' ? '000001' : '000000';
    for (let i = 0; i < 4; i++) {
      const bad = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: PHONE, code: wrong } });
      expect(bad.statusCode).toBe(401);
    }
    const good = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: PHONE, code } });
    expect(good.statusCode).toBe(200); // 4 wrong attempts neither burn the code nor lock verify
    // second code, drive to the threshold: 5th wrong burns, correct code then fails identically
    const req2 = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: PHONE } });
    const code2 = req2.json().devCode as string;
    const wrong2 = code2 === '000000' ? '000001' : '000000';
    let last = 0;
    for (let i = 0; i < 5; i++) {
      last = (await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: PHONE, code: wrong2 } })).statusCode;
      expect(last).toBe(401);
    }
    const afterBurn = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: PHONE, code: code2 } });
    expect(afterBurn.statusCode).toBe(401); // burned: correct code no longer verifies
    expect(afterBurn.body).toBe((await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: PHONE, code: wrong2 } })).body); // burned/locked/wrong share one 401 shape
  });

  it('OTP-3: request rate limit — 6th request inside the window -> 429', async () => {
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: PHONE } });
      last = r.statusCode;
    }
    expect(last).toBe(429);
  });

  it('OTP-4: anti-enumeration — request shape identical for unknown phone; verify of valid code fails only at user lookup', async () => {
    const ghost = '+972599999999';
    const r1 = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: ghost } });
    const r2 = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: PHONE } });
    expect(r1.statusCode).toBe(200);
    expect(Object.keys(r1.json()).sort()).toEqual(Object.keys(r2.json()).sort()); // no existence leak
    const ver = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: ghost, code: r1.json().devCode } });
    expect(ver.statusCode).toBe(401); // right code, no such user -> still 401
  });

  it('OTP-5: phone format is a strict key — 05... and +972... codes are NOT interchangeable (FE normalization is load-bearing)', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: PHONE } });
    const ver = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: '0500000001', code: r.json().devCode } });
    expect(ver.statusCode).toBe(401);
  });
});

describe('QA-OTP-6: TTL expiry (injected clock)', () => {
  it('code expires after 10 minutes -> 401', async () => {
    let clock = Date.parse('2026-09-14T12:00:00+03:00');
    const app2 = buildApp(repo, new AuthService(repo, 'test-secret', () => clock));
    await app2.ready();
    const req = await app2.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: PHONE } });
    const code = req.json().devCode as string;
    clock += 9 * 60 * 1000;
    const ok = await app2.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: PHONE, code } });
    expect(ok.statusCode).toBe(200);
    const req2 = await app2.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: PHONE } });
    const code2 = req2.json().devCode as string;
    clock += 11 * 60 * 1000;
    const expired = await app2.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: PHONE, code: code2 } });
    expect(expired.statusCode).toBe(401);
    await app2.close();
  });
});
