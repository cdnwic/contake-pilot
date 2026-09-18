/** Staging-only synthetic seed job (EXPLICIT invocation; NEVER app startup).
 *
 *  Usage:
 *    CONTAKE_STAGING_SEED=1 DATABASE_URL=<direct staging url> \
 *      pnpm --filter @contake/api seed:staging -- --inventory-out <path> [--emit-secrets]
 *
 *  Gates (all fail-closed, enforced in staging-seed.ts):
 *  - CONTAKE_STAGING_SEED=1 explicit marker;
 *  - the database must be identity-stamped 'staging*' by the release-migration
 *    job (a production-stamped database can NEVER be seeded);
 *  - the database must be newly initialized/empty, or an exact idempotent
 *    re-run of a previous synthetic seed.
 *
 *  CREDENTIAL FLOW (sanctioned vault flow only):
 *  - default: credentials are generated with a CSPRNG and are REFUSED unless
 *    --emit-secrets is passed; --emit-secrets prints them ONCE to the terminal
 *    for immediate `vault create` capture - they are never written to files,
 *    artifacts, inventory, or logs by this job (if the job runner captures
 *    stdout, treat that log as exposed and rotate);
 *  - or pre-generate + vault them yourself and pass CONTAKE_STAGING_ADMIN_PASSWORD
 *    / CONTAKE_STAGING_MANAGER_PASSWORD; env-supplied credentials are never
 *    echoed.
 *  Production identifiers to forbid (e.g. super-admin phones) are read from
 *  CONTAKE_FORBIDDEN_IDENTIFIERS / CONTAKE_SUPER_ADMIN_PHONES env, never
 *  hardcoded. */
import { runStagingSeed, deriveForbiddenIdentifiers } from './staging-seed.js';
import { assertDirectDatabaseUrl } from './runner.js';
import { writeFile } from 'node:fs/promises';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const databaseUrl = arg('--database-url') ?? process.env['DATABASE_URL'];
if (!databaseUrl) {
  console.error('seed:staging: DATABASE_URL (or --database-url) is required - direct staging endpoint, never logged');
  process.exit(2);
}
const target = assertDirectDatabaseUrl(databaseUrl);
console.log(`seed:staging: target ${target.host}/${target.database}`);

const envCredentials = {
  adminPassword: process.env['CONTAKE_STAGING_ADMIN_PASSWORD'],
  managerPassword: process.env['CONTAKE_STAGING_MANAGER_PASSWORD'],
};
const emitSecrets = process.argv.includes('--emit-secrets');
const usingEnvCredentials = Boolean(envCredentials.adminPassword && envCredentials.managerPassword);
if (!usingEnvCredentials && !emitSecrets) {
  console.error(
    'seed:staging: refusing to generate credentials that would leave no sanctioned capture path. ' +
    'Either pass --emit-secrets (ONE terminal emission for immediate vault capture) ' +
    'or provide pre-vaulted CONTAKE_STAGING_ADMIN_PASSWORD and CONTAKE_STAGING_MANAGER_PASSWORD.',
  );
  process.exit(2);
}

const { Pool } = await import('pg');
const pool = new Pool({ connectionString: databaseUrl });
try {
  const result = await runStagingSeed(pool, {
    marker: process.env['CONTAKE_STAGING_SEED'],
    forbiddenIdentifiers: deriveForbiddenIdentifiers(process.env),
    ...(usingEnvCredentials ? { credentials: envCredentials } : {}),
    emitSecrets,
  });
  const inventoryJson = JSON.stringify(result.inventory, null, 2);
  const out = arg('--inventory-out');
  if (out) {
    await writeFile(out, inventoryJson, { mode: 0o600 });
    console.log(`seed:staging: non-secret inventory written to ${out} (sha256 ${result.inventory.inventorySha256})`);
  } else {
    console.log('seed:staging: non-secret inventory:');
    console.log(inventoryJson);
  }
  if (result.secrets) {
    console.log('=== ONE-TIME CREDENTIAL EMISSION - capture into the vault NOW ===');
    for (const s of result.secrets) console.log(`${s.label}: ${s.value}`);
    console.log('These values are held NOWHERE else: not in the inventory, not in files, not in the database in plaintext.');
    console.log('If this terminal output is captured by a job log, treat it as exposed and re-run on a fresh staging DB.');
  }
  console.log(result.alreadyApplied ? 'seed:staging: already applied (idempotent no-op)' : 'seed:staging: synthetic seed applied');
} finally {
  await pool.end();
}
