/** Priority-zero hotfix (2026-09-17): auth/OTP/seed fail-closed contract.
 *  - boot refusal: postgres-shaped boot (DATABASE_URL set) with missing or
 *    empty CONTAKE_AUTH_SECRET refuses to boot - unit-level via
 *    resolveAuthSecret AND black-box via a real server.ts subprocess;
 *  - devCode: /v1/auth/otp/request exposes devCode ONLY for
 *    CONTAKE_DEV_OTP === 'true' (unset/empty/garbage stay closed);
 *  - seed: a demo seed applies only on an explicit recognized CONTAKE_SEED;
 *    unset/unrecognized boots seed-free (production seed-free). */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import { LOCAL_DEV_AUTH_SECRET, devOtpEnabled, resolveAuthSecret, resolveSeedMode } from '../src/boot-config.js';
import { makeTestRepo } from './helpers/repo.js';

describe('resolveAuthSecret (fail-closed)', () => {
  it('returns the configured secret when non-empty', () => {
    expect(resolveAuthSecret({ CONTAKE_AUTH_SECRET: 's3cret', DATABASE_URL: 'postgres://x' })).toBe('s3cret');
    expect(resolveAuthSecret({ CONTAKE_AUTH_SECRET: 's3cret' })).toBe('s3cret');
  });
  it('REFUSES postgres-shaped boot when the secret is missing', () => {
    expect(() => resolveAuthSecret({ DATABASE_URL: 'postgres://x' })).toThrow(/CONTAKE_AUTH_SECRET/);
  });
  it('REFUSES postgres-shaped boot when the secret is EMPTY', () => {
    expect(() => resolveAuthSecret({ DATABASE_URL: 'postgres://x', CONTAKE_AUTH_SECRET: '' })).toThrow(/CONTAKE_AUTH_SECRET/);
  });
  it('memory/dev falls back to the explicit NON-DEPLOYABLE local constant (never env-adjacent)', () => {
    expect(resolveAuthSecret({})).toBe(LOCAL_DEV_AUTH_SECRET);
    expect(LOCAL_DEV_AUTH_SECRET).toContain('NOT-DEPLOYABLE');
    expect(new AuthService({} as never).issueToken).toBeDefined(); // default ctor stays local-dev
  });
});

describe('devOtpEnabled (exact opt-in)', () => {
  it('only the literal string true opens devCode', () => {
    expect(devOtpEnabled({ CONTAKE_DEV_OTP: 'true' })).toBe(true);
    for (const v of [undefined, '', 'false', '1', 'yes', 'TRUE', 'True', ' true']) {
      expect(devOtpEnabled({ CONTAKE_DEV_OTP: v })).toBe(false);
    }
  });
});

describe('resolveSeedMode (explicit only)', () => {
  it('recognized explicit values map through', () => {
    expect(resolveSeedMode({ CONTAKE_SEED: 'demo' })).toBe('demo');
    expect(resolveSeedMode({ CONTAKE_SEED: 'camp-demo' })).toBe('camp-demo');
    expect(resolveSeedMode({ CONTAKE_SEED: 'all-demo' })).toBe('all-demo');
  });
  it('unset/empty/garbage mean NO seed (production seed-free)', () => {
    for (const v of [undefined, '', '1', 'true', 'DEMO', 'camp']) {
      expect(resolveSeedMode({ CONTAKE_SEED: v })).toBeUndefined();
    }
  });
});

describe('route: /v1/auth/otp/request devCode exposure', () => {
  const saved = process.env['CONTAKE_DEV_OTP'];
  afterEach(() => {
    if (saved === undefined) delete process.env['CONTAKE_DEV_OTP'];
    else process.env['CONTAKE_DEV_OTP'] = saved;
  });
  const otpRequest = async () => {
    const app = buildApp(await makeTestRepo(), new AuthService(await makeTestRepo()));
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '+15550100001' } });
    await app.close();
    return res;
  };
  it('UNSET -> no devCode in the response (closed)', async () => {
    delete process.env['CONTAKE_DEV_OTP'];
    const res = await otpRequest();
    expect(res.statusCode).toBe(200);
    expect(res.json().sent).toBe(true);
    expect(res.json().devCode).toBeUndefined();
  });
  it("garbage values ('1', 'TRUE') -> no devCode (closed)", async () => {
    for (const v of ['1', 'TRUE']) {
      process.env['CONTAKE_DEV_OTP'] = v;
      const res = await otpRequest();
      expect(res.json().devCode).toBeUndefined();
    }
  });
  it("exact 'true' -> devCode present (the only open case)", async () => {
    process.env['CONTAKE_DEV_OTP'] = 'true';
    const res = await otpRequest();
    expect(res.statusCode).toBe(200);
    expect(String(res.json().devCode)).toMatch(/^\d{6}$/);
  });
});

/** Black-box boot refusal: the REAL server.ts entrypoint, postgres-shaped
 *  env, no secret -> the process must die before listening. */
describe('server boot refusal (real entrypoint subprocess)', () => {
  const boot = (env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> =>
    new Promise((resolvePromise, reject) => {
      const child = spawn('npx', ['tsx', 'src/server.ts'], {
        env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'production', PORT: '0', ...env },
        cwd: process.cwd(),
      });
      let out = '';
      child.stdout.on('data', d => { out += String(d); });
      child.stderr.on('data', d => { out += String(d); });
      child.on('error', reject);
      const killer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`boot subprocess timed out; output: ${out}`)); }, 25000);
      child.on('exit', code => { clearTimeout(killer); resolvePromise({ code, out }); });
    });

  it('DATABASE_URL set + CONTAKE_AUTH_SECRET missing -> refuses to boot, names the secret', async () => {
    const { code, out } = await boot({ DATABASE_URL: 'postgres://postgres@localhost:1/postgres' });
    expect(code).not.toBe(0);
    expect(out).toContain('CONTAKE_AUTH_SECRET');
  }, 30000);

  it('DATABASE_URL set + CONTAKE_AUTH_SECRET empty -> refuses to boot', async () => {
    const { code, out } = await boot({ DATABASE_URL: 'postgres://postgres@localhost:1/postgres', CONTAKE_AUTH_SECRET: '' });
    expect(code).not.toBe(0);
    expect(out).toContain('CONTAKE_AUTH_SECRET');
  }, 30000);
});
