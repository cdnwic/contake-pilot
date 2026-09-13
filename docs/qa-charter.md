# Contake Alpha — Independent QA, Security & Product Assurance Charter
**Version 1.0 · 2026-09-11 · Owner: QA/Security workstream (independent) · Status: proposed for adoption**

## 0. Mandate
Independent quality, security and product assurance for Contake Alpha. I do not build features; I define what "correct" means, test against it, critique every artifact, and hold release gates. No build is called "ready" to Chaim until it passes the gate defined here. Grounding: Chaim's verbatim requirements (2026-09-11), the locked RBAC spec, the MVP framing doc, stage-0 camps doc, and prototype v2.

Product invariants that every test ultimately protects:
1. **One live source of truth** — the system never shows two actors conflicting versions of the schedule.
2. **The domino engine is the differentiator** — dependency-chain recalculation must be correct, deterministic and explainable. A wrong recalculation is worse than none.
3. **Hard constraints are sacred** — a locked task never moves automatically, under any input, any role, any code path.
4. **Authority matches impact** — approval requirement derives from impact class × role, enforced server-side only.
5. **Targeted communication** — only affected stakeholders are notified; no broadcast noise, no cross-tenant leakage.

---

## 1. Release gates

| Gate | Target | Meaning | Required to pass |
|------|--------|---------|------------------|
| **G0 — Foundations** | End week 1 | Contracts and infra locked | API contract + data model critiqued & signed off; test infra running in CI; seed fixtures for all 5 domain profiles; golden domino corpus implemented as executable tests |
| **G1 — First runnable** | ~Week 3 (the version Chaim can see) | Core happy path end-to-end on camps profile | All P0 E2E journeys pass (§6.1); zero Sev-1/Sev-2 open; domino engine passes 100% of golden corpus; RTL + responsive smoke pass |
| **G2 — Backend complete** | ~Week 5 | Engine, RBAC, audit fully enforced server-side | Full RBAC matrix test pass (§4); isolation suite pass (§5); failure-recovery suite pass (§8); audit-log suite pass (§9); security checklist (§10) |
| **G3 — Feature complete** | ~Week 9 | Focus Mode, domain profiles, notifications integrated | Notification suite on staging with real providers in sandbox mode (§7); all 5 domain profiles pass identical engine test suite; accessibility audit (§11); performance budgets met (§12) |
| **G4 — Release candidate** | Week 10 | Demo/pilot-ready | Full regression green; 0 open Sev-1/2, ≤3 open Sev-3 with workarounds; security review closed; demo env seeded and verified by scripted walkthrough; rollback tested |

Gate rules:
- A gate is passed by evidence (test reports, audit logs, screenshots), not by assertion.
- Any Sev-1 (correctness of schedule/domino/permissions/data leak) blocks all gates, always.
- Gate failure is reported with cause and re-entry criteria; no deadline pressure overrides a gate.
- I sign each gate in writing to the coordinator. Verbal/implied sign-off does not count.

---

## 2. Resource Graph correctness

Acceptance criteria (AC) and tests.

**AC-GRAPH-1 DAG integrity.** `depends_on` edges never form a cycle. Any API path (create, edit, bulk import, domino proposal application) that would create a cycle is rejected with a 4xx and a Hebrew error naming the cycle members. *Tests:* unit (cycle insertion of size 2..N), API fuzz over random edge insertions, regression: self-dependency rejected.

**AC-GRAPH-2 Referential integrity.** No dangling edges: deleting/archiving a resource, task, group or user either cascades per declared rule or is blocked with a named-conflict error; never silently orphans an edge. *Tests:* delete each node type while referenced by each edge type; verify either 409 with conflict list or declared cascade, and zero orphan rows.

**AC-GRAPH-3 Domain-profile neutrality.** All 5 profiles (קייטנה / הפקת אירוע / יום צילום / כנס / לוגיסטיקה) run on one schema. Switching a profile changes labels/catalog only — zero schema migration, zero data loss, same engine results. *Tests:* the entire engine unit suite runs once per profile against profile-specific fixtures; a property test asserts label-map bijectivity (every label key in a profile resolves, no extras).

**AC-GRAPH-4 Tenant model.** Every graph entity carries org (and branch/site) scope; no query path returns entities outside the caller's scope. Covered by isolation suite (§5).

**AC-GRAPH-5 Time model.** All schedule math in one explicit timezone model (org-local wall time + absolute instants). Daylight-saving and cross-midnight events behave sanely. *Tests:* event spanning midnight; DST transition dates for Asia/Jerusalem; duration vs end-time consistency.

---

## 3. Domino engine

The engine computes proposals; humans (with authority) apply. Correctness here is the product.

**AC-DOM-1 Determinism.** Same graph + same change ⇒ same proposal, byte-for-byte, including ordering of affected tasks. *Test:* replay each golden scenario 50× with shuffled input ordering; assert identical canonical output.

**AC-DOM-2 Topological correctness.** Proposed new times respect every `depends_on` edge (successor never scheduled before predecessor's new end) and every resource-capacity rule that is modeled. *Tests:* golden corpus + property-based testing: random DAGs, random delays; invariant: proposal violates zero constraints or is returned as `conflict`.

**AC-DOM-3 Hard locks.** A locked task is never moved by the engine, never by admin drag, never by bulk apply. When a delay propagates into a locked task, output is `conflict with constraint` naming the lock — not a schedule that violates it. *Tests:* delay into lock (single + chain), delay exactly to lock boundary, unlock→recompute→relock.

**AC-DOM-4 Impact classification.** Every proposal carries impact class S0 local / S1 site / S2 cross-site / S3 external, and the class drives the approval requirement. Misclassification (e.g. an S2 computed as S1) is a Sev-1. *Tests:* fixtures hitting each class boundary: N-1 tasks affected vs N; single-site vs cross-site; external stakeholder affected vs not.

**AC-DOM-5 Explainability.** Each proposed change carries its reason chain ("אפקט דומינו: 1 משימות תלויות יזוזו (בריכה)" style) with the actual dependency path. *Tests:* assert reason chain equals the graph path; Hebrew string correctness.

**AC-DOM-6 Idempotent apply.** Applying the same ChangeRequest twice (double-click, retry, race) mutates the graph exactly once. *Tests:* concurrent approve of the same CR; retry with same idempotency key.

**AC-DOM-7 No partial apply.** A multi-task proposal applies atomically; a mid-apply failure rolls back to the pre-apply graph. *Tests:* inject failure at task k of n; assert graph equality with pre-state and audit trail of the rollback.

**AC-DOM-8 Performance bound.** Recompute for a 500-task / 200-resource day completes < 1s p95 server-side. *Test:* load fixture, benchmark in CI.

**Golden corpus (v1, executable fixtures with expected outputs):**
1. Bus delay (the demo scenario): bus late → 5 activities shift → locks preserved → exactly 3 staff + 28 parents affected.
2. The four stage-0 scenarios (weather, staff no-show, equipment failure, venue change) — port from the stage-0 doc.
3. Cross-site domino (S2) requiring admin approval.
4. Domino into a hard lock → conflict escalation.
5. Same change proposed by admin vs field manager vs focus worker → different authority outcomes, same computed proposal.

---

## 4. RBAC & approvals

Authority: RBAC spec (contake_rbac_spec.md) is the normative matrix. These tests make it executable.

**AC-RBAC-1 Full matrix coverage.** Every one of the 22 actions (event.*, task.*, resource.*, dependency.*, constraint.lock/unlock, domino.compute/apply, change.approve/reject, report.status.create, notify.send.targeted, rbac.*) × 3 roles × relevant scopes has an explicit allow/scope/propose/deny API test. The test suite is generated from a machine-readable copy of the matrix so a spec edit without a test edit fails CI.

**AC-RBAC-2 Deny by default.** Any action × role combination not explicitly allowed is denied, including unknown/future actions. *Test:* fuzz unknown action names; assert 403.

**AC-RBAC-3 Server-side only.** Removing/disabling all client-side role checks changes nothing: every unauthorized call still 403s. *Test:* replay UI-captured requests for a focus worker with modified payloads (attempt edit, attempt approve) directly against the API.

**AC-RBAC-4 Focus-worker data minimization.** A focus worker's API responses never contain the full graph — only their current task, its location, required gear, and the report endpoint. *Tests:* response-shape assertions on every endpoint callable by focus tokens; scan responses for sibling-task and other-worker fields; token-scope test (focus token against admin endpoints).

**AC-RBAC-5 ChangeRequest state machine.** Only legal transitions: proposed → pending_review → approved(applied) | rejected. No re-approval of a rejected CR, no edit of a pending CR by its proposer after submission (or edits reset it to proposed — pick one in spec, test it), no approve-by-proposer for their own cross-scope change unless admin. *Tests:* all legal transitions + all illegal ones asserted 4xx.

**AC-RBAC-6 Approval atomicity.** Approve = validate still-current + apply + notify, atomically. Approving a CR whose base graph version has moved is rejected as stale and re-proposed, never force-applied. *Tests:* approve after intervening edit.

**AC-RBAC-7 Field-manager scope.** Field manager edits inside their site apply directly; anything crossing scope (locked task, shared resource, domino into other site) becomes a pending approval and the graph is untouched until decided. *Tests:* each cross-scope trigger type; assert graph unchanged in pending state.

---

## 5. Isolation & multi-tenancy

**AC-ISO-1 Tenant isolation.** Org A cannot read, write, or infer Org B data through any endpoint, ID guessing (IDOR), search, notification, or audit log. *Tests:* cross-org IDOR sweep on every list/get endpoint; notifications addressed to org-scoped recipients only.

**AC-ISO-2 Site isolation for field managers.** A field manager scoped to branch X receives nothing about branch Y, including in aggregate views and notification payloads.

**AC-ISO-3 Session/token hygiene.** Role downgrade/upgrade takes effect without re-login within a bounded time; revoked tokens die. *Tests:* revoke mid-session; role change propagation.

---

## 6. Product E2E journeys

### 6.1 P0 journeys (gate G1)
1. **Build a day:** admin creates event, adds tasks, assigns the 4 generic resource types, links dependencies, locks one task, saves. Visible correctly in timeline and list.
2. **The slip:** a task slips → engine proposes → admin sees affected chain with reasons → approves → timeline updates → correct staff notified (staging notifications asserted).
3. **Field escalation:** field manager makes a cross-scope change → pending card with computed reason → graph unchanged → admin approves → change applies. (Regression of the prototype-verified flow.)
4. **Reject path:** admin rejects → graph untouched, proposer sees rejection with reason.
5. **Focus loop:** focus worker logs in, sees only current task + location + gear, reports a delay, report reaches the engine and Control Tower.

### 6.2 P1 journeys (gate G3)
6. Domain-profile switch: same org, run a יום צילום day with film vocabulary; engine behavior identical.
7. Multi-branch Control Tower matrix view with two field managers acting concurrently.
8. Parent/external-stakeholder notification view (S3): only affected parents, correct Hebrew text.

---

## 7. Notifications (WhatsApp/SMS)

**AC-NOT-1 Targeted only.** A change notifies exactly the computed affected set — nobody else. *Tests:* golden scenario asserts recipient set equality (not subset).

**AC-NOT-2 Dedup & batching.** One event = one message per recipient; rapid successive changes batch per policy (define: e.g. 60s window) rather than storming. *Tests:* double-trigger; 5 changes in 30s.

**AC-NOT-3 Correct content.** Hebrew RTL templates, correct times in org timezone, correct domain vocabulary per profile. *Tests:* snapshot per profile; RTL rendering check on a real device/emulator screenshot.

**AC-NOT-4 Provider failure.** WhatsApp failure falls back to SMS per policy; total provider outage queues and retries with backoff; no message is silently dropped — failures surface in Control Tower and audit log. *Tests:* provider sandbox fault injection.

**AC-NOT-5 No pre-approval sends.** A change requiring approval notifies nobody until approved (except the approver's pending-approval alert). *Test:* S2 change by field manager; assert zero stakeholder messages pre-approval.

**Open product questions (need Chaim via coordinator, non-blocking):** quiet hours for parent messages? per-event opt-out? SMS sender identity?

---

## 8. Failure recovery & concurrency

**AC-FR-1 Optimistic concurrency.** Two managers editing the same task: second save gets a version conflict with a clear Hebrew message and a fresh view — never silent last-write-wins. *Test:* concurrent PUT race.

**AC-FR-2 Offline Focus Mode.** Field worker with dead reception: status reports queue locally, sync on reconnect, in order, exactly once, with original timestamps. *Tests:* airplane-mode E2E on PWA; kill mid-sync; duplicate-sync safety.

**AC-FR-3 Crash mid-recompute.** Server restart during recompute leaves graph at last committed state; recompute is re-runnable. *Test:* kill -9 during apply (staging).

**AC-FR-4 PWA install-free requirement.** Focus Mode works as install-free PWA on mid-range Android + iPhone Safari: add-to-home optional, push-free fallback defined. *Tests:* device matrix smoke.

**AC-FR-5 Duplicate submissions.** Double-tap on report button creates one report. *Test:* rapid double-submit, network retry.

---

## 9. Audit log

**AC-AUD-1 Every mutation logged:** actor, role, action, before/after diff, ChangeRequest linkage, timestamp, IP/device class. *Tests:* mutation sweep; assert log completeness.

**AC-AUD-2 Append-only.** No update/delete path for audit rows, including by admins. DB-level enforcement. *Test:* attempt via API and direct DB role.

**AC-AUD-3 Queryable.** Manager can answer "who moved the pool activity and why" in ≤3 clicks from the timeline. *E2E:* UI journey + API query test.

**AC-AUD-4 Privacy-scoped.** Focus workers see no audit data; field managers see their site only.

---

## 10. Security checklist (gate G2+)
- AuthN: session/JWT handling, expiry, refresh rotation; brute-force throttling on login.
- AuthZ: §4 suite green; no client-side trust.
- Injection: parameterized queries only (review + SQLi fuzz); XSS: no `innerHTML` with user data in Alpha frontend (prototype pattern must not ship); CSP header.
- Transport: HTTPS-only, HSTS; secure cookies (HttpOnly, SameSite).
- Secrets: no secrets in repo/frontend bundle; provider tokens in server env only.
- Rate limits on public/API endpoints; notification endpoints abuse-tested (recipient enumeration).
- Dependency scan in CI; container/image scan if applicable.
- PII: parent/child data minimal, retention policy defined, deletion path exists (a camp can delete a season).

---

## 11. Accessibility & RTL & responsiveness

**Accessibility (WCAG 2.2 AA target for Control Tower + Focus Mode):**
- Keyboard: every action reachable and operable; visible focus; no traps. *Test:* scripted keyboard-only run of all P0 journeys.
- Screen reader: Hebrew VoiceOver/TalkBack labels on all controls; timeline has a text alternative (a schedule list view satisfies this if complete). *Test:* axe-core in CI = 0 critical/serious; manual NVDA/VoiceOver pass at G3.
- Contrast ≥ 4.5:1 text; focus indicators ≥ 3:1. *Test:* automated contrast audit.
- Touch targets ≥ 44×44pt in Focus Mode (gloved/wet hands are the field reality).
- Reduced-motion support.

**RTL:**
- `lang="he" dir="rtl"` at root; logical CSS properties only (no `margin-left/right` — prototype already uses `margin-inline-start`, keep the rule).
- Mirroring: layout and directional icons mirror; non-directional icons (clock, lock 🔒) do not.
- Mixed-direction text: Hebrew + English terms + numbers (e.g. "צוות תאורה A · 12:30") render correctly with bidi control where needed. *Test:* fixture strings with Latin tokens, numbers, parentheses; visual snapshot.
- Date/time: Hebrew locale formats; 24h clock.
- Visual regression: per-breakpoint RTL screenshots in CI.

**Responsiveness:**
- Focus Mode: 320px–430px phones, one-hand reachable primary actions.
- Control Tower: 1366px desktop primary; usable at 768px tablet; no horizontal scroll traps; timeline virtualization sanity at 500 tasks.
- Breakpoint visual snapshots per gate.

---

## 12. Performance budgets
- Recompute: < 1s p95 at 500 tasks/200 resources (AC-DOM-8).
- Control Tower initial load < 3s on 4G; timeline interaction < 100ms p95.
- Focus Mode cold load < 2s on mid-range Android over 3G; < 1MB critical payload.
- Notification dispatch: computed affected-set → provider handoff < 5s p95.

---

## 13. Severity taxonomy
- **Sev-1:** wrong schedule displayed as truth; wrong domino result; hard lock violated; permission bypass; cross-tenant data exposure; notification to wrong recipients; data loss. Blocks everything.
- **Sev-2:** a P0 journey broken; approval flow bypassable in edge case; audit gap; notification silently dropped; crash requiring manual recovery.
- **Sev-3:** non-P0 journey defect; accessibility AA miss; RTL visual bug; performance budget miss < 2×.
- **Sev-4:** polish.

## 14. Artifact critique process
Every artifact routed to me gets: (a) review against this charter and Chaim's verbatim requirements, (b) findings as Sev-tagged, actionable items, (c) verdict: approved / approved-with-findings / blocked. Artifacts in scope: API contracts, data model, engine design, RBAC spec revisions, UI designs and component system, notification templates, infra/security config, and every gate candidate build.

## 15. First critique — prototype v2 (informational; prototype ≠ Alpha code)
Verified live at https://contake-camp-demo.surge.sh/ (SHA-256 matches published source). Good: `lang="he" dir="rtl"`, viewport meta, logical CSS (`margin-inline-start`), tabular numerals. Carry-forward findings for the Alpha frontend standards:
- **F1 (Sev-3, a11y):** 0 `aria-label`s across 19 buttons/16 roles — Alpha component system must bake in labeling from day one.
- **F2 (Sev-3, security-pattern):** 31 inline `onclick` handlers and 11 `innerHTML` writes — acceptable for a throwaway demo, banned patterns for Alpha (XSS surface, CSP incompatibility).
- **F3 (Sev-4):** no visible focus-style audit possible statically; add focus-visible styling to the design-system acceptance criteria.

## 16. What I need from the team (standing)
1. Route to me for critique: technical lead's API contract + data model (week 1), engine design doc, design-system proposal, notification template pack — before each is treated as locked.
2. A machine-readable copy of the RBAC matrix (JSON/YAML) so the §4 suite generates from spec.
3. CI access or CI reports: I will supply the golden corpus and suites in whatever harness the technical lead sets up; I need failures visible to me directly.
4. Domain-profile fixtures for all 5 verticals by G0 (I define the shape; backend seeds them).
