#!/usr/bin/env node
/** Reversible users-phone migration CLI (QA 21:06, v5 2026-09-18).
 *  Grammar (CLOSED flag set, see src/services/phone-migration-cli-args.ts):
 *    --database-url <url>    REQUIRED, resolved-DB-only (no default/env)
 *    --backup <file>         authenticated backup (v2 artifact: per-row
 *                            canonical digests + manifest + HMAC-SHA256)
 *    --restore <file>        full restore in ONE locked transaction;
 *                            artifact verified (digests, manifest, MAC,
 *                            keyId, env) BEFORE any mutation
 *    --maintenance           the ONLY mutating migration path: advisory
 *                            lock + LOCK TABLE users SHARE ROW EXCLUSIVE,
 *                            preflight -> normalize -> rerun -> canonical
 *                            index -> final preflight; all-or-nothing
 *    --overwrite-backup      allow replacing an existing --backup file
 *  ONE DOCUMENTED LOCK ORDER for backup/restore/maintenance: advisory
 *  FIRST, then table lock. Backup additionally runs REPEATABLE READ.
 *  DURABLE PUBLICATION: backups are temp-written with 0600 permissions,
 *  fsynced, atomically renamed, then independently read back and fully
 *  re-validated (structure + digests + manifest + MAC) before success is
 *  reported. A failed backup leaves NO final file.
 *  KEY CUSTODY (managed-secrets only, coordinated with vault rules):
 *  the artifact MAC key comes ONLY from the environment secret store:
 *    CONTAKE_BACKUP_MAC_KEY   (hex or utf8 secret; REQUIRED for all paths)
 *    CONTAKE_BACKUP_KEY_ID    (key VERSION id, e.g. bkp-2026-09-v1)
 *    CONTAKE_BACKUP_ENV       (environment/domain binding, e.g. production)
 *  NEVER committed, NEVER passed via argv, NEVER stored in the artifact.
 *  OPERATOR GATES (carried; NO live action without them):
 *  1. approved read-only live preflight; 2. explicit operator decision per
 *  collision/inconsistency group; 3. verified backup + SCRATCH restore
 *  rehearsal; 4. approved atomic migration window WITH APPLICATION-WRITE
 *  QUIESCENCE (maintenance mode or writers scaled down); 5. idempotent
 *  post-migration verification. Requires a prior build. */
import { open, rename, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { backupUsers, migrateUsersPhone, restoreUsers, validateBackupArtifact } from '../dist/services/phone-migration.js';
import { parseMigrateCliArgs } from '../dist/services/phone-migration-cli-args.js';

let args;
try {
  args = parseMigrateCliArgs(process.argv.slice(2));
} catch (e) {
  console.error(`FATAL: ${e.message}`);
  process.exit(e.exitCode ?? 64);
}
const key = process.env['CONTAKE_BACKUP_MAC_KEY'];
const keyId = process.env['CONTAKE_BACKUP_KEY_ID'];
const env = process.env['CONTAKE_BACKUP_ENV'];
if (!key || !keyId || !env) {
  console.error('FATAL: artifact MAC credentials missing. Provision CONTAKE_BACKUP_MAC_KEY + CONTAKE_BACKUP_KEY_ID + CONTAKE_BACKUP_ENV from the managed secret store (vault/secret-manager env). NEVER commit, NEVER pass via argv, NEVER store in the artifact.');
  process.exit(64);
}
const auth = { key, keyId, env };

/** Durable publication: temp-write 0600, fsync, atomic rename, then
 *  INDEPENDENT readback validation before success is reported. */
const publishBackup = async (file, lines, overwrite) => {
  const tmp = `${file}.tmp-${process.pid}`;
  let fh;
  try {
    fh = await open(tmp, 'wx', 0o600);
  } catch (e) {
    if (e && e.code === 'EEXIST') throw new Error(`backup temp file already exists: ${tmp} (remove it or retry)`);
    throw e;
  }
  try {
    await fh.writeFile(lines.join('\n') + '\n', 'utf8');
    await fh.sync(); // flush/fsync where supported
  } finally {
    await fh.close();
  }
  if (!overwrite) {
    try {
      await rename(tmp, file); // atomic; fails below if target exists
    } catch (e) { throw e; }
  } else {
    await rename(tmp, file);
  }
  // independent readback validation BEFORE complete
  const back = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  const v = validateBackupArtifact(back, auth);
  return v.header.rowCount;
};
const exists = async (f) => { try { await readFile(f); return true; } catch { return false; } };

const pool = new Pool({ connectionString: args.databaseUrl });
try {
  if (args.backup) {
    if (!args.overwriteBackup && await exists(args.backup)) {
      console.error(`FATAL: backup file already exists: ${args.backup} (pass --overwrite-backup to replace it deliberately)`);
      process.exit(64);
    }
    const lines = [];
    await backupUsers(pool, (l) => lines.push(l), { auth });
    const n = await publishBackup(args.backup, lines, args.overwriteBackup);
    console.log(`backup: ${n} users rows + index state + manifest + MAC -> ${args.backup} (0600, fsync, atomic rename, readback verified)`);
  }
  if (args.restore) {
    const r = await restoreUsers(pool, (await readFile(args.restore, 'utf8')).split('\n').filter(Boolean), auth);
    console.log(`restore: ${r.restoredRows} rows written back; post-backup rows removed explicitly: [${r.removedPostBackupRows.join(', ')}]; index recreated=${r.indexRestored} (canonical statement only); verified=${r.verified}`);
  }
  if (args.maintenance) {
    const r = await migrateUsersPhone(pool);
    if (!r.migrated) {
      console.error(`maintenance: ABORTED - preflight blocking under lock: ${r.preflight.blockingReasons.join('; ')}`);
      console.error(JSON.stringify({ collisionGroups: r.preflight.collisionGroups, inconsistentRows: r.preflight.inconsistentRows }, null, 2));
      console.error('Nothing written. Smallest explicit operator decision required.');
      process.exit(2);
    }
    console.log(`maintenance: migrated under advisory + table lock - normalized=${r.normalized}; index present=${r.indexPresent}; final preflight clean=${!r.finalPreflight.blocking}`);
  }
} finally { await pool.end(); }
