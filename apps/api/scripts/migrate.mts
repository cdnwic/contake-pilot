#!/usr/bin/env node
/** THE canonical release-migration operator entrypoint (SA2 + SA3 ruling
 *  2026-09-19): EVERY invocation path an operator or script can reach
 *  (package script migrate:release, documented commands, direct invocation)
 *  resolves HERE; the old ungated src/migrations/cli.ts is DELETED.
 *
 *  Flow (attended TOFU, issued-nonce ack lifecycle):
 *    1) ISSUANCE: runs the canonical preflight issuance FIRST - recomputes
 *       the canonical lists under the runner lock, mints + PERSISTS a unique
 *       nonce bound to target + deployment + plan + listDigest (SA3 s4: an
 *       ack exists ONLY as this persisted record), and prints the preflight
 *       plus the exact --ack string for the operator. Exits 75 WITHOUT
 *       executing anything when --ack is absent.
 *    2) EXECUTION (--ack): the RUNNER re-verifies the ack against the
 *       persisted record under the step locks inside the step transaction
 *       (absent-record / wrong-target / plan-mismatch / stale / consumed /
 *       invalidated all fail closed) and consumes it atomically with the
 *       gated plan; any abort invalidates the ack (fresh issuance required).
 *    3) --resolve-dirty '<note>': attended resolution of a DIRTY/
 *       INDETERMINATE target (SA3 s5) - records the append-only resolution
 *       event and unblocks the target.
 *  Usage:
 *    npx tsx scripts/migrate.mts --database-url postgres://... --deployment staging|production
 *        [--ack ack:<nonce>:<listDigest>] [--expect-instance-id <id>] [--expect-registry-digest <digest>]
 *    npx tsx scripts/migrate.mts --database-url postgres://... --deployment staging|production --resolve-dirty '<operator note>'
 */
import { Pool } from 'pg';
import { attendedResolveDirty, issueOperatorPreflight, operatorAckFor, runMigrations, REGISTRY_DIGEST } from '../src/migrations/runner.js';

const arg = (name: string) => process.argv.find((a, i) => i > 0 && process.argv[i - 1] === name);
const url = arg('--database-url');
const deployment = arg('--deployment');
const ack = arg('--ack');
const resolveNote = arg('--resolve-dirty');
if (!url || !deployment || !['staging', 'production'].includes(deployment)) {
  console.error('FATAL: explicit --database-url and --deployment staging|production are required (resolved-target only).');
  process.exit(64);
}
const pool = new Pool({ connectionString: url });
try {
  if (resolveNote !== undefined) {
    await attendedResolveDirty(pool, { note: resolveNote, resolvedBy: 'migrate-cli' });
    console.log(JSON.stringify({ ok: true, dirtyResolved: true }, null, 2));
    process.exit(0);
  }
  // 1) resolved-target preflight ISSUANCE first (operator attends this list;
  //    the nonce record it persists is the only ack that can exist).
  const pf = await issueOperatorPreflight(pool, {
    deployment,
    expectInstanceId: arg('--expect-instance-id'), expectRegistryDigest: arg('--expect-registry-digest'),
  });
  console.log(JSON.stringify({ preflight: pf, registryDigest: REGISTRY_DIGEST }, null, 2));
  const required = operatorAckFor(pf);
  if (!ack) {
    console.error(`GATE: no ack supplied - NOTHING executed (issuance recorded; unused issuances expire by staleness). Review the preflight above, then re-run with --ack ${required}`);
    process.exit(75);
  }
  // 2) the runner enforces the ack against the persisted record, under lock.
  const r = await runMigrations(pool, {
    deployment, appliedBy: 'migrate-cli', operatorAck: ack,
    expectInstanceId: arg('--expect-instance-id'), expectRegistryDigest: arg('--expect-registry-digest'),
  });
  console.log(JSON.stringify({ applied: r.appliedNow, stampedInstance: r.identity.instanceId, stampedNow: r.stampedNow }, null, 2));
} finally { await pool.end(); }
