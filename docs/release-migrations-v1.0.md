# Release migrations + staging synthetic seed (v1.5, 2026-09-18)

Owner: initializer lane (architecture convergence: external incident research +
TL ruling + QA's SA v8 finding "migrateUsersPhone has no shipped standard
runner/caller"). v1.3 is the unified declarative redesign resolving the
independent QA and security FAILs on f9854cd6, 9182487e, 22267edb and
976db452 and c862cbbe, with SA compatibility confirmed by backend and the
TL's final reconciliation + semantic-layer ruling (2026-09-18). v1.5 resolves
the third unified QA+security round by MOVING THE SECURITY BOUNDARY from
syntactic name allowlists to the database semantic layer, and is the first
tenant of the governed execution/authorization substrate (Chaim's widened
brief): one policy/enforcement/evidence boundary for every data-changing
operation, with seed, repair, rollback and admin paths converging on it.

v1.5 pillars (TL semantic-layer ruling + security closures, fixed scope):
1. Migration session search_path PINNED EMPTY (re-pinned inside every step
   transaction and before every artifact statement; RESET before the client
   returns to the pool). pg_catalog is implicitly searched first, so
   unqualified built-ins resolve to pg_catalog only - no schema shadowing.
2. Every artifact identifier is canonically FULLY QUALIFIED by the runner:
   relations to the controlled schema 'public', function calls to
   'pg_catalog'. A caller-supplied schema outside the controlled one
   (attacker.lower, public.btrim-as-function, evil.now) is REFUSED.
3. RECURSIVELY CLOSED AST shapes: no WITH/CTEs (mutating or not), no nested
   SELECT/subqueries, no code/object-bearing statements (function/procedure/
   operator/cast/trigger/rule/aggregate/type/DO/CALL/COPY/OWNER/
   security-definer) - statement allowlist plus an explicit closed
   ALTER-action set.
4. STRICT runtime guard-object validation (exact own-key sets, exact
   enums/booleans, canonical lowercase identifiers) BEFORE digest AND BEFORE
   execution - an invalid guard object cannot even be hashed.
5. Runner-owned CATALOG SNAPSHOTS before/after every step: zero
   function/operator/cast/trigger/rule deltas or the step rolls back.
   Session-state assertion: the whole-run advisory lock must still be held
   after each step (a smuggled unlock rolls back).
6. LEAST-PRIVILEGE ROLES: the release job runs as a dedicated direct
   migration role (NOINHERIT/NOSUPERUSER/NOCREATEDB/NOCREATEROLE, CREATE
   only on the controlled schema - it cannot create code objects even by
   hand); the runtime uses a narrower pooled role (read-only on migration
   history). Proven on real Postgres in evidence phase3.
7. Digest v6 binds the canonical QUALIFIED serialization actually executed.
8. Durable no-clobber publication preserves BOTH the original failure
   (message + cause) AND the exact temp/reconciliation state in every error.
9. Fresh-DB + supplied pin refuses pre-write; EVERY PG boot requires
   deployment + instance identity (carried closures). Sources behind the design:
12factor.net/admin-processes, neon.com/docs/connect/choose-connection,
neon.com/docs/connect/connection-pooling, prisma.io/docs/orm/prisma-migrate/workflows/seeding.

## Architecture

ONE shared release-migration runner owns ALL schema evolution. There is no
other migration path and no schema work at app startup.

- **Declarative SQL artifacts ONLY** (`apps/api/src/migrations/runner.ts`).
  A migration is frozen TEXT: `{ version, name, description, sql }` plus
  runner-owned declarative guard primitives. There are NO function steps, NO
  DO/CALL/PLpgSQL, NO arbitrary raw-query capability anywhere in the
  framework. The ONLY statements executed are the per-statement AST
  re-serializations of the artifact, and the digest hashes EXACTLY that
  canonical serialization - executed bytes and hashed bytes are the same
  object by construction (formatting/comments cannot drift the digest;
  semantics always do; parse-serialize-reparse equivalence is tested for
  every shipped artifact). `description` is operator documentation and is
  NOT integrity-protected. Editing anything that executes changes the
  digest and fails the runner AND boot history checks.
- **Semantic-layer enforcement, not syntactic name lists (TL ruling).** Every
  artifact parses with a real PostgreSQL parser (pgsql-ast-parser). Only
  declarative DDL+DML statement types are permitted (create/alter/drop
  table+index, comment, insert, update, delete) with a closed ALTER-action
  set; code/object-bearing statements (function/procedure/operator/cast/
  trigger/rule/aggregate/type/DO/CALL/COPY/OWNER/security-definer), WITH/
  CTEs and nested subqueries are refused recursively. The runner then
  CANONICALLY QUALIFIES every identifier - relations to `public`, function
  calls to `pg_catalog` - and executes with search_path pinned empty, so
  name resolution is provably confined to {public, pg_catalog} and no UDF,
  operator, cast or shadowing trick can resolve. A per-step catalog
  snapshot asserts zero function/operator/cast/trigger/rule deltas; a
  session assertion proves the whole-run advisory lock survives each step.
  The enforcement boundary is the database's own semantics, not a list of
  names.
- **Fixed named runner-generated guards, strictly validated (unified
  QA+security).** Assertions are a CLOSED union of named guard kinds -
  `table-empty`, `no-nulls`, `no-duplicates` - with STRICT runtime
  validation (exact own-key sets, exact enums/booleans, canonical lowercase
  identifiers) enforced BEFORE digest AND before execution. The runner
  GENERATES the guard SQL from fixed templates with fully-qualified
  relations and pg_catalog functions; no caller SQL, expressions, functions
  or subqueries are representable. Guards HARD-FAIL inside the runner
  transaction (never silent-skip); table locks and the xact advisory lock
  are likewise declared structured fields executed BY THE RUNNER.
  Primitive declarations are digest-covered.
- **Versioned, forward-only migrations.** Registry `MIGRATIONS` is strictly
  sequential (`0001`, `0002`, ...). Applied history must be an exact registry
  prefix with exact version+name+digest equality (`verifyHistoryPrefix`).
- **One leased client per run, one session advisory lock.** Session-level
  `pg_advisory_lock(841000001)` held across bootstrap + all steps; concurrent
  runners serialize and the loser no-ops.
- **Runner-owned per-step transaction.** BEGIN, primitives, artifact
  statements, version INSERT in the SAME transaction (plain INSERT - a
  collision is a loud unique-violation failure), COMMIT; any failure rolls
  the whole step back; transactional
  DDL means partial step DDL never persists.
- **Explicit invocation only, closed CLI, BUILT entrypoint (SA4).** Schema
  changes run as a separate release job, never at web boot:
  `pnpm --filter @contake/api migrate:release -- --deployment staging|production --expect-host <host> --expect-db <db> [--database-url <direct>] [--by <actor>] [--ack ack:<nonce>:<listDigest>] [--expect-instance-id <id>] [--expect-registry-digest <digest>]`
  ONE canonical gated entrypoint: `migrate:release` invokes the BUILT
  artifact `node dist/migrations/migrate-cli.js` (SA4 - compiled by the
  package build; the ungated cli.ts and the source-invoked scripts/*.mts
  are deleted; no tsx/ts-node/source invocation remains on the release
  path). The closed parser rejects unknown/duplicate/bare/missing flags;
  exactly ONE URL source (`--database-url` XOR `DATABASE_URL`); the direct
  endpoint is asserted (`-pooler` refused) and the operator's expected
  `--expect-host`/`--expect-db` tuple must match the URL BEFORE any
  connection AND the connected `current_database()` BEFORE any issuance.
  Without `--ack` the CLI runs the canonical preflight ISSUANCE (minting +
  persisting the unique nonce bound to target + deployment + plan +
  listDigest), prints it, and exits 75 without executing; with `--ack` the
  runner re-verifies the ack against the persisted record under the step
  locks and consumes it atomically with the gated plan (absent-record /
  wrong-target / plan-mismatch / stale / consumed / invalidated all fail
  closed; any abort invalidates the ack). DIRTY/INDETERMINATE is claimed
  ONLY after the marker write is committed AND read back verified (SA4):
  an unverifiable marker is an UNPROVEN-DIRTY hard stop retaining all
  failures + attempt evidence, blocking pending attended recovery.
  `--resolve-dirty '<note>'` performs attended resolution.
- **Pre-mutation target binding.** `verifyTargetPreconditions` (deployment
  label + optional `--expect-instance-id` pin) runs READ-ONLY before any
  write; the first-run stamp is printed as an operator-attended TOFU gate,
  never authentication. First-run TOFU REQUIRES an omitted pin: a fresh
  database plus a supplied instance id is REFUSED before any write (zero
  writes verified). Later runs presenting a different deployment label or
  pinned instance are refused.
- **Startup verifies, never mutates.** EVERY Postgres boot - production,
  staging, dev - requires `CONTAKE_DEPLOYMENT` AND `CONTAKE_DB_INSTANCE_ID`
  (the 16-hex instance stamp verified out-of-band at the operator TOFU
  gate); `requiredBootIdentity` fails closed without either, and
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
  assertions: [                                 // runner-GENERATED named guards; ANY violation hard-fails + rolls back
    { kind: 'no-duplicates', table: 'users', column: 'phone', normalize: 'btrim' },
    // further guards use the same closed union (table-empty / no-nulls / no-duplicates)
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
    AND symlinks); fsync the directory - a failed directory fsync after the
    link raises an explicit INDETERMINATE-publication error naming the file
    (it exists; durability unconfirmed; reconcile before relying); temp
    unlink failure is reported explicitly after a successful publish; the
    post-cleanup directory fsync runs and its failure is likewise reported
    explicitly (temp-removal durability unconfirmed).

## Behavior change shipped with this architecture

The Postgres boot no longer applies the demo/camp-demo seeds or the QA staging
slice, and no longer runs bootstrap DDL; it requires CONTAKE_DEPLOYMENT and
CONTAKE_DB_INSTANCE_ID and verifies the stamped identity. Memory-adapter dev/test seeding is unchanged.
Existing Postgres deployments adopt the runner by one explicit
`migrate:release --database-url <direct> --deployment <label> [--ack ...]`
run (no-op baseline), after which boots pass the gate. Rebuild path for
staging = migrate + `seed:staging`; no local `pg_dump` bootstrap.

## R2 canonical boundary standard (trust-head ruling R2, 2026-09-18)

Structural correction inside the existing v1.5 scope (snapshot-diff retained
under the bounded-universe contract):

1. Canonical serialization: ONE jsonb_build_object per catalog row with
   explicit per-catalog column lists; the diff compares a sorted multiset of
   per-row sha256 hashes. Delimiter concatenation cannot exist under per-row
   JSON. Identity keys are fully-qualified NAMES; OIDs are used only inside
   one snapshot for joins.
2. Statement-kind x catalog matrix (STATEMENT_CATALOG_MATRIX): every
   gate-accepted statement kind maps to the catalogs it may write. Diff scope
   = union(matrix writable catalogs) + the NEVER-TOUCH set, in which ANY
   delta (add, drop, OR alteration of a pre-existing object) is a hard fail:
   pg_proc (body, prokind, prolang, provolatile, resolved args, owner,
   proacl, config), pg_trigger, pg_rewrite, pg_operator (operand types,
   resolved oprcode), pg_opclass (opcintype/opcmethod), pg_cast
   (castcontext/castmethod, INCLUDING castfunc=0 inout casts), pg_extension,
   pg_event_trigger, pg_policy (polroles/polcmd/permissive), pg_default_acl,
   pg_db_role_setting (database/role name-resolved, setconfig sorted jsonb),
   pg_description for every securable class (COMMENT drift is security
   drift - COMMENT is removed from the gate), ownership/ACL on pre-existing
   objects, sequence values. Maintenance rule: adding a gate statement kind
   REQUIRES a matrix + diff-scope update in the same change.
3. Sequences: last_value/is_called exact text end to end (no JS Number -
   >2^53 proven on unit + real PG); restoration restores both fields exactly
   and its errors PROPAGATE. ERR-PROPAGATE invariant: any error in snapshot,
   diff, or restore aborts + rolls back + hard-fails.
4. Extensions: the fixed-name denylist is DELETED. The extension set
   (name+version) is pinned to contake_db_identity.ext_baseline at bootstrap
   TOFU and every later run must find it byte-identical (one-time adoption
   path for pre-R2 deployments).
5. Attack matrix (ruling §4): per-class plant-and-catch with OBSERVED
   ARTIFACTS (the actual violation text naming the attacked object, the
   raised trigger error, the sequence row) - pre-existing-object alterations
   (OR REPLACE body swap, ALTER FUNCTION SET search_path, GRANT ON FUNCTION,
   COMMENT ON, ALTER DATABASE/ROLE SET, policy mutation, default-ACL plant,
   ownership change), in-transaction trigger ACTUALLY FIRED then rolled back
   to non-existence, >2^53 sequence crossing, in-transaction AND post-commit
   attempts. Unit suite + real-PG phase4 (36 checks, 33 observed artifacts).
6. Defense in depth (ruling §6): the migration bootstrap issues ALTER
   DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC for the
   migration role (recorded in the identity row); the boot gate asserts this
   default-privilege state on every boot and refuses to boot on tamper. A
   surviving code object is uncallable by any role - the SECURITY INVOKER
   trigger path dies with it (proven on real PG: runtime role gets
   permission denied calling a migration-role function).

## CTL-DDL-CONFINEMENT addendum (trust-head ruling, 2026-09-18)

Binding ruling conditions, mapped to controls (all proven on real Postgres 14
in evidence phase4, and in the unit suite):

1. ONE transaction per governed operation; every non-transactional class is
   rejected at artifact validation BEFORE execution: CREATE/DROP INDEX
   CONCURRENTLY, VACUUM, ALTER SYSTEM, CREATE/DROP DATABASE, REINDEX
   CONCURRENTLY, CALL, DO (and SECURITY DEFINER functions).
2. The catalog diff runs BEFORE COMMIT inside the same step transaction, so
   a violating step rolls back its own artifacts and the object together.
3. Diff coverage is ruling-complete: pg_proc (incl. prosecdef), pg_trigger,
   pg_rewrite, pg_operator, pg_opclass, pg_cast, pg_extension,
   pg_event_trigger, pg_policy, pg_default_acl, pg_db_role_setting,
   relacl/nspacl, ownership changes, and sequence values. Completeness is an
   acceptance criterion: the unit suite plants one object per class and
   requires detection.
4. The extension baseline refuses side-effect mechanisms (dblink,
   postgres_fdw, file_fdw, plpython*) at runner bootstrap: a database
   carrying one is refused before any step runs (phase4 proves the live gate
   with a real dblink install).
5. Named attack proven: a SECURITY DEFINER trigger function planted under
   the migration role is caught by the in-tx diff, rolled back, and does NOT
   survive to fire under a runtime-role INSERT; the post-rollback catalog
   equals the pre-migration catalog EXACTLY (byte-for-byte canonical
   serialization).
6. Sequence values are non-transactional (rollback never restores them), so
   the runner captures per-sequence (last_value, is_called) before each step
   and ACTIVELY RESTORES any drifted value after ROLLBACK, then hard-fails
   with the original error. Both detection and restoration are verified.

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

## R3 closed-template execution contract (trust-head ruling R3, 2026-09-18)

R3 is the binding fresh-qualification architecture for migration execution
(ruling sha256 begins 476d455a). It replaces the artifact-SQL boundary
entirely; the R2 canonical diff survives only at secondary scope.

1. Runner-owned closed template registry (`TEMPLATES` in runner.ts). A
   migration step is INERT DATA: {version, name, description, template,
   params, assertions?, lockTables?, xactLockKey?}. There is no caller SQL
   anywhere - the AST allowlist machinery (parser, canonicalizer, relation
   qualifier, expression closer) is DELETED, not refactored. Unknown
   template names refuse fail-closed.
2. Parameter discipline: identifiers must match a strict canonical shape
   (pg_ prefixes, quotes, semicolons and schema paths rejected); literals
   are bound parameters, never interpolated; enums are closed sets;
   expressions exist only as NAMED registry forms (EXPR_NORM_PHONE =
   btrim(phone); PRED_PHONE_NOT_NULL = phone IS NOT NULL) so expression
   indexes are covered without free text. Param key sets must match the
   template schema exactly.
3. Identity: templateHash pins sha256(template name + render source + param
   schema); zero-param templates additionally pin their exact rendered
   bytes. stepDigest v7 binds version + name + template + templateHash +
   canonical params - tampered params or tampered registry render source
   move every digest (registry/artifact tamper refusal).
4. General DML is removed. The staging synthetic seed uses a separate
   closed DATA template family (`DATA_TEMPLATES` in staging-seed.ts):
   frozen per-table INSERT ... ON CONFLICT forms with bound literals,
   module-load integrity proof, and a pinned registry fingerprint
   (DATA_REGISTRY_SHA256) bound into the staging inventory. Staging stamp,
   dirty refusal and absence proofs are preserved.
5. The frozen 0001 baseline runs through template init.schema-baseline.0001:
   runner-owned GRAPH_DDL/OTP_DDL text, qualified to the controlled schema
   by a closed-form module-load rewrite (three permitted shapes; any
   deviation fails closed at load) because the migration session pins
   search_path EMPTY and no AST exists.
6. The catalog diff is demoted to a SECONDARY tripwire: zero-delta on the
   never-touch executable/security classes plus environment-tamper
   detection. No PASS rests on its completeness; its residual
   column-enumeration incompleteness is accepted and recorded (security's
   R2 COST/STRICT/PARALLEL SAFE finding).
7. Capability growth happens ONLY by adding a reviewed template to the
   registry. There is no artifact-level escape hatch: non-transactional
   classes (CONCURRENTLY/VACUUM/ALTER SYSTEM/CREATE+DROP DATABASE/REINDEX/
   CALL/DO/SECURITY DEFINER) and code objects (trigger/cast/operator/rule/
   policy/event trigger) cannot exist by construction - proven by a
   full-registry render sweep on unit and real PG.
8. Carried boundary-independent invariants (R1/R2, unchanged): one
   transaction per governed operation; deployment+instance pinning (TOFU
   then pin) verified BEFORE any write; boot gates fail closed on every PG
   boot with REAL-PG tamper proofs (history, default ACLs, pinned extension
   baseline); least-privilege roles with search_path hygiene; sequence
   values exact text end-to-end with active restore, ERR-PROPAGATE,
   restore-failure injection and explicit DIRTY/INDETERMINATE labeling
   (a sequence that vanished since capture is an explicit restore failure,
   never a silent skip); migration-role default privileges revoke PUBLIC
   EXECUTE, asserted at boot; observed-artifact evidence standard;
   SHA256SUMS + commit records + no-clobber archive.

### R3 evidence

- `apps/api/tests/release-migrations.test.ts` (30 tests): the R3 gate suite
  (renders, typed-param injection per class, unknown template, registry/
  artifact tamper digests, code-object impossibility sweep, non-tx
  impossibility sweep, sequence helper proofs incl. restore-failure
  injection, catalog-diff tripwire, R2 attack matrix) plus the runner
  suite (boot gate, adoption, pin binding, forward-only, history tamper,
  param-edit tamper, failing-template rollback, foreign-history refusal,
  guard rollback, SA-shaped template step, registry validation, role
  separation).
- `apps/api/evidence-realpg-release-migrations.mts` phases 1-4 on real
  PostgreSQL 14: full run + race + failing-template rollback + closed-
  registry registration refusals + guard rollback + TOFU/pin refusals +
  seed (DATA family) transaction/rerun/drift/rollback; REAL restart
  durability; least-privilege roles + R3 section-5 attacks (13 typed-param/
  caller-SQL refusals with OBSERVED text) + param/render tamper digests +
  boot-gate history tamper proof; CTL-DDL-CONFINEMENT: construction-
  impossibility sweep, secdef-trigger plant, dblink baseline refusal,
  sequence restore contract (capture/drift/restore/PROPAGATING failure),
  >2^53 exactness, pre-existing-object alteration matrix, default-privilege
  lockdown.

## R4 minimal integrity correction (trust-head ruling R4, 2026-09-18)

R4 is the binding correction inside R3: self-consistency is not authenticity,
so every digest check names its anchor. The R3 closed-template contract is
unchanged in shape; what changes is where the registry lives and what a digest
is anchored to.

1. The template registry, named forms, and all render capability are
   module-private and deeply frozen at load. Nothing outside the runner module
   can read, replace, or mutate a template or a named form; no rendered SQL
   leaves the module. The only exported integrity surfaces are
   `REGISTRY_DIGEST` (a hash, for reviewer recording) and
   `assertSingleStatementForms` (a pure assertion over caller-supplied forms).
   The staging DATA registry follows the same confinement with
   `DATA_REGISTRY_DIGEST`.
2. ONE canonical `REGISTRY_DIGEST` over the full frozen blueprint (template
   identities, parameter schemas, render source, named forms, zero-param
   rendered bytes); every v8 step digest derives from it. The seed side has
   one canonical `DATA_REGISTRY_DIGEST` over the full frozen DATA blueprint.
3. Two trust anchors: anchor A - the reviewer records the expected digest
   from reviewed source; anchor B - the database anchors the digest at the
   first pinned governed run (`contake_db_identity.registry_digest`) and at
   boot. Any later run or boot compares the anchored digest and refuses drift
   with the observed mismatch; a missing anchor (pre-R4 database) is adopted
   by exactly one governed run while the boot gate refuses until then. The
   seed persists and compares `staging_seed_state.data_registry_digest` on
   every rerun - DATA drift refuses even when every row is byte-identical.
4. The parser dependency is removed (`pgsql-ast-parser` deleted from the
   manifest and lockfile; the runner header rewritten). Single-statement
   construction is guaranteed by a load-time assertion over every template
   shape (rendered with schema-valid sample params) and every named form; a
   statement separator refuses the module at load. Statements are
   identifier-only structure with bound literals, executed as one driver call.
5. The authenticity chain is explicit: source-head SHA, frozen lockfile,
   clean literal-blueprint build, dist hashes, instance pin, DB anchor. The
   in-process freeze covers runtime mutation; loader/build tamper is caught
   by the named chain outside the process.

### R4 evidence

- `apps/api/tests/release-migrations.test.ts` (31 tests): the R4 gate suite -
  catalog-observed SA index (exact pg_indexes indexdef), runner-driven
  registration refusals for every parameter-injection class, export-surface
  impossibility (registry/named forms/render resolve to undefined; module
  namespace immutable), load-time separator refusal with OBSERVED text,
  anchor B unit proofs (pin, tamper refusal at run AND boot with observed
  mismatch, restore, NULL adoption) - plus the runner suite unchanged.
- `apps/api/tests/staging-seed.test.ts` (18 tests): adds the DATA anchor
  proofs - pinned at first seed, drift refusal with identical rows (OBSERVED),
  restore, NULL adoption.
- `apps/api/evidence-realpg-release-migrations.mts` phases 1-4 on real
  PostgreSQL 14 (122 checks): R3 coverage plus anchor A surface recording,
  confined-surface proofs, named-form tamper load refusal, anchor B tamper
  refusal at run AND boot on real PG, and DATA anchor drift with identical
  rows after a REAL cluster restart.

## R5 inert blueprint (trust-head ruling R5, 2026-09-18)

R5 is the binding bounded correction under R3+R4. Root cause of the R4 FAIL:
the R4 digest hashed render-closure source (`Function.toString()`), which is
toolchain-dependent - security proved a three-way divergence (source/tsx,
tsc dist, vitest) while the pure-data DATA digest stayed stable everywhere.

1. The registry is inert canonical data: statement shape strings with named
   `{param}` placeholders, data parameter declarations (identifier quoting,
   enum value sets with fragment maps, named-form references with empty/
   non-empty fragment patterns), named expression/predicate forms, and
   per-template canonical sample vectors. ZERO function closures exist in
   the blueprint. Rendering is ONE runner-private assembly mechanism over
   that data; the bind helpers are module-private.
2. REGISTRY_DIGEST = sha256 over the canonical JSON of the blueprint data
   ONLY - nothing executable-as-text, nothing build-derived, no
   Function.toString anywhere. One identical value across source/tsx, tsc
   dist, vitest, and the real-PG run; divergence in any context is an
   automatic FAIL. Reviewers recompute the expected digest from reviewed
   source (anchor A); anchor B (first pinned governed run, compare on every
   run and boot, drift refuses) is unchanged.
3. Legacy NULL adoption of the registry anchor or the extension baseline
   writes NOTHING without BOTH operator pins (expect-instance-id AND
   expect-registry-digest); unpinned adoption refuses with the observed
   refusal. A wrong registry-digest pin refuses BEFORE any write.
4. Real-PG evidence executes the BUILT DIST artifacts. The evidence pack
   names the chain: exact head SHA, lockfile hash, literal build log, dist
   hashes, runtime pin.
5. Carried real-PG proofs closed: default-ACL boot tamper (refuse + heal),
   in-transaction trigger firing with the observed effect + byte-identical
   post-rollback catalog, unpinned-adoption refusal with nothing written,
   dual-pinned adoption. R3/R4 matrices stand unchanged.

### R5 evidence

- `apps/api/tests/release-migrations.test.ts` (31 tests): R4 suite carried,
  with pin-hardened adoption (unpinned refusal writes nothing, wrong pins
  refuse, dual pins adopt) and type-confusion driven through the runner
  (bind helpers private, proven on the confined surface).
- `apps/api/evidence-realpg-release-migrations.mts` phases 1-4 run against
  `dist/` (module under evidence printed per phase): 133 checks, adds the
  R5 set - wrong-pin refusal, dual-pin pass, unpinned NULL adoption refusal
  with nothing written, dual-pinned adoption, default-ACL boot tamper with
  restore, in-transaction trigger firing with observed effect.
- Four-context digest proof: source/tsx, tsc dist (node), vitest, and the
  real-PG dist run all record the identical REGISTRY_DIGEST and
  DATA_REGISTRY_DIGEST (values in COMMIT-RECORD).
