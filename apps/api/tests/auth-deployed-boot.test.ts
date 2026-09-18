/** Deployed-boot fail-closed regressions (security FAIL 2026-09-18, folded
 *  into SA v8 resubmission):
 *  (2) production fails CLOSED at boot unless a strong explicitly managed
 *      CONTAKE_AUTH_SECRET is set; the dev fallback exists ONLY under
 *      explicit test mode, which the deployed entry point refuses; a token
 *      forged with the known public default is independently rejected.
 *  (3) dev OTP disclosure is OPT-IN only under explicit nonproduction/test
 *      mode, and deployed startup refuses to boot with it enabled.
 *  Memory lane only (config/auth logic, no SQL). Synthetic secrets only. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';

import { buildApp } from '../src/app.js';
import {
  assertDeployedBoot, AuthSecretConfigError, AuthService, DEV_ONLY_AUTH_SECRET,
  devOtpDisclosureEnabled, isExplicitTestMode, MIN_AUTH_SECRET_LENGTH, resolveAuthSecret,
} from '../src/auth.js';
import { MemoryGraphRepository } from '../src/repo/memory.js';
import { seedDemo } from '../src/seed.js';

const KEYS = ['CONTAKE_AUTH_SECRET', 'CONTAKE_DEV_OTP', 'CONTAKE_TEST_MODE', 'NODE_ENV'] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const clearModes = () => { delete process.env['CONTAKE_TEST_MODE']; delete process.env['NODE_ENV']; delete process.env['CONTAKE_DEV_OTP']; };
const STRONG = 'managed-secret-0123456789abcdef0123456789'; // synthetic, 41 chars

describe('explicit test mode', () => {
  it('is on under CONTAKE_TEST_MODE=true or NODE_ENV=test, off otherwise', () => {
    clearModes();
    expect(isExplicitTestMode()).toBe(false);
    process.env['CONTAKE_TEST_MODE'] = 'true';
    expect(isExplicitTestMode()).toBe(true);
    delete process.env['CONTAKE_TEST_MODE'];
    process.env['NODE_ENV'] = 'test';
    expect(isExplicitTestMode()).toBe(true);
  });
});

describe('auth secret resolution (fail closed)', () => {
  it('an explicit constructor argument wins (tests inject their own)', () => {
    clearModes();
    expect(resolveAuthSecret('test-secret')).toBe('test-secret');
  });
  it('a strong managed env secret is used', () => {
    clearModes();
    process.env['CONTAKE_AUTH_SECRET'] = STRONG;
    expect(resolveAuthSecret(undefined)).toBe(STRONG);
  });
  it('REFUSES the known public dev value as a managed env secret', () => {
    clearModes();
    process.env['CONTAKE_AUTH_SECRET'] = DEV_ONLY_AUTH_SECRET;
    expect(() => resolveAuthSecret(undefined)).toThrow(AuthSecretConfigError);
  });
  it('REFUSES a weak (<min length) managed env secret', () => {
    clearModes();
    process.env['CONTAKE_AUTH_SECRET'] = 'x'.repeat(MIN_AUTH_SECRET_LENGTH - 1);
    expect(() => resolveAuthSecret(undefined)).toThrow(/weak/i);
  });
  it('falls back to the dev secret ONLY under explicit test mode', () => {
    clearModes();
    delete process.env['CONTAKE_AUTH_SECRET'];
    expect(() => resolveAuthSecret(undefined)).toThrow(/fail CLOSED/i);
    process.env['NODE_ENV'] = 'test';
    expect(resolveAuthSecret(undefined)).toBe(DEV_ONLY_AUTH_SECRET);
  });
  it('AuthService construction without any secret fails CLOSED outside test mode', () => {
    clearModes();
    delete process.env['CONTAKE_AUTH_SECRET'];
    const repo = MemoryGraphRepository.seeded(seedDemo());
    expect(() => new AuthService(repo)).toThrow(AuthSecretConfigError);
  });
});

describe('deployed-boot gate', () => {
  it('refuses explicit test mode', () => {
    clearModes();
    process.env['CONTAKE_AUTH_SECRET'] = STRONG;
    process.env['NODE_ENV'] = 'test';
    expect(() => assertDeployedBoot()).toThrow(/test mode/i);
  });
  it('refuses dev OTP disclosure opt-in', () => {
    clearModes();
    process.env['CONTAKE_AUTH_SECRET'] = STRONG;
    process.env['CONTAKE_DEV_OTP'] = 'true';
    expect(() => assertDeployedBoot()).toThrow(/OTP disclosure/i);
  });
  it('refuses a missing or weak managed secret', () => {
    clearModes();
    delete process.env['CONTAKE_AUTH_SECRET'];
    expect(() => assertDeployedBoot()).toThrow(AuthSecretConfigError);
    process.env['CONTAKE_AUTH_SECRET'] = 'short';
    expect(() => assertDeployedBoot()).toThrow(/weak/i);
  });
  it('passes with a strong managed secret and no test/dev flags', () => {
    clearModes();
    process.env['CONTAKE_AUTH_SECRET'] = STRONG;
    expect(() => assertDeployedBoot()).not.toThrow();
  });
});

describe('dev OTP disclosure (opt-in only, test mode only)', () => {
  it('is OFF by default, OFF on explicit false, OFF without test mode even when opted in', () => {
    clearModes();
    delete process.env['CONTAKE_DEV_OTP'];
    expect(devOtpDisclosureEnabled()).toBe(false);
    process.env['CONTAKE_DEV_OTP'] = 'false';
    expect(devOtpDisclosureEnabled()).toBe(false);
    process.env['CONTAKE_DEV_OTP'] = 'true';
    expect(devOtpDisclosureEnabled()).toBe(false); // no test mode -> still off
    process.env['NODE_ENV'] = 'test';
    expect(devOtpDisclosureEnabled()).toBe(true);
  });
  it('HTTP: the OTP response carries NO devCode unless disclosure is opted in under test mode', async () => {
    const repo = MemoryGraphRepository.seeded(seedDemo());
    const app = buildApp(repo, new AuthService(repo, 'test-secret'));
    delete process.env['CONTAKE_DEV_OTP']; // suite setup opts in; this test controls it
    const r1 = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '+972500000001' } });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().devCode).toBeUndefined();
    process.env['CONTAKE_DEV_OTP'] = 'true';
    const r2 = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '+972500000002' } });
    expect(r2.json().devCode).toMatch(/^\d{6}$/);
  });
});

describe('known-default forgery is independently rejected', () => {
  it('a token forged with the known PUBLIC dev secret is rejected by an app on a managed secret; the managed token passes', async () => {
    clearModes();
    process.env['CONTAKE_AUTH_SECRET'] = STRONG;
    const repo = MemoryGraphRepository.seeded(seedDemo());
    const auth = new AuthService(repo); // resolves the managed env secret
    const app = buildApp(repo, auth);
    // INDEPENDENT forgery: built here from the known public literal, not via
    // any AuthService path.
    const payload = Buffer.from(JSON.stringify({ sub: 'u-admin', exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url');
    const forgedSig = createHmac('sha256', DEV_ONLY_AUTH_SECRET).update(payload).digest('base64url');
    const forged = await app.inject({ method: 'GET', url: '/v1/whoami', headers: { authorization: `Bearer ${payload}.${forgedSig}` } });
    expect(forged.statusCode).toBe(401);
    // control: a token issued under the managed secret authenticates
    const good = await app.inject({ method: 'GET', url: '/v1/whoami', headers: { authorization: `Bearer ${auth.issueToken('u-admin')}` } });
    expect(good.statusCode).toBe(200);
  });
});
