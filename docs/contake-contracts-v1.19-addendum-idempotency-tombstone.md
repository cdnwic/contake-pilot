# Contracts v1.19 ADDENDUM — idempotency + tombstone lifecycle [TL decision record]
**Date:** 2026-09-17 | **Base:** v1.19 i18n drop-in (sha 95c705fe...) on v1.18 pinned
**Source spec:** contake-data-reliability-spec-v0.1 (specialist, 2026-09-17). Contract decisions below are MINE (TL); the spec's implementation detail stays backend's reference.

## Adopted into v1.19 (contract-level)

### 17. UNIFORM IDEMPOTENCY
```
 * v1.19 addendum (idempotency, ADDITIVE):
 *    Every effectful route accepts and honors header Idempotency-Key
 *    (16-128 printable ASCII; UUIDv4 or ULID recommended).
 *    Scope: (org_id, actor_id, method, route_template, key); unauthenticated
 *    auth routes scope by HMAC(server_secret, normalized subject) - never raw
 *    phone/email in the ledger.
 *    Semantics: atomic claim with the domain mutation + success audit;
 *    same key + same request hash => exact replay of original status/body,
 *    zero new mutation/audit/notification/realtime frame;
 *    same key + different hash => 409 IDEMPOTENCY_KEY_REUSED;
 *    concurrent in-progress => bounded wait then replay, else
 *    409 IDEMPOTENCY_IN_PROGRESS + Retry-After;
 *    rollback unwinds both domain effect and key claim; never cache pre-commit 5xx.
 *    Exclusions: safe reads, /v1/domino/compute dry-run, whitelist-check.
 *    Auth side-effect routes (OTP request/verify, login, refresh) are EXCLUDED
 *    from the general rule pending a security-specific policy (TL+security).
 *    Ledger retention: 7 days post-commit (proposed; ratify with retention batch).
 *    Replay of a deleted resource returns the ORIGINAL success, not a later 404.
 *    Existing business dedupe keys (clientReportId, notification idempotencyKey,
 *    push endpoint ownership, whitelist phone serialization) remain invariants.
```

### 18. TOMBSTONE DELETE LIFECYCLE  [PENDING FOUNDER APPROVAL - semantic amendment]
```
 *    DELETE becomes soft delete: active -> tombstone -> anonymized -> purged.
 *    Reads exclude tombstones; privileged audit/recovery reads opt in;
 *    mutation against a tombstone => 410 GONE; IDs never silently reused.
 *    Restore within the recovery window is a new audited mutation with full
 *    validation (parent existence, uniqueness, hard constraints, authorization).
 *    Delete ordering: authorize+scope; atomic unit writes tombstone, detaches
 *    from active graph, cancels future jobs, appends audit; realtime/notify
 *    only after commit. Purge worker anonymizes before physical removal,
 *    records restartable idempotent receipts, always org-bound.
```
This AMENDS the Sep-14 "DELETE version-less" record: the no-version-parameter rule stands; the change is hard-delete -> lifecycle. Because it is observable behavior change (410, restore), it rides on founder sign-off together with the retention windows below.

## Implementation requirements (no contract text; binding when Postgres lands)
- DB-enforced UNIQUE on idempotency-ledger scope key, on reports.clientReportId at tenant/producer scope, on notification_jobs.idempotency_key at tenant scope. Current indexes are NOT unique - application checks alone are insufficient under concurrency.
- Constraints and domain write in one transaction.
- Audit adapter cannot pass tamper-evidence today (interface-level append only): recorded as EXPECTED FAILURE in QA suite E; hash-chain + signed checkpoints go on the post-demo backlog, not v1.19.

## Founder decisions requested (batched, from spec §3.1 + §4)
1. Retention windows: domain restore 30d / idempotency ledger 7d / dispatch payloads 7d / audit 365d (legal-privacy signoff on audit window).
2. Soft-delete semantic amendment (section 18 above).
3. Postgres/persistence re-decision, armed with the honest numbers: memory mode = guaranteed RPO infinity (up to 100% of mutations lost), RTO infinity for user state; No-Go for any live/paying pilot or any durability claim. The specialist's wording: disposable-demo only.

## QA handoff
Spec section 5 (audit-log integrity suite A-F) goes to independent QA as-is; suite E failures are expected and must stay explicit, never relabeled.

---

## Addendum-2: section 19. READ-ONLY DELIVERIES SURFACE [v1.19, additive, post-demo sequencing]
(Added 2026-09-17 per QA dispatch roll-up: provider delivery/retry/receipt lifecycle is structurally untestable today - DispatchRecord has no HTTP surface. This closes the evidence gap; independently additive, not tied to the founder retention/soft-delete batch.)
```
 *    GET /v1/notifications/deliveries?eventId=&changeRequestId=&kind=
 *      -> DeliveryRecord[]: { jobId, kind, templateKey, params, targetType
 *         (in_app|external-masked), status, attempts, provider, terminalState,
 *         createdAt, lastAttemptAt, terminalAt }
 *    Matrix v1.5 row: notifications.deliveries.read = admin allow, scope=org,
 *      read-only, all other roles deny. Action count 31 -> 32.
 *    Privacy: NO provider payloads, NO message bodies beyond templateKey+params,
 *      external addresses masked (channel + last-2 only), in_app targets as userId.
 *    Audit: read itself is not audited (safe read); the surface exists so
 *      dispatch lifecycle is provable (QA dispatch suite).
```
Backend estimate: 0.5-1 day on the existing dispatch store. E2E then extends the dispatch harness to assert provider lifecycle against this surface.
