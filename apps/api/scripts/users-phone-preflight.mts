#!/usr/bin/env node
/** READ-ONLY users-phone preflight (SA1+SA2, attended-TOFU companion). Runs
 *  FIRST at attended TOFU; its inconsistency listDigest is what the operator
 *  acknowledges. Uses the runner's CANONICAL preflight implementation - a
 *  wrapper can never substitute a different list.
 *  - NEVER mutates: session forced default_transaction_read_only=on, SELECTs
 *    only; no winner picked, nothing deleted.
 *  - Resolved-DB-only: REQUIRES explicit --database-url and --deployment.
 *  Usage: npx tsx scripts/users-phone-preflight.mts --database-url postgres://... --deployment staging
 *  Exit 0 always; operatorDecisionRequired flags what needs human judgment. */
import { Pool } from 'pg';
import { computeUsersPhonePreflight, operatorAckFor } from '../src/migrations/runner.js';

const arg = (name: string) => process.argv.find((a, i) => i > 0 && process.argv[i - 1] === name);
const url = arg('--database-url');
const deployment = arg('--deployment') ?? 'staging';
if (!url) {
  console.error('FATAL: explicit --database-url is required (resolved-DB-only; no default, no ambient env).');
  process.exit(64);
}
const pool = new Pool({ connectionString: url, options: '-c default_transaction_read_only=on' });
try {
  const pf = await computeUsersPhonePreflight(pool, { deployment });
  const report = {
    tool: 'users-phone-preflight', readOnly: true, generatedAt: new Date().toISOString(),
    target: pf.target, deployment: pf.deployment,
    collisionGroups: pf.collisionGroups,
    crossRepresentationInconsistencies: pf.crossRepresentationInconsistencies,
    blankPhoneUsers: pf.blankPhoneUsers,
    operatorDecisionRequired: pf.collisionGroups.length > 0 || pf.crossRepresentationInconsistencies.length > 0,
    listDigest: pf.listDigest,
    requiredAck: operatorAckFor(pf),
    notes: 'blank phones normalize to NULL at 0002 (absence, not identity); real-phone collisions BLOCK loudly; cross-representation inconsistencies are operator judgment. The ack binds THIS target + CURRENT state; the runner recomputes under lock and refuses absent/wrong/stale/replayed acks.',
  };
  console.log(JSON.stringify(report, null, 2));
  console.error(`PREFLIGHT: ${pf.collisionGroups.length} collision group(s), ${pf.crossRepresentationInconsistencies.length} cross-representation inconsistency(ies), ${pf.blankPhoneUsers.length} blank phone(s). listDigest=${pf.listDigest}`);
  console.error(`PREFLIGHT: execute with --ack ${operatorAckFor(pf)} (binds target ${pf.target}, current state only).`);
} finally { await pool.end(); }
