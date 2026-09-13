/** QA-ADV OTP lockout probes (QA-owned, adversarial; pilot-prep #2 gate).
 *  Beyond the backend's otp-lockout suite: threshold exactness, counter-vs-code
 *  scoping, expiry interaction, 5-class enumeration shape, and a true-concurrency
 *  burst against the shared counter (multi-row lockout-audit race). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService, type OtpStateStore } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestBackend } from './helpers/repo.js';

let repo: GraphRepository; let otpStore: OtpStateStore; let app: FastifyInstance;
beforeEach(async () => { ({ repo, otpStore } = await makeTestBackend()); });
const PHONE = '+972500000001';
const PHONE2 = '+972500000002'; // seeded? verify falls to unknown-user 401 only AFTER a valid code; used only where noted
const mkApp = async (now?: () => number) => {
  const a = buildApp(repo, new AuthService(repo, 'test-secret', now, otpStore));
  await a.ready();
  return a;
};
const requestOtp = (a: FastifyInstance, phone = PHONE) => a.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } });
const verifyOtp = (a: FastifyInstance, phone: string, code: string) => a.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code } });
const wrongFor = (code: string) => (code === '000000' ? '000001' : '000000');

describe('QA-ADV OTP lockout', () => {
  beforeEach(async () => { app = await mkApp(); });
  afterEach(async () => { await app.close(); });

  it('ADV-1 threshold exactness: attempts 1-4 leave the code alive, 5 burns (counter readable at each step)', async () => {
    const code = (await requestOtp(app)).json().devCode as string;
    const wrong = wrongFor(code);
    for (let i = 1; i <= 4; i++) {
      expect((await verifyOtp(app, PHONE, wrong)).statusCode).toBe(401);
      const st = await otpStore.getVerifyState(PHONE);
      expect(st?.attempts).toBe(i);
      expect(st?.lockedUntil).toBeUndefined();
    }
    expect((await verifyOtp(app, PHONE, code)).statusCode).toBe(200); // alive at 4
    expect(await otpStore.getVerifyState(PHONE)).toBeUndefined(); // success resets
  });

  it('ADV-2 enumeration shape: wrong / burned / locked / expired / unknown-phone are byte-identical 401s', async () => {
    let clock = Date.parse('2026-09-14T12:00:00+03:00');
    const timed = await mkApp(() => clock);
    try {
      const code = (await requestOtp(timed)).json().devCode as string;
      const wrong = wrongFor(code);
      const rWrong = await verifyOtp(timed, PHONE, wrong);
      // burn + lock at the 5th
      for (let i = 0; i < 4; i++) await verifyOtp(timed, PHONE, wrong);
      const rBurned = await verifyOtp(timed, PHONE, code); // correct code, code burned
      const rLocked = await verifyOtp(timed, PHONE, code); // still locked
      const rUnknown = await verifyOtp(timed, '+972599999999', '123456'); // ghost phone
      // expired class: fresh phone, fresh code, advance past TTL, then present (wrong AND right)
      const p2 = (await requestOtp(timed, PHONE)).json().devCode as string; // phone is locked for VERIFY but request-side still responds
      clock += 11 * 60 * 1000; // past 10-min TTL (and past the lock window)
      const rExpiredWrong = await verifyOtp(timed, PHONE, wrongFor(p2));
      const rExpiredRight = await verifyOtp(timed, PHONE, p2);
      for (const r of [rWrong, rBurned, rLocked, rUnknown, rExpiredWrong, rExpiredRight]) expect(r.statusCode).toBe(401);
      const bodies = new Set([rWrong, rBurned, rLocked, rUnknown, rExpiredWrong, rExpiredRight].map(r => r.body));
      expect(bodies.size).toBe(1); // one byte-identical failure shape across all classes
    } finally { await timed.close(); }
  });

  it('ADV-3 expired-code wrong presentation does NOT increment the counter', async () => {
    let clock = Date.parse('2026-09-14T12:00:00+03:00');
    const timed = await mkApp(() => clock);
    try {
      const code = (await requestOtp(timed)).json().devCode as string;
      clock += 11 * 60 * 1000; // expire the code
      expect((await verifyOtp(timed, PHONE, wrongFor(code))).statusCode).toBe(401);
      expect((await otpStore.getVerifyState(PHONE))?.attempts ?? 0).toBe(0);
    } finally { await timed.close(); }
  });

  it('ADV-4 counter is per-PHONE not per-code: 4 wrong on code A + 1 wrong on fresh code B burns B and locks', async () => {
    let clock = Date.parse('2026-09-14T12:00:00+03:00');
    const timed = await mkApp(() => clock);
    try {
      const a = (await requestOtp(timed)).json().devCode as string;
      for (let i = 0; i < 4; i++) await verifyOtp(timed, PHONE, wrongFor(a));
      clock += 11 * 60 * 1000; // A expires
      const b = (await requestOtp(timed)).json().devCode as string;
      expect((await verifyOtp(timed, PHONE, wrongFor(b))).statusCode).toBe(401); // 5th consecutive wrong
      const st = await otpStore.getVerifyState(PHONE);
      expect(st?.lockedUntil).toBeGreaterThan(clock);
      expect((await verifyOtp(timed, PHONE, b)).statusCode).toBe(401); // B burned
      expect((await otpStore.listAuthAudit(PHONE)).filter(x => x.kind === 'otp.verify.lockout')).toHaveLength(1);
    } finally { await timed.close(); }
  });

  it('ADV-5 concurrent burst: 8 parallel wrong verifies enforce lockout; lockout audit rows counted (multi-row race probe)', async () => {
    const code = (await requestOtp(app)).json().devCode as string;
    const wrong = wrongFor(code);
    const results = await Promise.all(Array.from({ length: 8 }, () => verifyOtp(app, PHONE, wrong)));
    for (const r of results) expect(r.statusCode).toBe(401);
    expect((await verifyOtp(app, PHONE, code)).statusCode).toBe(401); // lockout enforced after the burst
    const rows = (await otpStore.listAuthAudit(PHONE)).filter(x => x.kind === 'otp.verify.lockout');
    console.log(`QA-ADV-5 CONCURRENCY: lockout audit rows after 8-way parallel burst = ${rows.length}`);
    expect(rows.length).toBeGreaterThanOrEqual(1); // enforcement never lost; exact count is the race observation
    expect(rows.length).toBe(1); // ideal: threshold fires exactly once even under true concurrency
  });

  it('ADV-6 during lockout a freshly requested code still cannot verify; after the window it can', async () => {
    let clock = Date.parse('2026-09-14T12:00:00+03:00');
    const timed = await mkApp(() => clock);
    try {
      const a = (await requestOtp(timed)).json().devCode as string;
      for (let i = 0; i < 5; i++) await verifyOtp(timed, PHONE, wrongFor(a));
      const b = (await requestOtp(timed)).json().devCode as string; // request-side still answers
      expect((await verifyOtp(timed, PHONE, b)).statusCode).toBe(401); // locked: even the right code fails
      clock += 10 * 60 * 1000 + 1000; // past the window (B is now expired too: TTL == lockout, both 10 min)
      expect((await verifyOtp(timed, PHONE, b)).statusCode).toBe(401); // expired, not locked
      const c = (await requestOtp(timed)).json().devCode as string; // fresh code after the window
      expect((await verifyOtp(timed, PHONE, c)).statusCode).toBe(200); // verify works again
    } finally { await timed.close(); }
  });
});
