/** Release-migration job (EXPLICIT invocation - the only schema mutator).
 *
 *  Usage:
 *    DATABASE_URL=<direct schema-owner url> \
 *      pnpm --filter @contake/api migrate:release -- --deployment <label> [--by <actor>]
 *
 *  - Requires the DIRECT endpoint ('-pooler' hosts are refused: pooled is the
 *    runtime role). DATABASE_URL is never printed; only host/database.
 *  - --deployment must match the database's stamped identity (first run stamps
 *    it). Staging uses `--deployment staging`.
 *  - Forward-only: unknown/gapped history refuses; nothing is ever skipped.
 *  - Runs zero seeding. Boot verifies versions via assertSchemaCurrent. */
import { runMigrations, assertDirectDatabaseUrl } from './runner.js';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const databaseUrl = arg('--database-url') ?? process.env['DATABASE_URL'];
if (!databaseUrl) {
  console.error('release-migrations: DATABASE_URL (or --database-url) is required - direct schema-owner endpoint, never logged');
  process.exit(2);
}
const deployment = arg('--deployment');
if (!deployment) {
  console.error('release-migrations: --deployment <label> is required (e.g. staging, production-pilot) and must match the stamped database identity');
  process.exit(2);
}
const appliedBy = arg('--by') ?? 'release-job';

const target = assertDirectDatabaseUrl(databaseUrl); // throws on pooled/invalid
console.log(`release-migrations: target ${target.host}/${target.database} deployment=${deployment} by=${appliedBy}`);

const { Pool } = await import('pg');
const pool = new Pool({ connectionString: databaseUrl });
try {
  const result = await runMigrations(pool, { deployment, appliedBy });
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
