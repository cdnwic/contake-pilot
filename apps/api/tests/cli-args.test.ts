/** Closed CLI parser contract (independent security, 2026-09-18). */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { durablePublish, parseCliArgs, resolveDatabaseUrl, validateActor } from '../src/migrations/cli-args.js';

const spec = { required: ['--deployment'], optional: ['--by', '--database-url'] } as const;

describe('closed CLI parser', () => {
  it('accepts exact flag/value pairs', () => {
    expect(parseCliArgs(['--deployment', 'staging', '--by', 'ops'], spec)).toEqual({ '--deployment': 'staging', '--by': 'ops' });
  });
  it('rejects unknown flags', () => {
    expect(() => parseCliArgs(['--deployment', 'staging', '--evil', 'x'], spec)).toThrow(/unknown flag/);
  });
  it('rejects duplicate flags', () => {
    expect(() => parseCliArgs(['--deployment', 'a', '--deployment', 'b'], spec)).toThrow(/duplicate/);
  });
  it('rejects bare positional arguments', () => {
    expect(() => parseCliArgs(['staging'], spec)).toThrow(/bare positional/);
  });
  it('rejects missing required flags and missing values', () => {
    expect(() => parseCliArgs([], spec)).toThrow(/required flag/);
    expect(() => parseCliArgs(['--deployment'], spec)).toThrow(/requires a value/);
    expect(() => parseCliArgs(['--deployment', '--by', 'x'], spec)).toThrow(/requires a value/);
  });
  it('one deliberate URL source: both or neither is an error', () => {
    expect(resolveDatabaseUrl('postgresql://a/b', undefined)).toBe('postgresql://a/b');
    expect(resolveDatabaseUrl(undefined, 'postgresql://a/b')).toBe('postgresql://a/b');
    expect(() => resolveDatabaseUrl('postgresql://a/b', 'postgresql://a/b')).toThrow(/ONE deliberate source/);
    expect(() => resolveDatabaseUrl(undefined, undefined)).toThrow(/required/);
  });
  it('bounded/canonical actor labels', () => {
    expect(validateActor('release-job')).toBe('release-job');
    expect(() => validateActor('bad actor!')).toThrow(/invalid --by actor/);
    expect(() => validateActor('x'.repeat(100))).toThrow(/invalid --by actor/);
  });
  it('durable publication: full-write, fsync, atomic no-clobber link, dir fsync, reconciliation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-args-'));
    try {
      const target = join(dir, 'inventory.json');
      durablePublish(target, '{"ok":1}');
      expect(readFileSync(target, 'utf8')).toBe('{"ok":1}');
      // existing path refused atomically; contents untouched; no temp left
      expect(() => durablePublish(target, '{"ok":2}')).toThrow(/clobber/);
      expect(readFileSync(target, 'utf8')).toBe('{"ok":1}');
      expect(readdirSync(dir).filter(f => f.includes('contake-tmp'))).toHaveLength(0);
      // symlink refused
      const link = join(dir, 'link.json');
      symlinkSync(join(dir, 'victim.json'), link);
      expect(() => durablePublish(link, 'x')).toThrow(/clobber/);
      // race: exactly one winner, coherent contents
      const race = join(dir, 'race.json');
      const results = [0, 1].map(i => {
        try { durablePublish(race, `{"winner":${i}}`); return 'won'; } catch { return 'lost'; }
      });
      expect(results.filter(r => r === 'won')).toHaveLength(1);
      expect(readFileSync(race, 'utf8')).toMatch(/^\{"winner":[01]\}$/);
      // indeterminate prior state: leftover temp demands explicit reconciliation
      const rec = join(dir, 'rec.json');
      writeFileSync(join(dir, 'rec.json.contake-tmp-1-aaaa'), 'partial');
      expect(() => durablePublish(rec, '{}')).toThrow(/indeterminate prior publication state.*rec\.json\.contake-tmp-1-aaaa/);
      rmSync(join(dir, 'rec.json.contake-tmp-1-aaaa'));
      durablePublish(rec, '{}'); // reconciled: publish proceeds
      expect(() => durablePublish('', 'x')).toThrow(/invalid output path/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
