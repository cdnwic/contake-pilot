/** users-phone-migrate CLI grammar (security 2026-09-18 v5): CLOSED flag
 *  set, ambiguous combos rejected, distinct backup/restore paths, backup
 *  required for mutations, no-MAC-key-in-argv by construction.
 *  ALL LANES (pure parser, no DB). */
import { describe, expect, it } from 'vitest';
import { CliUsageError, parseMigrateCliArgs } from '../src/services/phone-migration-cli-args.js';

const URL = 'postgres://postgres@localhost:55432/postgres';

describe('parseMigrateCliArgs (closed grammar)', () => {
  it('accepts --backup alone', () => {
    const a = parseMigrateCliArgs(['--database-url', URL, '--backup', '/tmp/b.jsonl']);
    expect(a).toEqual({ databaseUrl: URL, backup: '/tmp/b.jsonl', maintenance: false });
  });
  it('accepts --maintenance with --backup; --restore with a DISTINCT --backup', () => {
    expect(parseMigrateCliArgs(['--database-url', URL, '--backup', '/tmp/b.jsonl', '--maintenance']).maintenance).toBe(true);
    expect(parseMigrateCliArgs(['--database-url', URL, '--backup', '/tmp/b.jsonl', '--restore', '/tmp/old.jsonl']).restore).toBe('/tmp/old.jsonl');
  });
  it('REJECTS unknown flags and bare arguments', () => {
    expect(() => parseMigrateCliArgs(['--database-url', URL, '--frobnicate'])).toThrow(CliUsageError);
    expect(() => parseMigrateCliArgs(['--database-url', URL, 'stray'])).toThrow(/unknown flag/);
    expect(() => parseMigrateCliArgs(['--database-url', URL, '--mac-key', 'abc'])).toThrow(/unknown flag/); // key NEVER in argv
  });
  it('REJECTS removed split mutating flags with the v4 closure message', () => {
    expect(() => parseMigrateCliArgs(['--database-url', URL, '--normalize'])).toThrow(/REMOVED in v4/);
    expect(() => parseMigrateCliArgs(['--database-url', URL, '--create-index'])).toThrow(/REMOVED in v4/);
  });
  it('REJECTS ambiguous --restore + --maintenance', () => {
    expect(() => parseMigrateCliArgs(['--database-url', URL, '--backup', '/tmp/b.jsonl', '--restore', '/tmp/o.jsonl', '--maintenance']))
      .toThrow(/mutually exclusive/);
  });
  it('REQUIRES distinct --backup/--restore paths', () => {
    expect(() => parseMigrateCliArgs(['--database-url', URL, '--backup', '/tmp/same.jsonl', '--restore', '/tmp/same.jsonl']))
      .toThrow(/DISTINCT/);
  });
  it('REQUIRES --backup with any mutating step', () => {
    expect(() => parseMigrateCliArgs(['--database-url', URL, '--maintenance'])).toThrow(/require --backup/);
    expect(() => parseMigrateCliArgs(['--database-url', URL, '--restore', '/tmp/o.jsonl'])).toThrow(/require --backup/);
  });
  it('REQUIRES --database-url and at least one action', () => {
    expect(() => parseMigrateCliArgs(['--backup', '/tmp/b.jsonl'])).toThrow(/--database-url is required/);
    expect(() => parseMigrateCliArgs(['--database-url', URL])).toThrow(/nothing to do/);
  });
  it('REJECTS missing flag values', () => {
    expect(() => parseMigrateCliArgs(['--database-url', URL, '--backup'])).toThrow(/requires a value/);
    expect(() => parseMigrateCliArgs(['--database-url', URL, '--backup', '--maintenance'])).toThrow(/requires a value/);
  });
  it('--overwrite-backup is REMOVED (v7): rejected with the removal message', () => {
    expect(() => parseMigrateCliArgs(['--database-url', URL, '--backup', '/tmp/b.jsonl', '--overwrite-backup']))
      .toThrow(/REMOVED in v7/);
  });
  it('REJECTS duplicate singleton flags (no last-wins)', () => {
    expect(() => parseMigrateCliArgs(['--database-url', URL, '--database-url', URL, '--backup', '/tmp/b.jsonl'])).toThrow(/duplicate flag: --database-url/);
    expect(() => parseMigrateCliArgs(['--database-url', URL, '--backup', '/tmp/a.jsonl', '--backup', '/tmp/b.jsonl'])).toThrow(/duplicate flag: --backup/);
    expect(() => parseMigrateCliArgs(['--database-url', URL, '--backup', '/tmp/b.jsonl', '--restore', '/tmp/o.jsonl', '--restore', '/tmp/p.jsonl'])).toThrow(/duplicate flag: --restore/);
    expect(() => parseMigrateCliArgs(['--database-url', URL, '--backup', '/tmp/b.jsonl', '--maintenance', '--maintenance'])).toThrow(/duplicate flag: --maintenance/);
  });
  it('every rejection carries exit code 64', () => {
    try { parseMigrateCliArgs([]); expect.unreachable(); }
    catch (e) { expect((e as CliUsageError).exitCode).toBe(64); }
  });
});
