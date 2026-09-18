# Release migrations + staging synthetic seed (v1.1, 2026-09-18)

Owner: initializer lane (architecture convergence: external incident research +
TL ruling + QA's SA v8 finding "migrateUsersPhone has no shipped standard
runner/caller"). v1.1 resolves the independent QA and security FAILs on the
v1.0 head. Sources behind the design: 12factor.net/admin-processes,
neon.com/docs/connect/choose-connection, neon.com/docs/connect/connection-pooling,
prisma.io/docs/orm/prisma-migrate/workflows/seeding.

## Architecture

ONE shared release-migration runner owns ALL schema evolution. There is no
other migration path and no schema work at app startup.

- **Versioned, forward-only migrations** (`apps/api/src/migrations/runner.ts`).
  Registry `MIGRATIONS` is strictly sequential (`0001`, `0002`, ...). Applied
  history must be an exact registry prefix: unknown, gapped, out-of-order,
  renamed or tampered versions refuse loudly (`verifyHistoryPrefix`).
- **Implementation-integrity digests.** Every step declares its immutable
  `artifact` text (the actual DDL/implementation). `stepDigest` = sha256 over
  `contake-migration/v1` + version + name + artifact. Runner and boot gate
  require exact version + name + digest equality for every applied step, so a
  tampered migration implementation fails closed. Shipped artifacts are frozen
  (`GRAPH_DDL`/`OTP_DDL` carry FROZEN warnings - never edit in place).
- **One leased client per run, one session advisory lock.** `runMigrations`
  leases a single client, takes session-level `pg_advisory_lock(841000001)`
  for the whole run (bootstrap + all steps), and releases it on any outcome.
  Concurrent runners serialize; the loser sees a fully-applied history and
  no-ops.
- **Runner-owned per-step transaction.** Each step: BEGIN, `up(tx)` on the
  transaction-scoped client, version INSERT in the SAME transaction (rowCount
  must be exactly 1), COMMIT. A throw anywhere - step DDL or version insert -
  rolls the whole step back. Transactional DDL means partial step DDL never
  persists.
- **Explicit invocation only, closed CLI.** Schema changes run as a separate
  release job, never at web boot:
  `DATABASE_URL=<direct> pnpm --filter @contake/api migrate:release -- --deployment <label> --expect-host <host> --expect-db <db> [--by <actor>]`
  The parser is closed: unknown, duplicate, bare or missing flags are
  rejected. The deliberate URL source is flag XOR env. The operator-provided
  target tuple (`--expect-host`/`--expect-db`) must match the URL AND the
  connected `current_database()` before any DDL. `--by` is validated to a
  bounded actor shape; output is bounded and canonical.
- **Startup verifies, never mutates.** A Postgres boot calls
  `assertSchemaCurrent()` and FAILS CLOSED unless the database carries exactly
  the expected version sequence with matching digests.
  `PostgresGraphRepository.connect()` and `createPgOtpState(..., { applyDdl:
  false })` apply no DDL. (`.create()` and the default OTP path keep DDL for
  the hermetic test harness only.)
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
  server boot, extracted unchanged (single source: frozen `GRAPH_DDL`/`OTP_DDL`
  exports in `repo/postgres.ts`, referenced as `artifact`).

### SA plug-in contract (resolves the SA v8 QA finding)

Steps run INSIDE the runner's per-step transaction. A registered step MUST be
transaction-scoped: it receives the tx client and must NOT open its own
BEGIN/COMMIT. The SA lane's `migrateUsersPhone` currently self-transacts via
`withTx`; to register it as `0002` the SA lane exposes a tx-scoped entry point
(same preflight + index build, caller-owned transaction):

```ts
{ version: '0002', name: 'users-phone-unique-index',
  description: 'users_phone_unique partial unique index after clean preflight (SA lane)',
  artifact: USERS_PHONE_INDEX_DDL,   // frozen text, digest-covered
  up: async (tx) => {
    const r = await migrateUsersPhoneTx(tx);       // tx-scoped; no own BEGIN/COMMIT
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
CONTAKE_STAGING_SEED=1 \
CONTAKE_STAGING_ADMIN_PASSWORD=<pre-vaulted> CONTAKE_STAGING_MANAGER_PASSWORD=<pre-vaulted> \
DATABASE_URL=<direct staging url> \
  pnpm --filter @contake/api seed:staging -- --expect-host <host> --expect-db <db> [--inventory-out <path>]
```

Gates (all fail-closed, one transaction - any failure rolls back everything):

1. `CONTAKE_STAGING_SEED=1` explicit marker. Never app startup.
2. Database identity stamped `staging*` by the release job. A
   production-stamped database can never be seeded.
3. Target tuple (`--expect-host`/`--expect-db`) matched against the URL and
   `current_database()` before any write. Closed CLI parser; flag XOR env URL.
4. Newly initialized/empty business tables, or an exact verified re-run.
5. **Pre-vaulted credentials only.** The job never generates, echoes or
   accepts credentials on a command line (argv is world-visible). Credentials
   arrive via `CONTAKE_STAGING_ADMIN_PASSWORD` /
   `CONTAKE_STAGING_MANAGER_PASSWORD` (min 16 chars each) after being
   generated and vaulted through the sanctioned vault flow. There is no
   stdout secret path.
6. Everything else synthetic, generated at runtime with `node:crypto` CSPRNG:
   ids `stg-*-<12 hex>`, phones `+972-555-xxxxxx` (fictional exchange),
   emails on the RFC 2606 `.invalid` TLD.
7. Absence proofs: the full public-fixture identifier set is DERIVED from the
   seed modules (`deriveFixtureIdentifiers` - a fixture added later is
   forbidden automatically); production identifiers arrive via
   `CONTAKE_FORBIDDEN_IDENTIFIERS` / `CONTAKE_SUPER_ADMIN_PHONES` env, never
   hardcoded. Pre-write set intersection + post-write exact-column and
   boundary-aware jsonb scan must both be clean or the tx rolls back.
8. **Exact rerun integrity.** Applied state is a canonical manifest: per-row
   digests (key-sorted canonical JSON, sha256) over every seeded row plus a
   manifest digest stored in `staging_seed_state.manifest_sha256`. A re-run
   recomputes the live manifest and requires exact equality - drifted, dirty
   or foreign state is refused ("RERUN INTEGRITY refusal") and nothing is
   written. An exact re-run is a verified no-op.
9. Non-secret inventory (`contake-staging-inventory/v2`): ids, phones, emails,
   counts, row digests, manifest digest, absence-proof summary, inventory
   sha256. A final guard proves no credential string appears in it.

## Behavior change shipped with this architecture

The Postgres boot no longer applies the demo/camp-demo seeds or the QA staging
slice, and no longer runs bootstrap DDL. Memory-adapter dev/test seeding is
unchanged. Existing Postgres deployments adopt the runner by one explicit
`migrate:release --deployment <label> --expect-host <host> --expect-db <db>`
run (no-op baseline), after which boots pass the version gate. Rebuild path
for staging = migrate + `seed:staging`; no local `pg_dump` bootstrap.

## Evidence

- `apps/api/tests/release-migrations.test.ts` (13 tests): init/adopt/
  idempotent/cross-deployment/forward-only/boot-gate/digest-tamper (name AND
  artifact)/partial-DDL rollback/version-collision rollback/SA tx-scoped
  plug-in/pooled-refusal.
- `apps/api/tests/staging-seed.test.ts` (13 tests): every gate, absence
  proofs, secret-free inventory, rerun-integrity drift rejection, full
  rollback, CSPRNG disjointness, env-credential flow.
- `apps/api/tests/cli-args.test.ts` (8 tests): closed parser (unknown/
  duplicate/bare/missing), flag-XOR-env URL, actor validation, output-path
  no-clobber.
- `apps/api/evidence-realpg-release-migrations.mts`: disposable real
  PostgreSQL 14 cluster proof (two phases across a REAL stop/start): full run,
  cross-session advisory-lock concurrency race (exactly one winner), per-step
  DDL rollback, seed transaction + exact rerun + drift refusal + forced
  post-write rollback, pooled/direct targeting, restart durability of history
  and seeded rows, boot gate after restart. CLI end-to-end: idempotent no-op,
  target-tuple refusal pre-connection, unknown-flag rejection, fail-closed
  without opt-in marker and without pre-vaulted credentials.
