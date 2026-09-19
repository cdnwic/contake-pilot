/** SA3 section 2 (ruling 2026-09-19): ONE canonical operator entrypoint.
 *  Verification is ENUMERATIVE, not anecdotal: every invocation path an
 *  operator or script can reach - package scripts, documented commands,
 *  wrappers, direct invocations of shipped sources - is listed HERE and
 *  confirmed to land in the gated entrypoint (scripts/migrate.mts ->
 *  runMigrations with the issued-nonce gate). The ungated cli.ts is deleted
 *  from reach. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const API_ROOT = path.resolve(__dirname, '..');

const walk = (dir: string, ext: string): string[] => {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, ext));
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
};

describe('SA3 canonical entrypoint enumeration', () => {
  it('package scripts: migrate:release routes to the gated scripts/migrate.mts', () => {
    const pkg = JSON.parse(readFileSync(path.join(API_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['migrate:release']).toBe('tsx scripts/migrate.mts');
    // no OTHER package script can reach a migration runner path
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      if (name === 'migrate:release') continue;
      expect(cmd, `script '${name}' must not reach a migration cli`).not.toMatch(/migrations\/cli|migrate\.mts|runMigrations/);
    }
  });

  it('the ungated cli.ts is DELETED from reach (source and built artifact)', () => {
    expect(existsSync(path.join(API_ROOT, 'src', 'migrations', 'cli.ts'))).toBe(false);
    expect(existsSync(path.join(API_ROOT, 'dist', 'migrations', 'cli.js'))).toBe(false);
  });

  it('enumerative: EVERY shipped source that references runMigrations is on the gated allowlist', () => {
    const ALLOWLIST = new Set([
      path.join(API_ROOT, 'src', 'migrations', 'runner.ts'), // the definition itself
    ]);
    const offenders: string[] = [];
    for (const f of [...walk(path.join(API_ROOT, 'src'), '.ts'), ...walk(path.join(API_ROOT, 'scripts'), '.mts')]) {
      const text = readFileSync(f, 'utf8');
      if (/\brunMigrations\b/.test(text) && !ALLOWLIST.has(f)) offenders.push(f);
    }
    // scripts/migrate.mts is the ONE canonical gated operator entrypoint:
    expect(offenders.sort()).toEqual([path.join(API_ROOT, 'scripts', 'migrate.mts')]);
  });

  it('SA3 section 3: no caller-label gate exemption exists anywhere in shipped sources', () => {
    for (const f of [...walk(path.join(API_ROOT, 'src'), '.ts'), ...walk(path.join(API_ROOT, 'scripts'), '.mts')]) {
      const text = readFileSync(f, 'utf8');
      expect(text, `${f} must not carry a test-lane gate exemption`).not.toMatch(/!== 'test-harness'|=== 'test-harness'|deployment !== 'test'|deployment === 'test'/);
    }
  });

  it('dist-discipline (R5): when dist exists, the BUILT artifact carries the gate and no exemption', () => {
    const distRunner = path.join(API_ROOT, 'dist', 'migrations', 'runner.js');
    if (!existsSync(distRunner)) return; // src-only lane; the evidence DIST lane asserts this too
    const text = readFileSync(distRunner, 'utf8');
    expect(text).toContain('schema_migration_acks'); // the issued-nonce lifecycle IS in the artifact
    expect(text).not.toContain('test-harness');
    expect(existsSync(path.join(API_ROOT, 'dist', 'migrations', 'cli.js'))).toBe(false);
  });

  it('documented commands resolve to the gated entrypoint', () => {
    const doc = readFileSync(path.join(API_ROOT, '..', '..', 'docs', 'release-migrations-v1.0.md'), 'utf8');
    expect(doc).toContain('scripts/migrate.mts');
    // the deleted cli's flag shape must not survive on ANY migrate:release line
    expect(doc.split('\n').filter(l => l.includes('migrate:release') && l.includes('--expect-host'))).toEqual([]);
  });
});
