/** CLI grammar for users-phone-migrate.mjs (security 2026-09-18 v5):
 *  CLOSED flag set - unknown flags are rejected; --restore and
 *  --maintenance are mutually exclusive; --restore requires a DISTINCT
 *  --backup path; mutating steps require --backup in the same invocation;
 *  existing backup files require explicit --overwrite-backup.
 *  Pure parser: unit-tested in ALL lanes, imported by the mjs wrapper.
 *  The MAC key is NEVER part of argv (managed-secrets env only). */
export class CliUsageError extends Error {
  readonly exitCode = 64;
}

export interface MigrateCliArgs {
  databaseUrl: string;
  backup?: string;
  restore?: string;
  maintenance: boolean;
}

const VALUE_FLAGS = new Set(['--database-url', '--backup', '--restore']);
const BOOL_FLAGS = new Set(['--maintenance']);
const REMOVED_FLAGS = new Set(['--normalize', '--create-index', '--overwrite-backup']);

export function parseMigrateCliArgs(argv: string[]): MigrateCliArgs {
  const out: { databaseUrl?: string; backup?: string; restore?: string; maintenance: boolean } =
    { maintenance: false };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (REMOVED_FLAGS.has(a)) {
      if (a === '--overwrite-backup') {
        throw new CliUsageError(`${a} was REMOVED in v7 (overwrite support removed entirely - no indeterminate post-fsync/rollback states). No-clobber is sufficient: remove an old artifact manually after operator approval, then publish fresh.`);
      }
      throw new CliUsageError(`${a} was REMOVED in v4 (split mutating paths closed). Mutations go through --maintenance only.`);
    }
    if (VALUE_FLAGS.has(a)) {
      if (seen.has(a)) throw new CliUsageError(`duplicate flag: ${a} (singleton flags may appear at most once)`);
      seen.add(a);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new CliUsageError(`${a} requires a value`);
      if (a === '--database-url') out.databaseUrl = v;
      else if (a === '--backup') out.backup = v;
      else out.restore = v;
      i++;
      continue;
    }
    if (BOOL_FLAGS.has(a)) {
      if (seen.has(a)) throw new CliUsageError(`duplicate flag: ${a} (singleton flags may appear at most once)`);
      seen.add(a);
      out.maintenance = true;
      continue;
    }
    throw new CliUsageError(`unknown flag or argument: ${a}`);
  }
  if (!out.databaseUrl) throw new CliUsageError('explicit --database-url is required (resolved-DB-only; no default, no ambient env)');
  if (out.restore !== undefined && out.maintenance) throw new CliUsageError('--restore and --maintenance are mutually exclusive (ambiguous intent)');
  if ((out.restore !== undefined || out.maintenance) && out.backup === undefined) {
    throw new CliUsageError('--restore/--maintenance require --backup <file> in the SAME invocation (reversible-by-construction)');
  }
  if (out.backup !== undefined && out.restore !== undefined && out.backup === out.restore) {
    throw new CliUsageError('--backup and --restore paths must be DISTINCT (never clobber the artifact you are restoring from)');
  }
  if (!out.backup && !out.restore && !out.maintenance) {
    throw new CliUsageError('nothing to do: pass --backup, --restore (with --backup), or --maintenance (with --backup)');
  }
  return out as MigrateCliArgs;
}
