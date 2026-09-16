# E2E plan: Content-in-Context (proposal, pending contract)

**Status:** PROPOSAL from integration/E2E. No Content-in-Context data model, API
surface, or RBAC rows exist in the repo as of 2026-09-17 (verified: only generic
mentions in docs/qa-charter.md + docs/deploy-prep.md). Every scenario below is
labeled PENDING-CONTRACT and must be aligned to the TL's contract sections before
implementation, per the same rule we apply to v1.19 §17/§19: a spec is a decision,
not proof of deployment.

## Provenance (verified in observations, WhatsApp 2026-09-17 02:13-02:15 IDT)

- Founder (user, +972587700852, 02:13:40): everything a person needs for the work
  lives inside Contake - day plan, script, story; a manager pastes a YouTube link
  and the counselor sees the video link in Focus Mode exactly when needed.
- Founder (02:15:01): not every task needs a script and not in every profile, but
  it is right to build this in.
- Consolidated direction in the same exchange (tiered model): (1) simple task =
  title, time, owner, done action - nothing else; (2) task with material = attach
  only what's needed: link, checklist, equipment, file; (3) guided process = full
  script, steps, content, forms when truly needed. Each profile decides relevant
  content types; the manager chooses whether to attach. Camp: story or video.
  Logistics: equipment list + address. Production: call sheet / shot list. Many
  tasks will have no extra content. The principle is not "every task has a script"
  but "everything needed to do the task can be there, exactly when needed" - as
  long as the default stays light and simple.
- Founder steering via TL/parent (02:15): Content-in-Context is not only UI; it
  must land across UX, data model, APIs, permissions, timing/versioning, domino
  rescheduling/reassignment, offline/sync, audit, tenant isolation and QA, at
  Alpha level. Alpha core end-to-end for text, links, checklist, equipment and a
  simple form in Builder and Focus Mode. File blobs may stay blocked on the
  storage/Postgres decision, but architecture and UX must not fake them as
  static screen content. Alpha is not ready if this exists only in design.
  Progressive disclosure preserved: simple tasks remain simple.

## Acceptance anchor (from the exchange)

Manager builds an activity with story + video + equipment; the counselor receives
them on time in Focus Mode; a schedule change then moves the whole work package
correctly. If that does not work end-to-end, the direction does not pass.

## Scenario matrix (PENDING-CONTRACT)

### A. API contract + data model (staging, sacrificial zz-qa- events)
- C-A1..A5: CRUD lifecycle per Alpha content type (text, link, checklist,
  equipment, simple form) attached to a task: create/read/update/delete, shape
  and required-field validation, Hebrew + English values (v1.19 i18n).
- C-A6: content is versioned with the task graph: optimistic-version PATCH rules
  apply to content edits (409 on stale version), consistent with existing
  timing/versioning behavior.
- C-A7: content delete detaches without breaking the task; task delete cascades
  content per the delete lifecycle in force (hard delete today; tombstone §18
  pending founder approval - content tests must track whichever lands).
- C-A8: profile config: each vertical profile declares relevant content types;
  attaching a type the profile excludes follows the contract outcome (reject or
  allow - assert whichever the contract pins, per vertical).

### B. Domino / timing
- C-B1: the acceptance anchor, API level: build chain story+video+equipment on a
  downstream task; move the upstream task; assert the cascade moves the content-
  bearing task and the content stays attached with correct times (content follows
  the work package, nothing stranded).
- C-B2: reassignment: moving a task between sites/managers keeps content attached
  and visible to the new responsible role per permissions.

### C. Permissions + tenant isolation (extends rbac-matrix.mjs pattern)
- C-C1: role x content-action rows once the matrix lands (expect admin allow,
  field_manager scope-gated, focus_worker read/consume in Focus Mode, no edit) -
  full role x route denial matrix including the new content routes.
- C-C2: tenant isolation: org B cannot read/attach/reference org A content (404,
  no existence leak), same point-check pattern as dispatch-evidence.

### D. Audit
- C-D1: every content mutation appends an ordered audit row with actor, role,
  before/after truth (one create + one update row, per the QA-narrowed audit
  scope pattern).
- C-D2: redaction scan extended: content bodies (free text, form answers) are
  scanned by the configured-canary redaction suite; no secrets in audit rows.

### E. Offline / sync (Playwright - BLOCKED on FE repo access, standing request)
- C-E1: focus worker consumes content offline (read-ahead cache), check off
  checklist items offline, sync on reconnect with clientReportId-class dedupe.
- C-E2: conflict case: manager edits content while worker is offline; version
  rules resolve per contract; worker never sees a torn half-updated package.
- C-E3: weak-network: content load degraded states are honest (no fake static
  content standing in for blobs; file/blob surfaces show the real blocked state
  while the storage/Postgres decision is pending).

### F. Bilingual + progressive disclosure
- C-F1: he-IL RTL and en-US LTR rendering of every content type in Builder and
  Focus Mode (extends the bilingual skeleton L1-L10).
- C-F2: progressive disclosure invariant: a task with no content renders exactly
  as today (simple stays simple); adding one link changes only the attachment
  affordance, never the base task layout.
- C-F3: per-vertical demo path: camp (story+video), logistics (equipment list +
  address), production (call sheet / shot list) - the founder's own examples as
  executable journeys.

### G. QA / release integration
- C-G1: new content routes join the route-inventory assertion (§17
  classification: content mutations are effectful -> ledger required when it
  lands; classified in the manifest from day one).
- C-G2: six-vertical domino regression extends with content-bearing chains.
- C-G3: demo freeze rule: Thursday demo build stays frozen; content scenarios
  run on staging only, zz-qa- prefix, create+delete in-session.

## What I need from TL to start
1. Contract sections for the content entity (shape, versioning, delete
   semantics, profile config, RBAC matrix rows v1.5+).
2. Route surface (expected: content CRUD under events/tasks + Focus Mode reads).
3. Decision how form/checklist answers are modeled (submission entity vs task
   state) - affects audit and offline dedupe design.
4. FE repo access remains the standing blocker for E1-E3 and Playwright items.

## v1.20 alignment (§20 Content surface, §21 Builder authoring) — 2026-09-17

The v1.20 addendum formalizes the content surface (§20) and Builder authoring routes (§21) as
**DRAFT-for-review contracts** (Hebrew header: not for implementation before approval; additive-only
on v1.19). Harness: `scripts/e2e/builder-content-contract.mjs`.

Label discipline: every §20/§21 functional assertion is `CONTRACT-PENDING-UNEXECUTED` until approval
and deployment. The harness also hard-asserts the route manifest against `apps/api/src/app.ts`
(param-name normalized): deployed-existing routes today are `POST /v1/events` and
`PATCH /v1/tasks/:id`; all §21 days/tasks/resources/deps routes, org-scoped event create, and all
§20 content routes incl. `GET /v1/focus/now` are contract-new and currently absent from source.

Scenario mapping (C1-C8 → contract rows):
- C1/C6 (equipment/content attach) → §20 content.attach + §21 resourceKind `content`.
- C2 (Focus Mode progressive disclosure) → §20 `/v1/focus/now`: simple task returns
  `visibleResources: []` ALWAYS — disclosure is now contractual, not design intent.
- C4 (link attach) → §20; **file blobs are BLOCKED in Alpha** — file type is external-URL-only and
  is NOT exposed in Builder until infrastructure exists; no placeholder faking (founder 02:15).
- C5 (offline ack/checklist) → §20 offline: acks travel in the reports queue with `clientAckId`,
  idempotent per §17; last-step read cache. Playwright execution still needs FE repo access.
- C3/C8 (domino on content-bearing packages) → §21 PATCH triggers synchronous domino recompute,
  same impacted shape as report-originated recompute.
- §21 Builder flows (days, tasks with computedWindow, deps with 409+cyclePath, locked-task
  409 HARD_CONSTRAINT) become the Builder acceptance E2E the day the routes ship.

Recorded deltas to pin at implementation (status CONTRACT-DELTA):
1. `POST /v1/events` today accepts requests without Idempotency-Key; §21 locks the key mandatory
   (§17 hard gate). Proven live on a local memory server (run rmu4qgymf); already tracked by
   idempotency-contract.mjs (33 EXPECTED-FAIL rows).
2. Dependency cycle rejection today is 400 DEPENDENCY_CYCLE; §21 requires 409 with `cyclePath`.

§22 (external stakeholders, stub-only channels with `not_sent_transport_deferred` records) and
§23 (branches, read-only org matrix) are in the same addendum but outside the assigned §20-§21
track; §22's stub discipline directly addresses the PQM-5 G2/G3/G6 reality gaps once approved.
