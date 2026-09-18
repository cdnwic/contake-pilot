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
 *  - the deployment label must match the database's stamped identity (first
 *    run stamps it); staging uses `--deployment staging`;
 *  - requires the DIRECT endpoint ('-pooler' hosts are refused: pooled is the
 *    runtime role); DATABASE_URL is never printed;
 *  - forward-only + applied-step integrity digests; runs zero seeding. */
import { runMigrations, assertDirectDatabaseUrl } from './runner.js';
import { parseCliArgs, resolveDatabaseUrl, validateActor } from './cli-args.js';

const args = parseCliArgs(process.argv.slice(2), {
  required: ['--deployment', '--expect-host', '--expect-db'],
  optional: ['--by', '--database-url'],
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
  const result = await runMigrations(pool, { deployment: args['--deployment']!, appliedBy });
  console.log(JSON.stringify({
    ok: true,
    deployment: result.identity.deploymentLabel,
    dbInstanceId: result.identity.instanceId,
    appliedNow: result.appliedNow,
    versions: result.versions,
  }));
} finally {
  await pool.end();
}
