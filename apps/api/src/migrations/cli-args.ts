/** Closed CLI argument contract (independent security, 2026-09-18):
 *  - KNOWN flags only; unknown, duplicate, or bare positional arguments are
 *    rejected; missing required flags are rejected;
 *  - ONE deliberate URL source: --database-url XOR DATABASE_URL env; both set
 *    is an error (the operator must choose deliberately);
 *  - bounded/canonical scalar values (actor, output path). */

import { closeSync, constants, fsyncSync, linkSync, openSync, readdirSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export interface CliSpec {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

export function parseCliArgs(argv: readonly string[], spec: CliSpec): Record<string, string> {
  const known = new Set([...spec.required, ...spec.optional]);
  const out: Record<string, string> = {};
  // Package-runner separator: `pnpm run <script> -- <args>` delivers a
  // literal leading '--' token (npm strips it; pnpm 9 passes it through to
  // the script). Skip exactly ONE leading separator so the documented
  // invocation works on both runners; any OTHER '--' stays an unknown
  // flag / bare positional and refuses like before.
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (!a.startsWith('--')) {
      throw new Error(`cli: bare positional argument ${JSON.stringify(a)} is not accepted - use explicit --flag value pairs`);
    }
    if (!known.has(a)) {
      throw new Error(`cli: unknown flag ${JSON.stringify(a)} - accepted flags: ${[...known].join(', ')}`);
    }
    if (out[a] !== undefined) {
      throw new Error(`cli: duplicate flag ${JSON.stringify(a)}`);
    }
    const v = args[i + 1];
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
/** Durable atomic inventory publication (independent QA + security):
 *  1. INDETERMINATE-STATE RECONCILIATION: a leftover temp file from a previous
 *     attempt means cleanup was interrupted - refuse and name the file for
 *     explicit operator reconciliation instead of guessing.
 *  2. FULL-WRITE LOOP to a same-directory temp (writeSync until every byte is
 *     out), fsync the temp, close it.
 *  3. ATOMIC NO-CLOBBER PUBLISH: hard-link(2) the temp onto the final path -
 *     atomic, and EEXIST (existing file OR symlink) refuses to clobber.
 *  4. fsync the DIRECTORY so the new directory entry is durable.
 *  5. Temp cleanup failure is reported explicitly (published, but reconcile
 *     the leftover temp), never silently swallowed. */
export function durablePublish(path: string, contents: string): void {
  if (path.length === 0 || path.length > 512 || path.includes('\0')) {
    throw new Error('cli: invalid output path');
  }
  const dir = dirname(path);
  const base = basename(path);
  const leftovers = readdirSync(dir).filter(f => f.startsWith(`${base}.contake-tmp-`));
  if (leftovers.length > 0) {
    throw new Error(
      `cli: indeterminate prior publication state at ${JSON.stringify(path)} - leftover temp file(s): ${leftovers.join(', ')}. ` +
      `Reconcile explicitly (inspect and remove) before publishing again; refusing to guess.`,
    );
  }
  const tmp = join(dir, `${base}.contake-tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const buf = Buffer.from(contents, 'utf8');
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path);
  } catch (e) {
    unlinkSync(tmp);
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ELOOP') {
      throw new Error(`cli: output path ${JSON.stringify(path)} already exists or is a symlink - refusing to clobber (atomic no-clobber publish)`);
    }
    throw new Error(`cli: cannot publish inventory at ${JSON.stringify(path)}: ${code ?? String(e)}`);
  }
  const dirFsync = () => {
    const dfd = openSync(dir, constants.O_RDONLY);
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  };
  // Security closure (2026-09-18): every publication failure retains BOTH the
  // original failure (message + cause) AND the exact temp/reconciliation
  // state, so an operator never has to guess what exists on disk.
  try {
    dirFsync();
  } catch (e) {
    throw new Error(
      `cli: inventory linked at ${JSON.stringify(path)} but the directory fsync FAILED - the publication is INDETERMINATE. ` +
      `State: published file EXISTS at ${JSON.stringify(path)} (durability unconfirmed); temp RETAINED at ${JSON.stringify(tmp)}. ` +
      `Reconcile explicitly before relying on either. Original failure: ${String(e)}`,
      { cause: e } as ErrorOptions,
    );
  }
  try {
    unlinkSync(tmp);
  } catch (e) {
    throw new Error(
      `cli: inventory published to ${JSON.stringify(path)} but temp cleanup FAILED. ` +
      `State: published file EXISTS at ${JSON.stringify(path)} (fsynced); temp RETAINED at ${JSON.stringify(tmp)} - reconcile manually. ` +
      `Original failure: ${String(e)}`,
      { cause: e } as ErrorOptions,
    );
  }
  try {
    dirFsync();
  } catch (e) {
    throw new Error(
      `cli: inventory published to ${JSON.stringify(path)} but the post-cleanup directory fsync FAILED. ` +
      `State: published file EXISTS at ${JSON.stringify(path)}; temp REMOVED from ${JSON.stringify(tmp)} (removal durability unconfirmed). ` +
      `Original failure: ${String(e)}`,
      { cause: e } as ErrorOptions,
    );
  }
}
