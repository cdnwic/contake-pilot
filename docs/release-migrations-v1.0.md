# Release migrations + staging synthetic seed (v1.2, 2026-09-18)

Owner: initializer lane (architecture convergence: external incident research +
TL ruling + QA's SA v8 finding "migrateUsersPhone has no shipped standard
runner/caller"). v1.2 resolves the independent QA and security FAILs on the
v1.0 (f9854cd6) and v1.1 (9182487e) heads. Sources behind the design:
12factor.net/admin-processes, neon.com/docs/connect/choose-connection,
neon.com/docs/connect/connection-pooling, prisma.io/docs/orm/prisma-migrate/workflows/seeding.

## Architecture

ONE shared release-migration runner owns ALL schema evolution. There is no
other migration path and no schema work at app startup.

- **Versioned, forward-only migrations** (`apps/api/src/migrations/runner.ts`).
  Registry `MIGRATIONS` is strictly sequential (`0001`, `0002`, ...). Applied
  history must be an exact registry prefix: unknown, gapped, out-of-order,
  renamed or tampered versions refuse loudly (`verifyHistoryPrefix`).
- **Mechanically bound integrity digests.** A step is one of two shapes:
  - `sql` (declarative only): the runner executes EXACTLY `step.sql` and
    hashes exactly `step.sql`. Executed and hashed bytes cannot diverge.
  - `fn` (programmatic migrations such as the SA users-phone preflight): the
    digest covers `up.toString()` - the exact function source that runs.
  Any implementation-only edit with an unchanged declaration changes the
  digest and fails the runner history check AND the boot gate.
- **Restricted transaction capability.** Step code never sees the raw client.
  It receives a wrapper whose query() mechanically REJECTS
  transaction-control statements (BEGIN/START/COMMIT/ROLLBACK/ABORT/END/
  SAVEPOINT/RELEASE/PREPARE TRANSACTION/SET TRANSACTION/SET CONSTRAINTS) and
  session-scoped advisory-lock calls (pg_advisory_lock/unlock/unlock_all),
  tolerant of case, whitespace and SQL comment disguise and multi-statement
  strings. The transaction-scoped pg_advisory_xact_lock family stays legal
  (SA's body uses it). A rejected statement throws, the runner rolls the whole
  step back, nothing persists.
- **One leased client per run, one session advisory lock.** `runMigrations`
  leases a single client, takes session-level `pg_advisory_lock(841000001)`
  for the whole run (bootstrap + all steps), and releases it on any outcome.
  Concurrent runners serialize; the loser sees a fully-applied history and
  no-ops.
- **Runner-owned per-step transaction.** Each step: BEGIN, step body on the
  restricted capability, version INSERT in the SAME transaction (rowCount must
  be exactly 1), COMMIT. A throw anywhere rolls the whole step back;
  transactional DDL means partial step DDL never persists.
- **Explicit invocation only, closed CLI.** Schema changes run as a separate
  release job, never at web boot:
  `DATABASE_URL=<direct> pnpm --filter @contake/api migrate:release -- --deployment <label> --expect-host <host> --expect-db <db> [--by <actor>] [--expect-instance-id <id>]`
  The parser is closed: unknown, duplicate, bare or missing flags are
  rejected. The deliberate URL source is flag XOR env. The operator-provided
  target tuple must match the URL AND the connected `current_database()`
  before any DDL. `--by` is validated to a bounded actor shape.
- **Target identity is an operator-attended gate, NOT authentication.** The
  first run stamps single-row `contake_db_identity` (deployment label +
  random instance id) and prints it as a trust-on-first-use OPERATOR GATE:
  the operator verifies the target out-of-band at that moment and pins later
  runs with `--expect-instance-id`. Later runs presenting a different
  deployment label (or pinned instance) are refused.
- **Startup verifies, never mutates.** A Postgres boot requires
  `CONTAKE_DEPLOYMENT` and calls `assertSchemaCurrent(pool, undefined,
  { deployment })`: exact expected version sequence + name/digest integrity +
  the stamped deployment identity must match before anything serves.
  `PostgresGraphRepository.connect()` and `createPgOtpState(..., { applyDdl:
  false })` apply no DDL. (`.create()` and the default OTP path keep DDL for
  the hermetic test harness only.)
- **Role separation (Neon dual URL).** The release job and staging seed
  REQUIRE the direct (schema-owner) endpoint; a `-pooler` host is refused.
  The runtime app uses the pooled least-privileged endpoint and contains no
  schema code path. `DATABASE_URL` is never logged; only host/database.

## Migrations

- `0001 init-schema`: the graph DDL + OTP DDL previously applied implicitly at
  server boot, extracted unchanged as a declarative `sql` step (frozen
  `GRAPH_DDL`/`OTP_DDL` exports in `repo/postgres.ts` - never edit in place).

### SA plug-in contract (resolves the SA v8 QA finding)

Steps run INSIDE the runner's per-step transaction on the restricted
capability. The SA lane's `migrateUsersPhone` currently self-transacts via
`withTx`; to register as `0002` the SA lane exposes a tx-scoped entry point
(same preflight + index build, caller-owned transaction). It registers as an
`fn` step, so its integrity digest covers the registered function's exact
source:

```ts
{ kind: 'fn', version: '0002', name: 'users-phone-unique-index',
  description: 'users_phone_unique partial unique index after clean preflight (SA lane)',
  up: async (tx) => {
    const r = await migrateUsersPhoneTx(tx);       // tx-scoped; no own BEGIN/COMMIT
    if (!r.migrated) throw new Error(`users-phone migration blocked: ${r.reason}`);
  } }
```

The contract is test-proven (`release-migrations.test.ts`, SA plug-in test).
No second runner may be introduced; the SA/backend lanes were told the
initializer lane owns the runner.

## Staging synthetic seed (`seed:staging`)

Staging data comes ONLY from the explicit job:

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
3. Target tuple matched against the URL and `current_database()` before any
   write. Closed CLI parser; flag XOR env URL.
4. Full-coverage clean state: EVERY public business table (all except the
   explicit bookkeeping tables `schema_migrations`, `contake_db_identity`,
   `staging_seed_state`) must be empty on first run, or the database must be
   an exact verified re-run.
5. **Pre-vaulted credentials only.** The job never generates, echoes or
   accepts credentials on a command line. Credentials arrive via
   `CONTAKE_STAGING_ADMIN_PASSWORD` / `CONTAKE_STAGING_MANAGER_PASSWORD`
   (min 16 chars each) after being generated and vaulted through the
   sanctioned vault flow. There is no stdout secret path.
6. Everything else synthetic, generated at runtime with `node:crypto` CSPRNG:
   ids `stg-*-<12 hex>`, phones `+972-555-xxxxxx` (fictional exchange),
   emails on the RFC 2606 `.invalid` TLD.
7. Absence proofs: the full public-fixture identifier set is DERIVED from the
   seed modules; production identifiers arrive via
   `CONTAKE_FORBIDDEN_IDENTIFIERS` / `CONTAKE_SUPER_ADMIN_PHONES` env, never
   hardcoded. Pre-write set intersection + post-write exact-column and
   boundary-aware jsonb scan must both be clean or the tx rolls back.
8. **Exact rerun integrity, full coverage.** Applied state is a canonical
   manifest: per-row digests (key-sorted canonical JSON, sha256) over every
   row of every seeded table PLUS the verified zero-row list of every other
   business table, hashed into `staging_seed_state.manifest_sha256`. A re-run
   recomputes the live manifest and requires exact equality - drifted rows,
   foreign rows in ANY business table, or dirty state are refused and nothing
   is written. An exact re-run is a verified no-op.
9. Non-secret inventory (`contake-staging-inventory/v3`): ids, phones, emails,
   counts, row digests, zero-row table list, manifest digest, absence-proof
   summary, inventory sha256. A final guard proves no credential string
   appears in it.
10. **Atomic inventory publication.** `--inventory-out` is published with ONE
    exclusive create (O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600, fsync before
    close): no check-then-write race, no symlink following, no torn file.

## Behavior change shipped with this architecture

The Postgres boot no longer applies the demo/camp-demo seeds or the QA staging
slice, and no longer runs bootstrap DDL; it requires CONTAKE_DEPLOYMENT and
verifies the stamped identity. Memory-adapter dev/test seeding is unchanged.
Existing Postgres deployments adopt the runner by one explicit
`migrate:release --deployment <label> --expect-host <host> --expect-db <db>`
run (no-op baseline), after which boots pass the gate. Rebuild path for
staging = migrate + `seed:staging`; no local `pg_dump` bootstrap.

## Evidence

- `apps/api/tests/release-migrations.test.ts` (20 tests): init/adopt/
  idempotent/cross-deployment/forward-only/boot-gate/deployment-verify/
  digest binding (sql text + fn source)/implementation-only edit/partial-DDL
  rollback/version-collision rollback/transaction-control rejection
  (case/whitespace/comment/multi-statement)/session-lock escape/SA tx-scoped
  plug-in/pooled-refusal.
- `apps/api/tests/staging-seed.test.ts` (15 tests): every gate, absence
  proofs, secret-free inventory, rerun-integrity drift rejection, foreign
  rows in non-seeded business tables (first-run and rerun), full rollback,
  CSPRNG disjointness, env-credential flow.
- `apps/api/tests/cli-args.test.ts` (8 tests): closed parser, flag-XOR-env
  URL, actor validation, atomic exclusive inventory publication (existing
  path, symlink, two-writer race).
- `apps/api/evidence-realpg-release-migrations.mts`: disposable real
  PostgreSQL 14 proof across a REAL stop/start, with runtime-generated
  ephemeral harness credentials (never printed or committed): full run,
  cross-session advisory-lock race, per-step DDL rollback, COMMIT and
  session-lock escape rejection on real PG, seed transaction + exact rerun +
  drift refusal + forced post-write rollback, pooled/direct targeting,
  restart durability, CLI end-to-end.
