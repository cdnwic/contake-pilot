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
 *    (v7: --overwrite-backup REMOVED - publication is no-clobber only;
    replace an artifact by removing the old file after operator approval)
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
import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { Pool } from 'pg';
import { backupUsers, migrateUsersPhone, parseBackupEnv, parseBackupKeyId, parseBackupMacKey, parseDeploymentTuples, restoreUsers, validateBackupArtifact } from '../dist/services/phone-migration.js';
import { publishBackupFile } from '../dist/services/backup-publisher.js';
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
  console.error('FATAL: artifact MAC credentials missing. Provision CONTAKE_BACKUP_MAC_KEY (64 lowercase hex, 32 bytes - generate via scripts/users-phone-backup-keygen.mjs) + CONTAKE_BACKUP_KEY_ID + CONTAKE_BACKUP_ENV from the managed secret store (vault/secret-manager env). NEVER commit, NEVER pass via argv, NEVER store in the artifact, NEVER log.');
  process.exit(64);
}
let auth;
let allowed;
try {
  auth = { key, keyId: parseBackupKeyId(keyId), env: parseBackupEnv(env) };
  parseBackupMacKey(key); // canonical + strength; errors name the CLASS only, never the value
  // AUTHORITATIVE ACTUAL-DB binding (v8): approved (deployment ID, ACTUAL
  // database identity, key versions) tuples from the managed secret store.
  // The database identity is resolved LIVE from the connection under lock
  // inside the service - never trusted from here. Ambiguous config (one
  // env ID bound twice) and shared config (one DB bound to two env IDs)
  // are rejected at parse time.
  allowed = parseDeploymentTuples(JSON.parse(process.env['CONTAKE_BACKUP_ALLOWED_TUPLES'] ?? '[]'));
} catch (e) {
  console.error(`FATAL: artifact MAC credentials invalid: ${e.message}`);
  process.exit(64);
}


// PATH CANONICALIZATION (security 2026-09-18 v7): compare ACTUAL identity,
// not strings - relative aliases, symlinks and hard links must not let a
// backup publication target collide with a restore input. (Publication is
// no-clobber via atomic link, which is itself the TOCTOU guard.)
if (args.backup) args.backup = resolvePath(args.backup);
if (args.restore) {
  args.restore = resolvePath(args.restore);
  const st = await lstat(args.restore).catch(() => undefined);
  if (!st || !st.isFile() || st.isSymbolicLink()) {
    console.error(`FATAL: --restore input must be an existing regular file, not a symlink/alias: ${args.restore}`);
    process.exit(64);
  }
  const realRestore = await realpath(args.restore);
  if (args.backup && resolvePath(args.backup) === realRestore) {
    console.error('FATAL: --backup and --restore resolve to the SAME actual file (alias/hard-link/relative) - refused');
    process.exit(64);
  }
  // HARD-LINK identity (security v8): compare device/inode, not strings -
  // a hard-linked --backup target IS the restore input even when paths differ.
  if (args.backup) {
    const sb = await lstat(args.backup).catch(() => undefined);
    if (sb && sb.dev === st.dev && sb.ino === st.ino) {
      console.error('FATAL: --backup and --restore are the SAME inode (hard link) - refused');
      process.exit(64);
    }
  }
}

const pool = new Pool({ connectionString: args.databaseUrl });
try {
  if (args.backup) {
    const lines = [];
    await backupUsers(pool, (l) => lines.push(l), { auth, allowed });
    let n;
    try {
      n = await publishBackupFile(args.backup, lines, { auth });
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        console.error(`FATAL: backup file already exists (no-clobber): ${args.backup} (v7: overwrite support removed - remove the old artifact manually after operator approval, then publish fresh)`);
        process.exit(64);
      }
      throw e;
    }
    const head = JSON.parse(lines[0]);
    console.log(`backup: ${n} users rows + index state + manifest + MAC -> ${args.backup} (0600, fsync, atomic no-clobber link, temp validated + readback verified, dir fsynced); backupId=${head.backupId}`);
  }
  if (args.restore) {
    const artifactLines = (await readFile(args.restore, 'utf8')).split('\n').filter(Boolean);
    // AUTHENTICATE BEFORE ANY OUTPUT (QA v8): nothing from the artifact
    // is printed until structure + MAC have verified; every printed field
    // is a strict printable canonical value (128-bit backupId, canonical
    // createdAt, bounded keyId/env) - raw untrusted bytes are never echoed.
    const v = validateBackupArtifact(artifactLines, auth);
    console.log(`restore: applying backupId=${v.header.backupId} createdAt=${v.header.createdAt} env=${v.header.env} keyId=${v.header.keyId}`);
    console.error('MANDATORY OPERATOR GATE: replay/freshness is NOT mechanically prevented - a human operator MUST have approved THIS backupId for THIS deployment/database before this restore runs.');
    const r = await restoreUsers(pool, artifactLines, auth, { allowed });
    console.log(`restore: ${r.restoredRows} rows written back; post-backup rows removed explicitly: [${r.removedPostBackupRows.join(', ')}]; index recreated=${r.indexRestored} (canonical statement only); verified=${r.verified}`);
  }
  if (args.maintenance) {
    const r = await migrateUsersPhone(pool, { auth, allowed });
    if (!r.migrated) {
      console.error(`maintenance: ABORTED - preflight blocking under lock: ${r.preflight.blockingReasons.join('; ')}`);
      console.error(JSON.stringify({ collisionGroups: r.preflight.collisionGroups, inconsistentRows: r.preflight.inconsistentRows }, null, 2));
      console.error('Nothing written. Smallest explicit operator decision required.');
      process.exit(2);
    }
    console.log(`maintenance: migrated under advisory + table lock - normalized=${r.normalized}; index present=${r.indexPresent}; final preflight clean=${!r.finalPreflight.blocking}`);
  }
} catch (e) {
  if (e && /artifact auth:|deployment tuples:/.test(String(e.message))) {
    console.error(`FATAL: authoritative gate refused: ${e.message}`);
    process.exit(64);
  }
  throw e;
} finally { await pool.end(); }
