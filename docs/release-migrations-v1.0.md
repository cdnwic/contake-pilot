# Release migrations + staging synthetic seed (v1.0, 2026-09-18)

Owner: initializer lane (architecture convergence: external incident research +
TL ruling + QA's SA v8 finding "migrateUsersPhone has no shipped standard
runner/caller"). Sources behind the design: 12factor.net/admin-processes,
neon.com/docs/connect/choose-connection, neon.com/docs/connect/connection-pooling,
prisma.io/docs/orm/prisma-migrate/workflows/seeding.

## Architecture

ONE shared release-migration runner owns ALL schema evolution. There is no
other migration path and no schema work at app startup.

- **Versioned, forward-only migrations** (`apps/api/src/migrations/runner.ts`).
  Registry `MIGRATIONS` is strictly sequential (`0001`, `0002`, ...). Applied
  history must be an exact registry prefix: unknown, gapped or out-of-order
  versions refuse loudly. Nothing is skipped, reordered or silently rebased.
- **Explicit invocation only.** Schema changes run as a separate release job,
  never at web boot (12-factor admin process; Render free has no pre-deploy
  job, so the job is run deliberately per release until a separately
  authorized CI release job exists):
  `DATABASE_URL=<direct> pnpm --filter @contake/api migrate:release -- --deployment <label> [--by <actor>]`
- **Startup verifies, never mutates.** A Postgres boot calls
  `assertSchemaCurrent()` and FAILS CLOSED unless the database carries exactly
  the expected version sequence. `PostgresGraphRepository.connect()` and
  `createPgOtpState(..., { applyDdl: false })` apply no DDL. (`.create()` and
  the default OTP path keep DDL for the hermetic test harness only.)
- **Every step is atomic and idempotent.** A step owns its transaction; the
  version record follows the step, so a crash between the two re-runs the step
  safely. 0001 is all `IF NOT EXISTS`, so pre-migration databases (existing
  staging/prod) adopt the runner as a no-op baseline: run the release job once
  with the right `--deployment` label, then boot.
- **Cross-deployment protection.** First run stamps single-row
  `contake_db_identity` (deployment label + random instance id). Any later run
  presenting a different label is refused - one database can never be adopted
  by two deployments.
- **Role separation (Neon dual URL).** The release job and staging seed
  REQUIRE the direct (schema-owner) endpoint; a `-pooler` host is refused
  (`assertDirectDatabaseUrl`). The runtime app uses the pooled least-privileged
  endpoint and contains no schema code path. `DATABASE_URL` is never logged;
  only host/database.

## Migrations

- `0001 init-schema`: the graph DDL + OTP DDL previously applied implicitly at
  server boot, extracted unchanged (single source: `GRAPH_DDL`/`OTP_DDL`
  exports in `repo/postgres.ts`).

### SA plug-in contract (resolves the SA v8 QA finding)

`migrateUsersPhone(conn)` (SA lane, `services/phone-migration.ts`) already IS
one locked, idempotent transaction - exactly the `MigrationStep` contract.
When the SA track lands, register it as `0002` in `MIGRATIONS`:

```ts
{ version: '0002', name: 'users-phone-unique-index',
  description: 'users_phone_unique partial unique index after clean preflight (SA lane)',
  up: async (conn) => {
    const r = await migrateUsersPhone(conn);
    if (!r.migrated) throw new Error(`users-phone migration blocked: ${r.reason}`);
  } }
```

The contract is test-proven (`release-migrations.test.ts` "SA plug-in
contract"). No second runner may be introduced; the SA/backend lanes were told
the initializer lane owns the runner.

## Staging synthetic seed (`seed:staging`)

The repo's demo seeds contain public fixed passwords/phones/identifiers and
are forbidden in production boots; staging runs `NODE_ENV=production`.
Staging data therefore comes ONLY from:

```
CONTAKE_STAGING_SEED=1 DATABASE_URL=<direct staging url> \
  pnpm --filter @contake/api seed:staging -- --inventory-out <path> [--emit-secrets]
```

Gates (all fail-closed, one transaction - any failure rolls back everything):

1. `CONTAKE_STAGING_SEED=1` explicit marker. Never app startup.
2. Database identity stamped `staging*` by the release job. A
   production-stamped database can never be seeded.
3. Newly initialized/empty business tables, or an exact idempotent re-run
   bound by `staging_seed_state` (re-run = no-op).
4. Everything synthetic, generated at runtime with `node:crypto` CSPRNG:
   ids `stg-*-<12 hex>`, phones `+972-555-xxxxxx` (fictional exchange),
   emails on the RFC 2606 `.invalid` TLD, 16-char base64url credentials.
5. Absence proofs: the full public-fixture identifier set is DERIVED from the
   seed modules (`deriveFixtureIdentifiers` - a fixture added later is
   forbidden automatically); production identifiers arrive via
   `CONTAKE_FORBIDDEN_IDENTIFIERS` / `CONTAKE_SUPER_ADMIN_PHONES` env, never
   hardcoded. Pre-write set intersection + post-write exact-column and
   boundary-aware jsonb scan must both be clean or the tx rolls back.
6. Non-secret inventory (`contake-staging-inventory/v1`): ids, phones, emails,
   counts, absence-proof summary, sha256. A final guard proves no credential
   string appears in it.

Credential flow (sanctioned vault path only): either pass
`--emit-secrets` (ONE terminal emission for immediate `vault create` capture;
never written to files/logs/artifacts by the job - if a job runner captures
stdout, treat it as exposed and re-run on a fresh DB) or pre-generate + vault
and pass `CONTAKE_STAGING_ADMIN_PASSWORD` / `CONTAKE_STAGING_MANAGER_PASSWORD`
(never echoed).

## Behavior change shipped with this architecture

The Postgres boot no longer applies the demo/camp-demo seeds or the QA staging
slice, and no longer runs bootstrap DDL. Memory-adapter dev/test seeding is
unchanged. Existing Postgres deployments adopt the runner by one explicit
`migrate:release --deployment <label>` run (no-op baseline), after which boots
pass the version gate. Rebuild path for staging = migrate + `seed:staging`;
no local `pg_dump` bootstrap.

## Evidence

- `apps/api/tests/release-migrations.test.ts` (9 tests): init/adopt/idempotent/
  cross-deployment/forward-only/boot-gate/SA plug-in/pooled-refusal.
- `apps/api/tests/staging-seed.test.ts` (12 tests): every gate, absence
  proofs, secret-free inventory, idempotency, full rollback, CSPRNG
  disjointness, env-credential flow.
