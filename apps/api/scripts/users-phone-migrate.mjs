#!/usr/bin/env node
/** Reversible users-phone migration (QA 21:06, v4 2026-09-18).
 *  Steps (explicit flags, in this recommended order):
 *    --backup <file>      dump ALL users rows + index state (JSONL):
 *                         header v2 first line (index EXISTENCE + evidence
 *                         definition + manifestSha256 binding header/index/
 *                         ordered row set), then one row per line with
 *                         rowSha256 over the canonical full row
 *                         (user_id,org_id,email,phone,data)
 *    --restore <file>     FULL restore in ONE transaction: validate the
 *                         artifact FIRST (header, rowCount, unique ids,
 *                         per-row full-row digests, manifest digest,
 *                         closed-schema index evidence), LOCK TABLE users
 *                         IN SHARE ROW EXCLUSIVE MODE, drop the current
 *                         index, write back every backup row, DELETE +
 *                         report post-backup rows, recreate the ONE
 *                         hardcoded canonical index statement (artifact
 *                         SQL is NEVER executed), then verify exact
 *                         count/ids/columns/full-row digests/canonical
 *                         index - any mismatch ROLLS BACK everything
 *    --maintenance        the ONLY mutating migration path (v4 closure of
 *                         the split --normalize/--create-index paths):
 *                         pg_advisory_xact_lock + LOCK TABLE users IN
 *                         SHARE ROW EXCLUSIVE MODE -> preflight under
 *                         lock -> normalize -> preflight rerun under lock
 *                         -> canonical CREATE INDEX -> final preflight +
 *                         canonical index probe; all-or-nothing; REFUSES
 *                         when preflight blocks
 *  REMOVED FLAGS: --normalize and --create-index now exit 64. Mutations
 *  go through --maintenance only. Standalone preflight stays READ-ONLY in
 *  scripts/users-phone-preflight.mjs.
 *  Resolved-DB-only: REQUIRES --database-url (no default, no ambient env).
 *  Mutating steps REFUSE to run without --backup in the SAME invocation.
 *  Idempotent: safe to re-run. Requires a prior build.
 *  OPERATOR GATES (carried, no live action without them):
 *  1. approved read-only live preflight; 2. explicit operator decision per
 *  collision/inconsistency group; 3. verified backup + SCRATCH restore
 *  rehearsal; 4. approved atomic migration window WITH APPLICATION-WRITE
 *  QUIESCENCE (maintenance mode or writers scaled down): the table lock
 *  blocks writers only for the transaction's duration - a long queue of
 *  blocked writers is itself an incident; 5. idempotent post-migration
 *  verification. */
import { readFileSync, writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { backupUsers, migrateUsersPhone, restoreUsers } from '../dist/services/phone-migration.js';

const arg = (name) => { const i = process.argv.indexOf(name); return i === -1 ? undefined : process.argv[i + 1]; };
const has = (name) => process.argv.includes(name);
if (has('--normalize') || has('--create-index')) {
  console.error('FATAL: --normalize/--create-index were REMOVED in v4 (split mutating paths closed). Mutations go through --maintenance only (single locked primitive); standalone preflight stays read-only in users-phone-preflight.mjs.');
  process.exit(64);
}
const url = arg('--database-url');
if (!url) {
  console.error('FATAL: explicit --database-url is required (resolved-DB-only; no default, no ambient env).');
  process.exit(64);
}
const backupFile = arg('--backup');
if ((has('--restore') || has('--maintenance')) && !backupFile) {
  console.error('FATAL: --restore/--maintenance require --backup <file> in the SAME invocation (reversible-by-construction).');
  process.exit(64);
}
const pool = new Pool({ connectionString: url });
try {
  if (backupFile) {
    const lines = [];
    const n = await backupUsers(pool, (l) => lines.push(l));
    writeFileSync(backupFile, lines.join('\n') + '\n');
    console.log(`backup: ${n} users rows + index state + manifest -> ${backupFile}`);
  }
  if (has('--restore')) {
    const restoreFile = arg('--restore');
    const r = await restoreUsers(pool, readFileSync(restoreFile, 'utf8').split('\n').filter(Boolean));
    console.log(`restore: ${r.restoredRows} rows written back; post-backup rows removed explicitly: [${r.removedPostBackupRows.join(', ')}]; index recreated=${r.indexRestored} (canonical statement only); verified=${r.verified}`);
  }
  if (has('--maintenance')) {
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
