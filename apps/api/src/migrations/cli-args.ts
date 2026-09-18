/** Closed CLI argument contract (independent security, 2026-09-18):
 *  - KNOWN flags only; unknown, duplicate, or bare positional arguments are
 *    rejected; missing required flags are rejected;
 *  - ONE deliberate URL source: --database-url XOR DATABASE_URL env; both set
 *    is an error (the operator must choose deliberately);
 *  - bounded/canonical scalar values (actor, output path). */

import { closeSync, constants, fsyncSync, openSync, writeSync } from 'node:fs';

export interface CliSpec {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

export function parseCliArgs(argv: readonly string[], spec: CliSpec): Record<string, string> {
  const known = new Set([...spec.required, ...spec.optional]);
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      throw new Error(`cli: bare positional argument ${JSON.stringify(a)} is not accepted - use explicit --flag value pairs`);
    }
    if (!known.has(a)) {
      throw new Error(`cli: unknown flag ${JSON.stringify(a)} - accepted flags: ${[...known].join(', ')}`);
    }
    if (out[a] !== undefined) {
      throw new Error(`cli: duplicate flag ${JSON.stringify(a)}`);
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      throw new Error(`cli: flag ${JSON.stringify(a)} requires a value`);
    }
    out[a] = v;
    i += 1;
  }
  for (const r of spec.required) {
    if (out[r] === undefined) throw new Error(`cli: required flag ${JSON.stringify(r)} is missing`);
  }
  return out;
}

/** Exactly one deliberate URL source: flag XOR env. */
export function resolveDatabaseUrl(flagValue: string | undefined, envValue: string | undefined): string {
  if (flagValue && envValue) {
    throw new Error('cli: DATABASE_URL is set BOTH as --database-url and in the environment - choose ONE deliberate source');
  }
  const url = flagValue ?? envValue;
  if (!url) throw new Error('cli: DATABASE_URL is required (exactly one of --database-url or the DATABASE_URL env var)');
  return url;
}

const ACTOR = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Bounded/canonical actor label. */
export function validateActor(actor: string): string {
  if (!ACTOR.test(actor)) throw new Error(`cli: invalid --by actor ${JSON.stringify(actor)} (expected ${ACTOR})`);
  return actor;
}

/** Output path: must not clobber an existing file. */
/** Atomic inventory publication (independent QA + security): ONE exclusive
 *  create - O_CREAT|O_EXCL atomically refuses an existing path (no
 *  check-then-write race), O_NOFOLLOW refuses symlinks, mode 0600, and the
 *  contents are fsync'd before close so a crash cannot leave a torn file
 *  that looks published. There is no window in which a second writer can win. */
export function writeFileExclusive(path: string, contents: string): void {
  if (path.length === 0 || path.length > 512 || path.includes('\0')) {
    throw new Error('cli: invalid output path');
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ELOOP') {
      throw new Error(`cli: output path ${JSON.stringify(path)} already exists or is a symlink - refusing to clobber (atomic exclusive create)`);
    }
    throw new Error(`cli: cannot publish inventory at ${JSON.stringify(path)}: ${code ?? String(e)}`);
  }
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
