/** Priority-zero hotfix (2026-09-17): auth/OTP/seed fail-closed contract.
 *  - boot refusal: postgres-shaped boot (DATABASE_URL set) with missing or
 *    empty CONTAKE_AUTH_SECRET refuses to boot - unit-level via
 *    resolveAuthSecret AND black-box via a real server.ts subprocess;
 *  - devCode: /v1/auth/otp/request exposes devCode ONLY for
 *    CONTAKE_DEV_OTP === 'true' (unset/empty/garbage stay closed);
 *  - seed: a demo seed applies only on an explicit recognized CONTAKE_SEED;
 *    unset/unrecognized boots seed-free (production seed-free). */
import { afterEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import { DENIED_SECRETS, LOCAL_DEV_AUTH_SECRET, MIN_AUTH_SECRET_LENGTH, assertBootPolicy, devOtpEnabled, resolveAuthSecret, resolveSeedMode } from '../src/boot-config.js';
import { makeTestRepo } from './helpers/repo.js';

describe('resolveAuthSecret (fail-closed)', () => {
  // Positive fixtures are generated AT TEST RUNTIME (independent security,
  // 2026-09-18): no fixed accepted-format secret is ever committed.
  const STRONG = randomBytes(32).toString('hex'); // canonical 64-hex
  const STRONG_B64 = randomBytes(32).toString('base64url').replace(/=+$/, ''); // 43 base64url (must be REJECTED)
  it('returns the configured secret when non-empty, trimmed, and strong enough', () => {
    expect(resolveAuthSecret({ CONTAKE_AUTH_SECRET: STRONG, DATABASE_URL: 'postgres://x' })).toBe(STRONG);
    expect(resolveAuthSecret({ CONTAKE_AUTH_SECRET: `  ${STRONG}  ` })).toBe(STRONG); // trimmed
  });
  it('REFUSES every permanently denied secret (fallbacks + exposed public fixtures)', () => {
    expect(DENIED_SECRETS.length).toBeGreaterThanOrEqual(4); // 2 fallbacks + 2 exposed
    for (const denied of DENIED_SECRETS) {
      expect(() => resolveAuthSecret({ CONTAKE_AUTH_SECRET: denied })).toThrow(/refusing to boot|fallback/);
      expect(() => resolveAuthSecret({ CONTAKE_AUTH_SECRET: denied, DATABASE_URL: 'postgres://x' })).toThrow(/refusing to boot|fallback/);
    }
  });
  it('the exported denylist is a DETACHED FROZEN copy: external mutation attempts cannot alter resolver denial', () => {
    const members = [...DENIED_SECRETS];
    expect(Object.isFrozen(DENIED_SECRETS)).toBe(true);
    const mutable = DENIED_SECRETS as unknown as string[];
    // every mutation attempt on the export fails loud (frozen, strict mode) ...
    expect(() => { mutable.push('injected'); }).toThrow(TypeError);
    expect(() => { mutable.length = 0; }).toThrow(TypeError);
    expect(() => { mutable.pop(); }).toThrow(TypeError);
    expect(() => { mutable.splice(0, 1); }).toThrow(TypeError);
    expect(() => { delete mutable[0]; }).toThrow(TypeError);
    expect(() => { mutable[0] = 'overwritten'; }).toThrow(TypeError);
    expect(() => { mutable.reverse(); }).toThrow(TypeError);
    expect(() => { mutable.sort(); }).toThrow(TypeError);
    expect(() => { mutable.fill('x'); }).toThrow(TypeError);
    expect(() => { mutable.copyWithin(0, 1); }).toThrow(TypeError);
    // ... the export is unchanged ...
    expect([...DENIED_SECRETS]).toEqual(members);
    // ... and the resolver still refuses EVERY denied member, both shapes.
    for (const denied of members) {
      expect(() => resolveAuthSecret({ CONTAKE_AUTH_SECRET: denied })).toThrow(/refusing to boot|fallback/);
      expect(() => resolveAuthSecret({ CONTAKE_AUTH_SECRET: denied, DATABASE_URL: 'postgres://x' })).toThrow(/refusing to boot|fallback/);
    }
    // No aliasing back door: the export shares no identity with any Set.
    expect(DENIED_SECRETS instanceof Set).toBe(false);
  });

  it('REJECTS known fallback values even when explicitly configured', () => {
    for (const bad of ['contake-dev-secret', LOCAL_DEV_AUTH_SECRET]) {
      expect(() => resolveAuthSecret({ CONTAKE_AUTH_SECRET: bad })).toThrow(/fallback/);
      expect(() => resolveAuthSecret({ CONTAKE_AUTH_SECRET: bad, DATABASE_URL: 'postgres://x' })).toThrow(/fallback/);
    }
  });
  it('REJECTS secrets shorter than the minimum length', () => {
    expect(() => resolveAuthSecret({ CONTAKE_AUTH_SECRET: STRONG.slice(0, 31) })).toThrow(/shorter/);
  });
  it('accepts ONLY canonical 64-char lowercase hex of 32 bytes (security v2: hex-only)', () => {
    expect(resolveAuthSecret({ CONTAKE_AUTH_SECRET: STRONG })).toBe(STRONG);
    expect(() => resolveAuthSecret({ CONTAKE_AUTH_SECRET: STRONG.toUpperCase() })).toThrow(/refusing to boot/); // non-canonical case
    // base64url support REMOVED (canonical decode/re-encode not implemented):
    expect(() => resolveAuthSecret({ CONTAKE_AUTH_SECRET: STRONG_B64 })).toThrow(/refusing to boot/);
  });
  it('REJECTS secrets failing the encoding policy even at sufficient length/diversity', () => {
    // 32-char mixed passphrase: long and diverse, but NOT canonical 64-hex.
    expect(() => resolveAuthSecret({ CONTAKE_AUTH_SECRET: 'Kx9$mQ2vR7nW4pLzT8bYcJ5dFhG3sA6e' })).toThrow(/refusing to boot/);
    // hex but 63/65 chars (truncated/padded).
    expect(() => resolveAuthSecret({ CONTAKE_AUTH_SECRET: STRONG.slice(0, 63) })).toThrow();
    expect(() => resolveAuthSecret({ CONTAKE_AUTH_SECRET: STRONG + 'f' })).toThrow();
    // padded/standard base64url shapes.
    expect(() => resolveAuthSecret({ CONTAKE_AUTH_SECRET: STRONG_B64 + '=' })).toThrow();
    expect(() => resolveAuthSecret({ CONTAKE_AUTH_SECRET: STRONG_B64.slice(0, 42) + '+' })).toThrow();
  });
  it('REJECTS predictable format-matching hex: repeated cycles and ascending patterns', () => {
    expect(() => resolveAuthSecret({ CONTAKE_AUTH_SECRET: 'a'.repeat(64) })).toThrow(/refusing to boot/);
    expect(() => resolveAuthSecret({ CONTAKE_AUTH_SECRET: 'ab'.repeat(32) })).toThrow(/repeated cycle/);
    expect(() => resolveAuthSecret({ CONTAKE_AUTH_SECRET: '0123456789abcdef'.repeat(4) })).toThrow(/repeated cycle/); // valid hex, full diversity, still a cycle
    expect(() => resolveAuthSecret({ CONTAKE_AUTH_SECRET: 'deadbeef'.repeat(8) })).toThrow(/repeated cycle/);
    expect(() => resolveAuthSecret({ CONTAKE_AUTH_SECRET: 'fedcba9876543210'.repeat(4) })).toThrow(/repeated cycle/); // descending cycle
    expect(() => resolveAuthSecret({ CONTAKE_AUTH_SECRET: '0123456789'.repeat(7) })).toThrow(/refusing to boot/); // wrong shape entirely
  });  it('REQUIRES a secret for NODE_ENV=production even WITHOUT DATABASE_URL (adapter-independent)', () => {
    expect(() => resolveAuthSecret({ NODE_ENV: 'production' })).toThrow(/CONTAKE_AUTH_SECRET/);
  });
  it('REFUSES postgres-shaped boot when the secret is missing', () => {
    expect(() => resolveAuthSecret({ DATABASE_URL: 'postgres://x' })).toThrow(/CONTAKE_AUTH_SECRET/);
  });
  it('REFUSES postgres-shaped boot when the secret is EMPTY', () => {
    expect(() => resolveAuthSecret({ DATABASE_URL: 'postgres://x', CONTAKE_AUTH_SECRET: '' })).toThrow(/CONTAKE_AUTH_SECRET/);
  });
  it('production-boot invariants (assertBootPolicy): no memory fallback, no test mode, no dev OTP, no seed', () => {
    expect(() => assertBootPolicy({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL/);
    expect(() => assertBootPolicy({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x', CONTAKE_TEST_MODE: 'true' })).toThrow(/CONTAKE_TEST_MODE/);
    expect(() => assertBootPolicy({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x', CONTAKE_DEV_OTP: 'true' })).toThrow(/CONTAKE_DEV_OTP/);
    expect(() => assertBootPolicy({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x', CONTAKE_SEED: 'camp-demo' })).toThrow(/CONTAKE_SEED/);
    expect(() => assertBootPolicy({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x' })).not.toThrow();
    expect(() => assertBootPolicy({ CONTAKE_TEST_MODE: 'true', CONTAKE_SEED: 'camp-demo' })).not.toThrow(); // non-production: untouched
  });
  it('devOtpEnabled is closed in a production boot even for exact true', () => {
    expect(devOtpEnabled({ CONTAKE_DEV_OTP: 'true', NODE_ENV: 'production' })).toBe(false);
  });
  it('memory/dev falls back to the explicit NON-DEPLOYABLE local constant (never env-adjacent)', () => {
    expect(resolveAuthSecret({})).toBe(LOCAL_DEV_AUTH_SECRET);
    expect(LOCAL_DEV_AUTH_SECRET).toContain('NOT-DEPLOYABLE');
    expect(new AuthService({} as never).issueToken).toBeDefined(); // default ctor stays local-dev
  });
});

describe('documented secret generators (doc/parser alignment, QA 2026-09-18)', () => {
  /** Extracts EVERY backtick-quoted `openssl rand ...` command documented in
   *  docs/pilot-auth.md, executes it, and passes the output through the real
   *  resolver. A doc that teaches an output the parser rejects FAILS here. */
  it('every documented generator produces a resolver-ACCEPTED secret', () => {
    const doc = readFileSync(new URL('../../../docs/pilot-auth.md', import.meta.url), 'utf8');
    const cmds = [...doc.matchAll(/`openssl rand [^`]+`/g)].map(m => m[0].slice(1, -1));
    expect(cmds.length).toBeGreaterThanOrEqual(1);
    for (const cmd of cmds) {
      const out = execSync(cmd, { encoding: 'utf8' }).trim();
      expect(resolveAuthSecret({ CONTAKE_AUTH_SECRET: out }), `documented generator rejected: ${cmd}`).toBe(out);
    }
  });
  it('bare padded standard base64 (the previous doc advice) is REJECTED', () => {
    const out = execSync('openssl rand -base64 32', { encoding: 'utf8' }).trim();
    expect(() => resolveAuthSecret({ CONTAKE_AUTH_SECRET: out })).toThrow(/refusing to boot/);
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
