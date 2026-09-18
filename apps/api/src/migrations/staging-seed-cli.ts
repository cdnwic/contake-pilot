/** Staging-only synthetic seed job (EXPLICIT invocation; NEVER app startup).
 *
 *  Usage:
 *    CONTAKE_STAGING_SEED=1 DATABASE_URL=<direct staging url> \
 *    CONTAKE_STAGING_ADMIN_PASSWORD=<pre-vaulted> CONTAKE_STAGING_MANAGER_PASSWORD=<pre-vaulted> \
 *      pnpm --filter @contake/api seed:staging -- \
 *        --expect-host <host> --expect-db <db> [--inventory-out <path>]
 *
 *  Gates (all fail-closed, enforced in staging-seed.ts):
 *  - CONTAKE_STAGING_SEED=1 explicit marker;
 *  - the database must be identity-stamped 'staging*' by the release-migration
 *    job (a production-stamped database can NEVER be seeded);
 *  - the database must be newly initialized/empty, or an EXACT rerun whose
 *    live rows still match the seeded canonical row digests (dirty/foreign
 *    state is rejected).
 *
 *  CREDENTIAL FLOW (independent security, 2026-09-18): credentials are
 *  PRE-VAULTED by the operator and arrive via env
 *  (CONTAKE_STAGING_ADMIN_PASSWORD / CONTAKE_STAGING_MANAGER_PASSWORD); they
 *  are REQUIRED and never echoed. There is NO plaintext generation/stdout
 *  emission path. Production identifiers to forbid arrive via
 *  CONTAKE_FORBIDDEN_IDENTIFIERS / CONTAKE_SUPER_ADMIN_PHONES env, never
 *  hardcoded. */
import { runStagingSeed, deriveForbiddenIdentifiers } from './staging-seed.js';
import { assertDirectDatabaseUrl } from './runner.js';
import { parseCliArgs, resolveDatabaseUrl, durablePublish } from './cli-args.js';

const args = parseCliArgs(process.argv.slice(2), {
  required: ['--expect-host', '--expect-db'],
  optional: ['--inventory-out', '--database-url'],
});
const databaseUrl = resolveDatabaseUrl(args['--database-url'], process.env['DATABASE_URL']);
const target = assertDirectDatabaseUrl(databaseUrl);
if (target.host !== args['--expect-host'] || target.database !== args['--expect-db']) {
  console.error(
    `seed:staging: TARGET TUPLE mismatch - operator expected ${args['--expect-host']}/${args['--expect-db']} ` +
    `but the URL resolves to ${target.host}/${target.database}. Refusing before any connection (fail-closed).`,
  );
  process.exit(2);
}
console.log(`seed:staging: target ${target.host}/${target.database}`);

const adminPassword = process.env['CONTAKE_STAGING_ADMIN_PASSWORD'];
const managerPassword = process.env['CONTAKE_STAGING_MANAGER_PASSWORD'];
if (!adminPassword || !managerPassword) {
  console.error(
    'seed:staging: PRE-VAULTED credentials are required via CONTAKE_STAGING_ADMIN_PASSWORD and ' +
    'CONTAKE_STAGING_MANAGER_PASSWORD (generate + vault them first; this job never generates or echoes credentials).',
  );
  process.exit(2);
}

const { Pool } = await import('pg');
const pool = new Pool({ connectionString: databaseUrl });
try {
  const c = await pool.query(`SELECT current_database() AS db`);
  if (String(c.rows[0]?.['db']) !== args['--expect-db']) {
    throw new Error(`seed:staging: connected database '${String(c.rows[0]?.['db'])}' is not the expected '${args['--expect-db']}' - refusing (fail-closed)`);
  }
  const result = await runStagingSeed(pool, {
    marker: process.env['CONTAKE_STAGING_SEED'],
    forbiddenIdentifiers: deriveForbiddenIdentifiers(process.env),
    credentials: { adminPassword, managerPassword },
  });
  const inventoryJson = JSON.stringify(result.inventory, null, 2);
  const out = args['--inventory-out'];
  if (out) {
    durablePublish(out, inventoryJson);
    console.log(`seed:staging: non-secret inventory written to ${out} (manifest sha256 ${result.inventory.manifestSha256})`);
  } else {
    console.log('seed:staging: non-secret inventory:');
    console.log(inventoryJson);
  }
  console.log(result.alreadyApplied ? 'seed:staging: exact rerun verified (idempotent no-op)' : 'seed:staging: synthetic seed applied');
} finally {
  await pool.end();
}
