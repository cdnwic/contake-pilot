#!/usr/bin/env node
/** users-phone FORWARD migration runner (QA 2026-09-18; narrowed SA v8 scope
 *  per TL 2026-09-18): the ONE operationally reachable path over the single
 *  locked migrateUsersPhone primitive, on the RESOLVED database ONLY.
 *  The bespoke backup/restore CLI is DECOUPLED from this gate (architecture
 *  separation 2026-09-18): owned by the separate infra track, preserved in
 *  git history. This runner is forward-only: preflight under lock ->
 *  normalize -> preflight rerun under the same lock -> canonical unique
 *  index -> final preflight + index verification, all-or-nothing.
 *  CLOSED GRAMMAR: exactly `--database-url <url>` (no default, no ambient
 *  env, no other flags). Exit 0 = migrated clean (idempotent rerun ok);
 *  exit 1 = BLOCKED (full fail-loud preflight printed; NOTHING mutated) or
 *  FAILED (rolled back); exit 64 = usage.
 *  Requires a prior build: pnpm --filter @contake/api build.
 *  Usage: node scripts/users-phone-migrate.mjs --database-url postgres://... */
import { Pool } from 'pg';
import { runUsersPhoneMigration } from '../dist/services/phone-migration.js';

const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== '--database-url' || !argv[1] || argv[1].startsWith('--')) {
  console.error('FATAL: usage: node scripts/users-phone-migrate.mjs --database-url postgres://... (explicit resolved DB ONLY - no default, no ambient env; the flag set is CLOSED)');
  process.exit(64);
}
const pool = new Pool({ connectionString: argv[1] });
let outcome;
try {
  outcome = await runUsersPhoneMigration(pool);
} finally { await pool.end(); }
console.log(JSON.stringify(outcome.report, null, 2));
if (outcome.exitCode === 0) {
  console.error(`MIGRATION OK: normalized=${outcome.report.normalized} indexPresent=${outcome.report.indexPresent} (idempotent rerun safe)`);
} else if (outcome.report.error) {
  console.error(`MIGRATION FAILED - transaction ROLLED BACK, nothing applied: ${outcome.report.error}`);
} else {
  const reasons = outcome.report.preflight?.blockingReasons ?? [];
  console.error(`MIGRATION BLOCKED - operator decision required; NOTHING was mutated: ${reasons.join('; ')}`);
}
process.exit(outcome.exitCode);
