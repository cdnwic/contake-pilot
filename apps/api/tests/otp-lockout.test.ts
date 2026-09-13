/** Pilot-prep #2/#4: OTP verify-attempt throttling (per-phone counter, code burn
 *  at the threshold, lockout window, auth-audit row) over the shared OtpStateStore
 *  (memory default here, Postgres adapter when REPO_IMPL=postgres). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService, type OtpStateStore } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestBackend } from './helpers/repo.js';

const PHONE = '+972500000001'; // u-w1 seeded phone
const wrongFor = (code: string) => (code === '000000' ? '000001' : '000000');

let repo: GraphRepository;
let otpStore: OtpStateStore;
let app: FastifyInstance;
beforeEach(async () => {
  ({ repo, otpStore } = await makeTestBackend());
  app = buildApp(repo, new AuthService(repo, undefined, undefined, otpStore));
  await app.ready();
});
afterEach(async () => { await app.close(); });

const requestOtp = (phone: string = PHONE) =>
  app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } });
const verifyOtp = (phone: string, code: string) =>
  app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code } });

describe('OTP verify-attempt throttling (pilot-prep #2)', () => {
  it('wrong attempts below the threshold: 401 each, code stays alive', async () => {
    const code = (await requestOtp()).json().devCode as string;
    for (let i = 0; i < 4; i++) {
      expect((await verifyOtp(PHONE, wrongFor(code))).statusCode).toBe(401);
    }
    expect((await verifyOtp(PHONE, code)).statusCode).toBe(200);
  });

  it('5th wrong attempt burns the code; correct code then fails too', async () => {
    const code = (await requestOtp()).json().devCode as string;
    const wrong = wrongFor(code);
    for (let i = 0; i < 5; i++) {
      expect((await verifyOtp(PHONE, wrong)).statusCode).toBe(401);
    }
    expect((await verifyOtp(PHONE, code)).statusCode).toBe(401); // burned
  });

  it('lockout blocks verify even for a freshly requested code until the window ends', async () => {
    const code = (await requestOtp()).json().devCode as string;
    const wrong = wrongFor(code);
    for (let i = 0; i < 5; i++) await verifyOtp(PHONE, wrong);
    const code2 = (await requestOtp()).json().devCode as string; // request-side still allowed
    expect(code2).toMatch(/^\d{6}$/);
    expect((await verifyOtp(PHONE, code2)).statusCode).toBe(401); // locked, not burned-code mismatch
  });

  it('lockout writes exactly one otp.verify.lockout auth-audit row', async () => {
    const code = (await requestOtp()).json().devCode as string;
    const wrong = wrongFor(code);
    for (let i = 0; i < 7; i++) await verifyOtp(PHONE, wrong); // attempts past the threshold
    const rows = (await otpStore.listAuthAudit(PHONE)).filter(r => r.kind === 'otp.verify.lockout');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toMatchObject({ attempts: 5, maxAttempts: 5, lockoutSec: 600 });
  });

  it('success resets the attempt counter (no carry-over into the next code)', async () => {
    const code = (await requestOtp()).json().devCode as string;
    for (let i = 0; i < 4; i++) await verifyOtp(PHONE, wrongFor(code));
    expect((await verifyOtp(PHONE, code)).statusCode).toBe(200);
    const code2 = (await requestOtp()).json().devCode as string;
    for (let i = 0; i < 4; i++) {
      expect((await verifyOtp(PHONE, wrongFor(code2))).statusCode).toBe(401);
    }
    expect((await verifyOtp(PHONE, code2)).statusCode).toBe(200); // still alive: counter was reset
  });

  it('anti-enumeration: wrong, burned, locked and ghost-phone failures are identical 401s', async () => {
    const code = (await requestOtp()).json().devCode as string;
    const wrong = wrongFor(code);
    const wrongResp = await verifyOtp(PHONE, wrong);
    for (let i = 0; i < 4; i++) await verifyOtp(PHONE, wrong); // -> burned + locked
    const burnedResp = await verifyOtp(PHONE, code);
    const lockedResp = await verifyOtp(PHONE, (await requestOtp()).json().devCode as string);
    const ghostResp = await verifyOtp('+972599999999', '123456');
    for (const r of [burnedResp, lockedResp, ghostResp]) {
      expect(r.statusCode).toBe(wrongResp.statusCode);
      expect(r.body).toBe(wrongResp.body);
    }
  });

  it('the counter is shared across service instances on the same store (multi-instance)', async () => {
    const app2 = buildApp(repo, new AuthService(repo, undefined, undefined, otpStore));
    await app2.ready();
    try {
      const code = (await requestOtp()).json().devCode as string;
      const wrong = wrongFor(code);
      for (let i = 0; i < 3; i++) await verifyOtp(PHONE, wrong); // instance 1
      for (let i = 0; i < 2; i++) { // instance 2 carries the count over
        const r = await app2.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: PHONE, code: wrong } });
        expect(r.statusCode).toBe(401);
      }
      const r = await app2.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: PHONE, code } });
      expect(r.statusCode).toBe(401); // burned by the combined 5
      expect((await otpStore.listAuthAudit(PHONE)).filter(x => x.kind === 'otp.verify.lockout')).toHaveLength(1);
    } finally {
      await app2.close();
    }
  });
});

describe('OTP lockout window (injected clock)', () => {
  it('verify works again after the lockout expires', async () => {
    let clock = Date.parse('2026-09-14T12:00:00+03:00');
    const app2 = buildApp(repo, new AuthService(repo, 'test-secret', () => clock, otpStore));
    await app2.ready();
    try {
      const req = await app2.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: PHONE } });
      const code = req.json().devCode as string;
      const wrong = wrongFor(code);
      for (let i = 0; i < 5; i++) {
        await app2.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: PHONE, code: wrong } });
      }
      clock += 9 * 60 * 1000; // still locked
      const code2 = (await app2.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: PHONE } })).json().devCode as string;
      expect((await app2.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: PHONE, code: code2 } })).statusCode).toBe(401);
      clock += 2 * 60 * 1000; // lockout over
      const code3 = (await app2.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: PHONE } })).json().devCode as string;
      expect((await app2.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: PHONE, code: code3 } })).statusCode).toBe(200);
    } finally {
      await app2.close();
    }
  });
});
