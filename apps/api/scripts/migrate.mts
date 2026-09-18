#!/usr/bin/env node
/** REAL migration operator entrypoint (SA2). The attended-TOFU gate is a
 *  precondition of the RUNNER, not of this wrapper: this CLI runs the
 *  canonical read-only preflight FIRST (displayed to the operator), then calls
 *  runMigrations with the operator's ack; the runner RECOMPUTES the preflight
 *  under the step locks inside the step transaction and refuses any
 *  absent/wrong/stale/replayed ack (fail closed, full rollback).
 *  Usage:
 *    npx tsx scripts/migrate.mts --database-url postgres://... --deployment staging [--ack ack:<listDigest>]
 *  Without --ack: prints the preflight + required ack and exits 75 WITHOUT
 *  executing anything. --expect-instance-id / --expect-registry-digest pass
 *  through to the runner's target binding. */
import { Pool } from 'pg';
import { computeUsersPhonePreflight, operatorAckFor, runMigrations, REGISTRY_DIGEST } from '../src/migrations/runner.js';

const arg = (name: string) => process.argv.find((a, i) => i > 0 && process.argv[i - 1] === name);
const url = arg('--database-url');
const deployment = arg('--deployment');
const ack = arg('--ack');
if (!url || !deployment || !['staging', 'production'].includes(deployment)) {
  console.error('FATAL: explicit --database-url and --deployment staging|production are required (resolved-target only).');
  process.exit(64);
}
const pool = new Pool({ connectionString: url });
try {
  // 1) resolved-target preflight FIRST (operator attends this list).
  const pf = await computeUsersPhonePreflight(pool, { deployment });
  console.log(JSON.stringify({ preflight: pf, registryDigest: REGISTRY_DIGEST }, null, 2));
  const required = operatorAckFor(pf);
  if (!ack) {
    console.error(`GATE: no ack supplied - NOTHING executed. Review the preflight above, then re-run with --ack ${required}`);
    process.exit(75);
  }
  // 2) the runner enforces the ack against a fresh in-transaction recompute.
  const r = await runMigrations(pool, {
    deployment, appliedBy: 'migrate-cli', operatorAck: ack,
    expectInstanceId: arg('--expect-instance-id'), expectRegistryDigest: arg('--expect-registry-digest'),
  });
  console.log(JSON.stringify({ applied: r.appliedNow, stampedInstance: r.instanceId }, null, 2));
} finally { await pool.end(); }
