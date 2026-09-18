#!/usr/bin/env node
/** Reversible users-phone migration (QA 21:06, v2 2026-09-18).
 *  Steps (explicit flags, in this recommended order):
 *    --backup <file>      dump ALL users rows + index state (JSONL, header
 *                         first line, per-row sha256)
 *    --normalize          ONE transaction; btrim column + embedded JSON to
 *                         their own values; REFUSES when preflight blocks
 *    --create-index       preflight first; ABORTS LOUDLY on collisions OR
 *                         column/JSON inconsistencies (exit 2)
 *    --restore <file>     reverse rows AND index state from a backup
 *                         artifact; verified against the backup header
 *  Resolved-DB-only: REQUIRES --database-url (no default, no ambient env).
 *  Mutating steps REFUSE to run without --backup in the SAME invocation.
 *  Idempotent: safe to re-run. Requires a prior build.
 *  OPERATOR GATES (carried, no live action without them):
 *  1. approved read-only live preflight; 2. explicit operator decision per
 *  collision/inconsistency group; 3. verified backup + SCRATCH restore
 *  rehearsal; 4. approved atomic migration window; 5. idempotent
 *  post-migration verification. */
import { readFileSync, writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { backupUsers, createUsersPhoneIndex, normalizeUsersPhones, restoreUsers } from '../dist/services/phone-migration.js';

const arg = (name) => { const i = process.argv.indexOf(name); return i === -1 ? undefined : process.argv[i + 1]; };
const has = (name) => process.argv.includes(name);
const url = arg('--database-url');
if (!url) {
  console.error('FATAL: explicit --database-url is required (resolved-DB-only; no default, no ambient env).');
  process.exit(64);
}
const backupFile = arg('--backup');
if ((has('--normalize') || has('--create-index')) && !backupFile) {
  console.error('FATAL: --normalize/--create-index require --backup <file> in the SAME invocation (reversible-by-construction).');
  process.exit(64);
}
const pool = new Pool({ connectionString: url });
try {
  if (backupFile) {
    const lines = [];
    const n = await backupUsers(pool, (l) => lines.push(l));
    writeFileSync(backupFile, lines.join('\n') + '\n');
    console.log(`backup: ${n} users rows + index state -> ${backupFile}`);
  }
  if (has('--restore')) {
    const restoreFile = arg('--restore');
    const r = await restoreUsers(pool, readFileSync(restoreFile, 'utf8').split('\n').filter(Boolean));
    console.log(`restore: ${r.restoredRows} rows written back; index state reversed (recreated=${r.indexRestored}); verified=${r.verified}`);
  }
  if (has('--normalize')) {
    const r = await normalizeUsersPhones(pool);
    if (r.aborted) {
      console.error(`normalize: ABORTED - ${r.reason}. No row touched. Explicit operator decision required.`);
      console.error(JSON.stringify({ collisionGroups: r.preflight.collisionGroups, inconsistentRows: r.preflight.inconsistentRows }, null, 2));
      process.exit(2);
    }
    console.log(`normalize: ${r.normalized} row(s) trimmed in one transaction${r.normalized ? ': ' + r.userIds.join(', ') : ' (idempotent no-op)'}`);
  }
  if (has('--create-index')) {
    const r = await createUsersPhoneIndex(pool);
    if (r.created) {
      console.log('create-index: users_phone_unique created (or already present) on the resolved database');
    } else {
      console.error(`create-index: ABORTED - preflight blocking: ${r.preflight.blockingReasons.join('; ')}`);
      console.error(JSON.stringify({ collisionGroups: r.preflight.collisionGroups, inconsistentRows: r.preflight.inconsistentRows }, null, 2));
      console.error('No index created. No winner picked, nothing deleted, nothing mutated. Smallest explicit operator decision required.');
      process.exit(2);
    }
  }
} finally { await pool.end(); }
