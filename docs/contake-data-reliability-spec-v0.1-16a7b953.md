# Contake Alpha - data reliability specification and QA evidence plan v0.1

Status: proposal only. No contracts, migrations, production data, or runtime state changed.
Evidence base: `cdnwic/contake-pilot` at `a32d1c0` on 2026-09-17, plus Quality Constitution v1.1. Repository: https://github.com/cdnwic/contake-pilot

## 1. Current-state findings

- The repository abstraction has atomic units (`runInTx`, with checkpoint fallback), compare-and-set event/task operations, write-once report resolution and notification acknowledgement, report dedupe by `clientReportId`, notification dedupe by `idempotencyKey`, and serialized whitelist transitions.
- Idempotency is not yet a uniform API property. Most mutating routes accept no client idempotency key. Existing dedupe is endpoint-specific.
- Current deletes of events, tasks, dependencies, and push subscriptions are hard deletes. There is no tombstone contract or retention worker.
- Audit is append-only only at the repository interface level. Postgres stores `seq`, `org_id`, and mutable JSON without a cryptographic chain; memory stores an array. Neither adapter can prove that rows were not altered or removed outside the interface.
- Postgres has indexes, not unique constraints, on `reports.client_report_id` and `notification_jobs.idempotency_key`; application checks alone do not provide a database-enforced global uniqueness guarantee under concurrency.
- Free-tier memory mode has no durable recovery source. A restart loses all mutations and the audit trail since process start.

## 2. Uniform idempotency-key proposal

### 2.1 Wire rule

Every effectful request must carry `Idempotency-Key` (UUIDv4 or ULID, 16-128 printable ASCII chars). Exclusions: safe reads, `/v1/domino/compute` dry-run, whitelist-check, and failed authentication before any effect. TL owns the contract change.

Canonical scope:

`(org_id, authenticated_actor_id, HTTP method, normalized route template, idempotency_key)`

For unauthenticated auth operations, replace org/actor with a privacy-preserving subject scope: `HMAC(server_secret, normalized phone-or-email)`. Never store raw OTPs, tokens, phone numbers, or passwords in the ledger.

Store:

- request hash over canonical route params + canonical JSON body + content type;
- state: `in_progress | committed | failed_retryable`;
- status code and exact safe response envelope, or a result-resource pointer;
- created/committed/expiry timestamps;
- owner org/actor and trace ID.

Semantics:

1. First request claims the key atomically with the domain mutation and success audit.
2. Same key + same request hash after commit replays the original status/body and emits no new mutation, audit row, notification, or realtime frame.
3. Same key + different hash returns `409 IDEMPOTENCY_KEY_REUSED` and has no effect.
4. Concurrent duplicate while `in_progress` waits briefly for the winner, then replays; if bounded wait expires, return `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After`.
5. A transaction rollback must roll back both domain effect and key claim, or mark it retryable in the same durable unit. Never cache a 5xx produced before commit.
6. Response replay must not mint fresh access/refresh credentials. Auth endpoints should store an outcome pointer and re-issue only under explicit auth semantics, or be separately specified by TL/security.
7. Retain keys for 7 days after commit in Alpha. This covers long offline queues and delayed retries. The value is proposed, not ratified; reduce only with observed maximum offline age and QA approval.

### 2.2 Endpoint classes

- Create/duplicate: whitelist invite, push subscription upsert, event create/duplicate, task/resource/dependency create, report create. Client-generated business IDs remain useful, but the uniform key guards all side effects.
- Update/transition: whitelist approve/reject/register, event/task/resource patch, publish, change approve/reject, report resolve, notification ack.
- Delete: push subscription, event/task/resource/dependency delete. A replay must return the original successful result, not a later 404.
- Auth side effects: OTP request and verify require a security-specific idempotency policy so retries cannot send multiple messages or consume a challenge twice. Login/refresh need explicit token-replay handling before inclusion.
- Existing business dedupe keys remain invariants: `clientReportId`, notification `idempotencyKey`, endpoint ownership for push, phone transition serialization for whitelist. The API key does not replace them.

### 2.3 Required storage constraints when durable mode is approved

- Unique idempotency-ledger scope key.
- Unique report business key at its true tenant/producer scope, not a non-unique index.
- Unique notification idempotency key at its true tenant scope.
- All constraints and domain write in one transaction.

## 3. Tombstones, retention, and anonymize-on-delete

### 3.1 Lifecycle

`active -> deleted (tombstone) -> anonymized -> purged`

A tombstone contains only stable ID, org ID, entity type, parent/event ID where needed for referential history, `deletedAt`, `deletedBy`, reason code, version, and `purgeAfter`. Normal reads exclude tombstones; privileged audit/recovery reads opt in. Mutations against a tombstone return `410 GONE`, and creation must not silently reuse its ID.

Suggested Alpha windows, pending product/privacy approval:

- domain entity recovery window: 30 days;
- idempotency ledger: 7 days after commit;
- transient dispatch payloads: 7 days after terminal delivery state;
- audit: 365 days minimum, with legal/privacy signoff before adopting this as policy.

No retention promise is enforceable in memory mode across restart.

### 3.2 Delete ordering

1. Authorize and tenant-scope the target.
2. In one atomic unit, write tombstone/version, detach it from active graph queries, cancel future jobs, and append the delete audit record.
3. Publish realtime/notification effects only after commit.
4. During the recovery window, restore is a new audited mutation and must validate parent existence, uniqueness, hard constraints, and current authorization.
5. At expiry, the purge worker anonymizes before physical removal and records a purge receipt with counts, policy version, and run ID. It must be restartable and idempotent.

### 3.3 Anonymize-on-delete

- Users: erase name, email, phone, password hash, OTP material, push endpoints/keys, free-text notes, and external channel addresses; replace actor references with an org-scoped irreversible pseudonym such as `deleted-user:<HMAC>`. Disable login immediately.
- Event/field data: remove free text and attachment pointers that may contain PII; retain only non-identifying structural fields needed for integrity or aggregate metrics.
- Audit: preserve event/action/time and pseudonymous actor continuity. Replace `beforeJson`/`afterJson` with a schema-aware redacted snapshot or encrypted blob whose per-subject key can be destroyed. Raw JSON snapshots currently make anonymization incomplete.
- Backups/replicas: erasure policy must state propagation delay and key-destruction behavior. Current memory mode has no backup copies, but also no durable audit evidence.
- Tenant isolation: purge jobs must always bind org ID and entity ID. Cross-org scans require QA proof and per-org receipts.

## 4. Honest RPO/RTO for current free-tier memory mode

For recovery of user-created state and audit history:

- **Guaranteed RPO: unbounded (`infinity`)**. Numerically, loss can be **100% of all mutations since the process was seeded/started**. If the process has run for N hours, the recovery point can be N hours old. There is no finite worst-case bound.
- **Guaranteed RTO: unbounded (`infinity`)** for restoring lost user-created state, because there is no backup, write-ahead log, or replay source. The service may restart to seeded demo state, but that is reinitialization, not recovery.
- **Measured service-restart RTO: not established**. Do not publish a numeric availability RTO until repeated restart drills measure deploy detection, spin-up, health, and client recovery.

Therefore memory mode is acceptable only for disposable demos whose operators accept total loss. It is No-Go for a paying/live pilot or any claim of durable auditability. This matches the standing free-tier decision rather than weakening it: the cost is deferred, and the recovery limit stays explicit.

## 5. Audit-log integrity suite for independent QA

Run every test against memory and Postgres adapters where applicable. Postgres tests must use a real database and at least two connections.

### A. Coverage and atomicity

- Enumerate every effectful route. One committed mutation produces exactly one correct success audit unless the contract explicitly defines a compound change; duplicates replay with zero extra rows.
- Inject audit append failure at each mutation family. Assert domain write, idempotency claim, jobs, and audit all roll back.
- Inject domain failure after attempted audit. Assert neither survives.
- Assert realtime frames and notification dispatch occur only after commit and never on rollback.

### B. Shape and truth

- Validate actor, role, org, event, action, entity type/ID, timestamp, device class, outcome, denial reason, and change-request linkage.
- Parse before/after JSON and compare it to independently read pre/post state. Verify secrets and subscriber/push credentials never appear.
- Verify deletes carry a redacted before image and tombstone after image after the new design lands.

### C. Authorization and isolation

- Each authenticated authorization denial on a mutating route creates exactly one denied row and no domain effect.
- 401s, safe reads, and dry-run exclusions create none.
- Audit list/read and purge paths cannot return or alter another org's rows, including forged IDs and actor claims.
- An anonymized subject is unlinkable across orgs but stable within the org where continuity is required.

### D. Concurrency, retry, and ordering

- 50-100 simultaneous identical keys: one effect, one success audit, identical replay response.
- Same key with divergent bodies: one winner; all divergent attempts get 409; no extra audit/effects.
- Race approve/reject, resolve/resolve, ack/ack, patch/delete, and delete/delete. Assert one legal final state, complete audit ordering, no impossible before/after chain.
- Disconnect client after commit but before response, then retry: exact replay, no duplicate effects.
- Out-of-order offline queue delivery preserves declared conflict/version rules and produces an explainable trail.

### E. Tamper evidence and append-only enforcement

Current adapters cannot pass strong tamper-evidence tests. Mark these expected failures until designed:

- Database role used by the app cannot UPDATE/DELETE audit rows.
- Hash-chain validation (`prevHash`, canonical record hash, periodic signed checkpoint) detects row edit, deletion, insertion, and reorder.
- Restart preserves sequence monotonicity and chain continuity.
- Export + independent verifier reproduces the checkpoint.

Interface-only append behavior is not sufficient evidence because direct DB access can alter JSON/rows. Independent QA should block any claim of tamper-evident audit until these tests pass.

### F. Retention/anonymization/recovery

- Advance a fake clock across each lifecycle boundary; verify active visibility, 410 behavior, restore checks, anonymization, final purge, and receipts.
- Crash/restart the purge worker after every batch boundary; rerun without duplicate receipts or cross-tenant effects.
- Verify all PII surfaces, including audit snapshots, jobs, channels, subscriptions, exports, logs, and attachments.
- Memory-mode restart drill must visibly demonstrate total post-seed loss and record actual restart timing without calling it data recovery.

## 6. Release gates tied to the Quality Constitution

No-Go if any of the following is missing: route inventory proving full idempotency coverage; concurrency/retry evidence; tenant isolation proof; schema-aware erasure proof; audit atomicity proof; tested restore/purge behavior; candid RPO/RTO statement; independent QA signature. Known expected failures must remain explicit, not relabeled as passed.
