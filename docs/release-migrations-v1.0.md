# Release migrations + staging synthetic seed (v1.3, 2026-09-18)

Owner: initializer lane (architecture convergence: external incident research +
TL ruling + QA's SA v8 finding "migrateUsersPhone has no shipped standard
runner/caller"). v1.3 is the unified declarative redesign resolving the
independent QA and security FAILs on f9854cd6, 9182487e and 22267edb, with
SA compatibility confirmed by backend and the TL's final reconciliation
(2026-09-18). Sources behind the design:
12factor.net/admin-processes, neon.com/docs/connect/choose-connection,
neon.com/docs/connect/connection-pooling, prisma.io/docs/orm/prisma-migrate/workflows/seeding.

## Architecture

ONE shared release-migration runner owns ALL schema evolution. There is no
other migration path and no schema work at app startup.

- **Declarative SQL artifacts ONLY** (`apps/api/src/migrations/runner.ts`).
  A migration is frozen TEXT: `{ version, name, description, sql }` plus
  runner-owned declarative guard primitives. There are NO function steps, NO
  DO/CALL/PLpgSQL, NO arbitrary raw-query capability anywhere in the
  framework. The digest hashes the artifact text and the ONLY statements
  executed are the parse of that exact text (trailing garbage fails the
  parse), one parsed statement per driver call. Editing anything that
  executes changes the digest and fails the runner AND boot history checks.
- **Real-parser AST allowlist, not regex.** Every artifact parses with a real
  PostgreSQL parser (pgsql-ast-parser). Only declarative DDL+DML statement
  types are permitted (create/alter/drop table+index, comment, insert,
  update, delete). Transaction control, SELECT/CALL/DO, session advisory
  functions and unparseable syntax (SAVEPOINT/SET/LOCK) are rejected at
  registration - quoting, schema-qualification and comment tricks resolve to
  the same AST and cannot bypass it.
- **Runner-owned guard primitives (TL reconciliation).** Assertions (named
  zero-row SELECT guards that HARD-FAIL inside the runner transaction, never
  silent-skip), table locks and the xact advisory lock are declared as
  structured step fields and executed BY THE RUNNER - never from migration
  text. Primitive declarations are digest-covered.
- **Versioned, forward-only migrations.** Registry `MIGRATIONS` is strictly
  sequential (`0001`, `0002`, ...). Applied history must be an exact registry
  prefix with exact version+name+digest equality (`verifyHistoryPrefix`).
- **One leased client per run, one session advisory lock.** Session-level
  `pg_advisory_lock(841000001)` held across bootstrap + all steps; concurrent
  runners serialize and the loser no-ops.
- **Runner-owned per-step transaction.** BEGIN, primitives, artifact
  statements, version INSERT in the SAME transaction (rowCount must be
  exactly 1), COMMIT; any failure rolls the whole step back; transactional
  DDL means partial step DDL never persists.
- **Explicit invocation only, closed CLI.** Schema changes run as a separate
  release job, never at web boot:
  `DATABASE_URL=<direct> pnpm --filter @contake/api migrate:release -- --deployment <label> --expect-host <host> --expect-db <db> [--by <actor>] [--expect-instance-id <id>]`
  Closed parser (unknown/duplicate/bare/missing rejected); flag XOR env URL;
  target tuple matched against the URL AND `current_database()` before DDL.
- **Pre-mutation target binding.** `verifyTargetPreconditions` (deployment
  label + optional `--expect-instance-id` pin) runs READ-ONLY before any
  write; the first-run stamp is printed as an operator-attended TOFU gate,
  never authentication. Later runs presenting a different deployment label or
  pinned instance are refused.
- **Startup verifies, never mutates.** A Postgres boot requires
  `CONTAKE_DEPLOYMENT` (optional `CONTAKE_DB_INSTANCE_ID`) and
  `assertSchemaCurrent` verifies exact versions + digests + stamped identity
  before anything serves. `PostgresGraphRepository.connect()` and
  `createPgOtpState(..., { applyDdl: false })` apply no DDL.
- **Role separation (Neon dual URL).** Release job and staging seed REQUIRE
  the direct schema-owner endpoint; `-pooler` is refused. The runtime uses
  the pooled least-privileged endpoint. `DATABASE_URL` is never logged.

## Migrations

- `0001 init-schema`: the graph DDL + OTP DDL previously applied implicitly at
  server boot, extracted unchanged as a declarative `sql` step (frozen
  `GRAPH_DDL`/`OTP_DDL` exports in `repo/postgres.ts` - never edit in place).

### SA plug-in contract (backend compatibility confirmed; TL reconciliation)

`migrateUsersPhone` registers as `0002` in DECLARATIVE form - no code in the
migration, guards as runner-owned primitives:

```ts
{ version: '0002', name: 'users-phone-unique-index',
  description: 'users_phone_unique canonical partial unique index (SA lane)',
  xactLockKey: <SA migration lock key>,        // runner executes pg_advisory_xact_lock
  lockTables: ['users'],                        // runner executes LOCK TABLE ... SHARE ROW EXCLUSIVE
  assertions: [                                 // runner-executed zero-row guards; ANY row hard-fails + rolls back
    { name: 'no_duplicate_normalized_phones', query: `SELECT btrim(phone) AS p FROM users WHERE phone IS NOT NULL GROUP BY btrim(phone) HAVING count(*) > 1` },
    { name: 'no_inconsistent_rows', query: `<SA inconsistency guard SELECT>` },
  ],
  sql: `CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(btrim(phone)) WHERE phone IS NOT NULL`,
}
```

Backend confirmed (2026-09-18) the declarative form keeps every safety:
ordered single-transaction xact lock + table lock, collision/inconsistency
guards, set-based normalization, rerun guards, canonical non-concurrent index
with plain btrim, final shape verification. Blocking guards hard-fail and roll
back, never silently skip. The rich structured preflight remains a companion
READ-ONLY SQL artifact outside the migration (operator evidence). The contract
is test-proven (`release-migrations.test.ts`, SA-shaped step tests). No second
runner may be introduced.

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
4. Migration history verified BEFORE mutation: `assertSchemaCurrent` must
   pass (exact versions + artifact digests) or the seed refuses with zero
   writes. Then full-coverage clean state: EVERY public business table (all
   except the explicit bookkeeping tables `schema_migrations`,
   `contake_db_identity`, `staging_seed_state`) must be empty on first run,
   or the database must be an exact verified re-run.
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
8. **Exact rerun integrity, full WHOLE-ROW coverage.** Applied state is a
   canonical manifest: per-row digests over `to_jsonb(t)::text` (EVERY
   column - authoritative relational columns and future ones, deterministic
   under PG jsonb normalization) for every row of every seeded table PLUS the
   verified zero-row list of every other business table, hashed into
   `staging_seed_state.manifest_sha256`. A re-run
   recomputes the live manifest and requires exact equality - drifted rows,
   foreign rows in ANY business table, or dirty state are refused and nothing
   is written. An exact re-run is a verified no-op.
9. Non-secret inventory (`contake-staging-inventory/v3`): ids, phones, emails,
   counts, row digests, zero-row table list, manifest digest, absence-proof
   summary, inventory sha256. A final guard proves no credential string
   appears in it.
10. **Durable atomic inventory publication.** `--inventory-out`: leftover
    temp files demand explicit operator reconciliation (indeterminate prior
    state is never guessed); full-write loop to a same-directory temp; fsync
    the temp; atomic no-clobber publish via hard-link (EEXIST refuses files
    AND symlinks); fsync the directory; temp cleanup failure is reported
    explicitly after a successful publish.

## Behavior change shipped with this architecture

The Postgres boot no longer applies the demo/camp-demo seeds or the QA staging
slice, and no longer runs bootstrap DDL; it requires CONTAKE_DEPLOYMENT and
verifies the stamped identity. Memory-adapter dev/test seeding is unchanged.
Existing Postgres deployments adopt the runner by one explicit
`migrate:release --deployment <label> --expect-host <host> --expect-db <db>`
run (no-op baseline), after which boots pass the gate. Rebuild path for
staging = migrate + `seed:staging`; no local `pg_dump` bootstrap.

## Evidence

- `apps/api/tests/release-migrations.test.ts` (22 tests): init/adopt/
  idempotent/cross-deployment/forward-only/boot-gate/deployment-verify/
  digest binding (sql text + fn source)/implementation-only edit/partial-DDL
  rollback/version-collision rollback/transaction-control rejection
  (case/whitespace/comment/multi-statement)/session-lock escape/SA tx-scoped
  plug-in/pooled-refusal.
- `apps/api/tests/staging-seed.test.ts` (17 tests): every gate, absence
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
