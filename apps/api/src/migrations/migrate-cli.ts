/** THE canonical release-migration operator entrypoint (SA2 + SA3 + SA4
 *  ruling 2026-09-19): the BUILT artifact (dist/migrations/migrate-cli.js)
 *  is the only invocation on the release path; the package script
 *  migrate:release invokes `node dist/migrations/migrate-cli.js`. No
 *  tsx/ts-node/source invocation remains anywhere on the release path.
 *
 *  CONTROL CARRYOVER (SA4 section 3, explicit diff vs the deleted
 *  src/migrations/cli.ts predecessor and the scripts/migrate.mts rewrite):
 *  every predecessor control is carried forward and verified in lane:
 *   1. closed parser: unknown/duplicate/bare/missing flags rejected
 *      (parseCliArgs, cli-args.ts);
 *   2. ONE deliberate URL source: --database-url XOR DATABASE_URL env
 *      (resolveDatabaseUrl);
 *   3. bounded actor label (validateActor);
 *   4. direct-endpoint assertion: pooled/proxied ('-pooler') endpoints
 *      refused BEFORE any connection (assertDirectDatabaseUrl);
 *   5. OPERATOR EXPECTED TUPLE: --expect-host/--expect-db REQUIRED; the
 *      URL-resolved host/db must match BEFORE any connection (exit 2);
 *   6. CONNECTED-TUPLE verification: current_database() must equal
 *      --expect-db AFTER connecting, BEFORE any issuance or DDL;
 *   7. pre-mutation target binding: stamped deployment + optional
 *      --expect-instance-id/--expect-registry-digest verified READ-ONLY
 *      (verifyTargetPreconditions, and again inside issuance/run);
 *   8. deployment allowlist staging|production (SA2/SA3 scripts);
 *   9. issued-nonce ack lifecycle (SA3): issuance FIRST (unique persisted
 *      nonce bound to target+deployment+plan+listDigest); exit 75 without
 *      --ack; the runner re-verifies/consumes under lock, invalidates on
 *      abort (SA4: DIRTY claims require verified marker persistence);
 *  10. --resolve-dirty attended resolution (SA3);
 *  11. DATABASE_URL is never printed; zero seeding; forward-only.
 *
 *  Usage:
 *    pnpm --filter @contake/api migrate:release -- \
 *      --deployment staging --expect-host <host> --expect-db <db> \
 *      [--database-url <url>] [--by <actor>] [--ack ack:<nonce>:<listDigest>] \
 *      [--expect-instance-id <id>] [--expect-registry-digest <digest>]
 *    pnpm --filter @contake/api migrate:release -- \
 *      --deployment staging --expect-host <host> --expect-db <db> \
 *      --resolve-dirty '<operator note>'
 */
import { parseCliArgs, resolveDatabaseUrl, validateActor } from './cli-args.js';
import {
  assertDirectDatabaseUrl, attendedResolveDirty, issueOperatorPreflight, operatorAckFor,
  REGISTRY_DIGEST, runMigrations, verifyTargetPreconditions,
} from './runner.js';

const args = parseCliArgs(process.argv.slice(2), {
  required: ['--deployment', '--expect-host', '--expect-db'],
  optional: ['--by', '--database-url', '--expect-instance-id', '--expect-registry-digest', '--ack', '--resolve-dirty'],
});
const databaseUrl = resolveDatabaseUrl(args['--database-url'], process.env['DATABASE_URL']);
const appliedBy = validateActor(args['--by'] ?? 'release-job');
const deployment = args['--deployment']!;
if (!['staging', 'production'].includes(deployment)) {
  console.error(`FATAL: --deployment must be staging|production (resolved-target only), got ${JSON.stringify(deployment)}`);
  process.exit(64);
}

// (4)+(5): direct endpoint + operator expected tuple, BEFORE any connection.
const target = assertDirectDatabaseUrl(databaseUrl); // throws on pooled/invalid
if (target.host !== args['--expect-host'] || target.database !== args['--expect-db']) {
  console.error(
    `release-migrations: TARGET TUPLE mismatch - operator expected ${args['--expect-host']}/${args['--expect-db']} ` +
    `but the URL resolves to ${target.host}/${target.database}. Refusing before any connection (fail-closed).`,
  );
  process.exit(2);
}
console.log(`release-migrations: target ${target.host}/${target.database} deployment=${deployment} by=${appliedBy}`);

const { Pool } = await import('pg');
const pool = new Pool({ connectionString: databaseUrl });
try {
  // (6): bind the ACTUALLY-CONNECTED database to the expected tuple BEFORE
  // any issuance or DDL.
  const c = await pool.query(`SELECT current_database() AS db`);
  if (String(c.rows[0]?.['db']) !== args['--expect-db']) {
    throw new Error(`release-migrations: connected database '${String(c.rows[0]?.['db'])}' is not the expected '${args['--expect-db']}' - refusing (fail-closed)`);
  }
  // (7): pre-mutation target binding, READ-ONLY, before anything else.
  await verifyTargetPreconditions(pool, { deployment, expectInstanceId: args['--expect-instance-id'], expectRegistryDigest: args['--expect-registry-digest'] });

  const resolveNote = args['--resolve-dirty'];
  if (resolveNote !== undefined) {
    // (10): attended resolution of a DIRTY/INDETERMINATE target.
    await attendedResolveDirty(pool, { note: resolveNote, resolvedBy: appliedBy });
    console.log(JSON.stringify({ ok: true, dirtyResolved: true }, null, 2));
    process.exit(0);
  }

  // (9) ISSUANCE FIRST: recomputes the canonical lists under the runner lock
  // and PERSISTS the unique nonce record (the only ack that can exist).
  const pf = await issueOperatorPreflight(pool, {
    deployment,
    expectInstanceId: args['--expect-instance-id'], expectRegistryDigest: args['--expect-registry-digest'],
  });
  console.log(JSON.stringify({ preflight: pf, registryDigest: REGISTRY_DIGEST }, null, 2));
  const required = operatorAckFor(pf);
  const ack = args['--ack'];
  if (!ack) {
    console.error(`GATE: no ack supplied - NOTHING executed (issuance recorded; unused issuances expire by staleness). Review the preflight above, then re-run with --ack ${required}`);
    process.exit(75);
  }
  // EXECUTION: the runner re-verifies the ack against the persisted record
  // under the step locks and consumes it atomically with the gated plan.
  const result = await runMigrations(pool, {
    deployment, appliedBy, operatorAck: ack,
    expectInstanceId: args['--expect-instance-id'], expectRegistryDigest: args['--expect-registry-digest'],
  });
  if (result.stampedNow) {
    console.error(
      `release-migrations: OPERATOR GATE (first run) - stamped deployment '${result.identity.deploymentLabel}' ` +
      `instance '${result.identity.instanceId}' on ${target.host}/${target.database}. This stamp is trust-on-first-use, ` +
      `NOT authentication: verify the target out-of-band NOW and pin later runs with --expect-instance-id ${result.identity.instanceId}.`,
    );
  }
  console.log(JSON.stringify({
    ok: true,
    deployment: result.identity.deploymentLabel,
    dbInstanceId: result.identity.instanceId,
    stampedNow: result.stampedNow,
    appliedNow: result.appliedNow,
    versions: result.versions,
  }));
} finally {
  await pool.end();
}
