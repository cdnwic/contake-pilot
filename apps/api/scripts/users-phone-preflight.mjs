#!/usr/bin/env node
/** READ-ONLY users-phone duplicate preflight (QA 21:06, 2026-09-18).
 *  Groups users by btrim(phone), reports collisions with ids/orgs/hashes/
 *  provenance. NEVER mutates, never picks a winner, never deletes.
 *  Resolved-DB-only: REQUIRES an explicit --database-url (no default, no
 *  ambient env). Requires a prior build: pnpm --filter @contake/api build.
 *  Usage: node scripts/users-phone-preflight.mjs --database-url postgres://...
 *  Exit 0 always; the report's operatorDecisionRequired flags collisions. */
import { Pool } from 'pg';
import { preflightUsersPhone } from '../dist/services/phone-migration.js';

const url = process.argv.find((a, i) => i > 0 && process.argv[i - 1] === '--database-url');
if (!url) {
  console.error('FATAL: explicit --database-url is required (resolved-DB-only; no default, no ambient env).');
  process.exit(64);
}
const pool = new Pool({ connectionString: url });
try {
  const report = await preflightUsersPhone(pool);
  console.log(JSON.stringify(report, null, 2));
  if (report.operatorDecisionRequired) {
    console.error(`PREFLIGHT: ${report.collisionGroups.length} collision group(s) found - smallest operator decision required. No winner picked, nothing deleted, nothing mutated.`);
  } else {
    console.error('PREFLIGHT: no phone collisions.');
  }
} finally { await pool.end(); }
