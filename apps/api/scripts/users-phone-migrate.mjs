#!/usr/bin/env node
/** Reversible users-phone migration (QA 21:06, 2026-09-18).
 *  Steps (explicit flags, in this recommended order):
 *    --backup <file>      dump ALL users rows (JSONL + per-row sha256)
 *    --normalize          btrim existing phone column + embedded JSON phone
 *    --create-index       preflight first; ABORTS LOUDLY on collisions
 *    --restore <file>     write backed-up rows back (reverses a migration)
 *  Resolved-DB-only: REQUIRES --database-url (no default, no ambient env).
 *  Mutating steps REFUSE to run without --backup having completed in the
 *  SAME invocation (reversible-by-construction). Idempotent: safe to re-run.
 *  Requires a prior build: pnpm --filter @contake/api build.
 *  Usage: node scripts/users-phone-migrate.mjs --database-url postgres://... --backup /path/users.jsonl --normalize --create-index */
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
    console.log(`backup: ${n} users rows -> ${backupFile}`);
  }
  if (has('--restore')) {
    const restoreFile = arg('--restore');
    const lines = readFileSync(restoreFile, 'utf8').split('\n').filter(Boolean);
    const n = await restoreUsers(pool, lines);
    console.log(`restore: ${n} rows written back from ${restoreFile}`);
  }
  if (has('--normalize')) {
    const r = await normalizeUsersPhones(pool);
    console.log(`normalize: ${r.normalized} row(s) trimmed${r.normalized ? ': ' + r.userIds.join(', ') : ' (idempotent no-op)'}`);
  }
  if (has('--create-index')) {
    const r = await createUsersPhoneIndex(pool);
    if (r.created) {
      console.log('create-index: users_phone_unique created (or already present) on the resolved database');
    } else {
      console.error(`create-index: ABORTED - ${r.preflight.collisionGroups.length} collision group(s). Report:`);
      console.error(JSON.stringify(r.preflight.collisionGroups, null, 2));
      console.error('No index created. No winner picked, nothing deleted, nothing mutated. Smallest operator decision required.');
      process.exit(2);
    }
  }
} finally { await pool.end(); }
