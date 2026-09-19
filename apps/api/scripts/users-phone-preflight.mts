#!/usr/bin/env node
/** Users-phone preflight ISSUANCE (SA2 + SA3, attended-TOFU companion): the
 *  ONLY path that mints an operator ack. Runs the runner's CANONICAL
 *  preflight implementation under the runner session lock and PERSISTS the
 *  issued nonce bound to target + deployment + plan + listDigest (SA3 s4) -
 *  a wrapper can never substitute a different list, and an ack constructed
 *  without this persisted record is refused by the runner.
 *  - Mutates ONLY runner-owned bookkeeping (the issuance + evidence records);
 *    application data is never touched: no winner picked, nothing deleted.
 *  - Resolved-DB-only: REQUIRES explicit --database-url and --deployment.
 *  - Refuses while the target is DIRTY/INDETERMINATE (attended resolution first).
 *  Usage: npx tsx scripts/users-phone-preflight.mts --database-url postgres://... --deployment staging
 *  Exit 0 always; operatorDecisionRequired flags what needs human judgment. */
import { Pool } from 'pg';
import { issueOperatorPreflight, operatorAckFor } from '../src/migrations/runner.js';

const arg = (name: string) => process.argv.find((a, i) => i > 0 && process.argv[i - 1] === name);
const url = arg('--database-url');
const deployment = arg('--deployment') ?? 'staging';
if (!url) {
  console.error('FATAL: explicit --database-url is required (resolved-DB-only; no default, no ambient env).');
  process.exit(64);
}
const pool = new Pool({ connectionString: url });
try {
  const pf = await issueOperatorPreflight(pool, { deployment });
  const report = {
    tool: 'users-phone-preflight', issuancePersisted: true, generatedAt: new Date().toISOString(),
    target: pf.target, deployment: pf.deployment,
    plan: pf.plan, nonce: pf.nonce,
    collisionGroups: pf.collisionGroups,
    crossRepresentationInconsistencies: pf.crossRepresentationInconsistencies,
    blankPhoneUsers: pf.blankPhoneUsers,
    operatorDecisionRequired: pf.collisionGroups.length > 0 || pf.crossRepresentationInconsistencies.length > 0,
    listDigest: pf.listDigest,
    requiredAck: operatorAckFor(pf),
    notes: 'blank phones normalize to NULL at 0002 (absence, not identity); real-phone collisions BLOCK loudly; cross-representation inconsistencies are operator judgment. The ack is a PERSISTED issuance bound to THIS target + plan + CURRENT state, single-use: the runner recomputes under lock, consumes it atomically with the gated plan, and invalidates it on any abort.',
  };
  console.log(JSON.stringify(report, null, 2));
  console.error(`PREFLIGHT: ${pf.collisionGroups.length} collision group(s), ${pf.crossRepresentationInconsistencies.length} cross-representation inconsistency(ies), ${pf.blankPhoneUsers.length} blank phone(s). listDigest=${pf.listDigest}`);
  console.error(`PREFLIGHT: execute with --ack ${operatorAckFor(pf)} (issued nonce ${pf.nonce}; binds target ${pf.target}, current state only, single-use).`);
} finally { await pool.end(); }
