/** Closed CLI parser contract (independent security, 2026-09-18). */
import { describe, expect, it } from 'vitest';
import { assertFreshOutputPath, parseCliArgs, resolveDatabaseUrl, validateActor } from '../src/migrations/cli-args.js';

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
  it('output paths never clobber', () => {
    expect(assertFreshOutputPath('/tmp/new-file.json', () => false)).toBe('/tmp/new-file.json');
    expect(() => assertFreshOutputPath('/tmp/existing.json', () => true)).toThrow(/clobber/);
    expect(() => assertFreshOutputPath('', () => false)).toThrow(/invalid output path/);
  });
});
