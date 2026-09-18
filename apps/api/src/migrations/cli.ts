/** Release-migration job (EXPLICIT invocation - the only schema mutator).
 *
 *  Usage:
 *    DATABASE_URL=<direct schema-owner url> \
 *      pnpm --filter @contake/api migrate:release -- \
 *        --deployment <label> --expect-host <host> --expect-db <db> [--by <actor>]
 *
 *  Security contract (independent review, 2026-09-18):
 *  - closed parser: unknown/duplicate/bare/missing flags are rejected;
 *  - ONE deliberate URL source (--database-url XOR env);
 *  - the OPERATOR-PROVISIONED TARGET TUPLE (--expect-host/--expect-db) must
 *    match the URL AND the actually-connected database BEFORE any DDL;
 *  - the deployment label must match the database's stamped identity. The
 *    first-run stamp is an OPERATOR-ATTENDED gate (trust-on-first-use), NOT
 *    authentication: the stamped instance id is printed for out-of-band
 *    operator verification, and later runs may pin it with
 *    --expect-instance-id (pre-provisioned immutable binding). Staging uses
 *    `--deployment staging`;
 *  - requires the DIRECT endpoint ('-pooler' hosts are refused: pooled is the
 *    runtime role); DATABASE_URL is never printed;
 *  - forward-only + applied-step integrity digests; runs zero seeding. */
import { runMigrations, assertDirectDatabaseUrl, verifyTargetPreconditions } from './runner.js';
import { parseCliArgs, resolveDatabaseUrl, validateActor } from './cli-args.js';

const args = parseCliArgs(process.argv.slice(2), {
  required: ['--deployment', '--expect-host', '--expect-db'],
  optional: ['--by', '--database-url', '--expect-instance-id', '--expect-registry-digest'],
});
const databaseUrl = resolveDatabaseUrl(args['--database-url'], process.env['DATABASE_URL']);
const appliedBy = validateActor(args['--by'] ?? 'release-job');

const target = assertDirectDatabaseUrl(databaseUrl); // throws on pooled/invalid
if (target.host !== args['--expect-host'] || target.database !== args['--expect-db']) {
  console.error(
    `release-migrations: TARGET TUPLE mismatch - operator expected ${args['--expect-host']}/${args['--expect-db']} ` +
    `but the URL resolves to ${target.host}/${target.database}. Refusing before any connection (fail-closed).`,
  );
  process.exit(2);
}
console.log(`release-migrations: target ${target.host}/${target.database} deployment=${args['--deployment']} by=${appliedBy}`);

const { Pool } = await import('pg');
const pool = new Pool({ connectionString: databaseUrl });
try {
  // Bind the ACTUALLY-CONNECTED database to the expected tuple before any DDL.
  const c = await pool.query(`SELECT current_database() AS db, inet_server_port() AS port`);
  if (String(c.rows[0]?.['db']) !== args['--expect-db']) {
    throw new Error(`release-migrations: connected database '${String(c.rows[0]?.['db'])}' is not the expected '${args['--expect-db']}' - refusing (fail-closed)`);
  }
  // PRE-MUTATION target binding (security): verify the stamped deployment +
  // instance pin READ-ONLY before any write. First runs are unstamped and
  // proceed to the operator-attended TOFU stamp below.
  await verifyTargetPreconditions(pool, { deployment: args['--deployment']!, expectInstanceId: args['--expect-instance-id'], expectRegistryDigest: args['--expect-registry-digest'] });
  const result = await runMigrations(pool, { deployment: args['--deployment']!, appliedBy, expectInstanceId: args['--expect-instance-id'], expectRegistryDigest: args['--expect-registry-digest'] });
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
