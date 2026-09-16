# Field Reality & Adoption — verdict report (PQM-5)

**Date:** 2026-09-17 · **Author:** Product Quality Manager 5 (Field Reality & Adoption), independent verdict
**Mandate:** founder, WhatsApp 02:25 (wamid.HBgM...A4UA): attack Contake from five directions so failures surface before he finds them. This office covers manager, field worker, parent/customer and supplier across verticals: can people prepare, execute, respond and recover inside Contake without falling back to WhatsApp, calls or spreadsheets?
**Evidence:** scripts/field-reality/persona-probes.mjs, staging run rmu4qeobs (24 checks: 15 PASS, 7 GAP, 2 SKIP, 0 harness FAIL; local memory segment for whitelist + worker writes per TL seeded-content rule). Every claim below cites a live probe or a code-verified route absence. Staging providers are log-sandbox: external delivery steps are ENV-LIMITED, not product verdicts.

## Verdict summary

| Persona | Prepare | Execute | Respond | Recover |
|---|---|---|---|---|
| Manager | PASS (with friction note) | PASS | **FAIL — blind to non-delay field reports (G1)** | partial: delay loop closes in-app; blocked/done loop broken (G1) |
| Field worker | PASS (invite loop) | PASS (login, today view, report) | PASS (in-app move notifications) | PASS for delay escalation; broken for silent reports (G1) |
| Parent/customer | n/a (receive-only) | **GAP — no proactive status surface (G6)** | **FAIL — cannot opt out (G2)** | n/a |
| Supplier | **FAIL — no surface at all (G3)** | — | — | — |

**Overall: NOT Alpha-ready on field reality.** Three stop-ship findings (G1, G2, and G4 which the founder already named at 02:13) must close before any claim that a team can run a day inside Contake without WhatsApp. Two more gaps need founder scope rulings (G3 supplier, G6 portal).

## Stop-ship findings

**G1 — Field reports that are not delays never reach the manager. (HIGH)**
A worker's blocked/done report is stored and audited, but: no notification job is built (only `delayed`+`delayMin` escalates via CR), and no route exposes reports for reading (`repo.listReports` exists; `GET /v1/reports?eventId=` -> 404). The resolve route requires the report ID, which no route can list. Live evidence: report created 200, zero notification, read probe 404. Fallback today: the worker files in-app, then calls or WhatsApps the manager anyway — the exact loop Contake exists to kill. A field worker who learns their reports vanish stops filing them.
Fix direction: manager-visible report surface (list + unread state) and a notification on blocked reports; resolve must not depend on an unlistable ID.

**G2 — A parent cannot opt out. (HIGH, regulatory exposure)**
`handleInboundStop` exists in the dispatcher but no HTTP route exposes it (probe `POST /v1/webhooks/inbound` -> 401; no inbound route in app.ts/server.ts). A parent who replies STOP keeps receiving messages; removal requires a phone call to the organiser. At parent scale this is both an adoption killer and a compliance problem.

**G4 — Work material cannot be attached to work. (HIGH; founder-named)**
No content entity or route exists (`POST /v1/tasks/:id/content` -> 404): no call sheet, link, checklist, equipment list or form on a task. The manager sends material in WhatsApp/Drive links. The founder's 02:13-02:15 steering already declared this design-only state not Alpha-ready; this office independently confirms the gap from the manager's and worker's lived flow and aligns with the E2E plan in docs/e2e-content-in-context-plan.md.

## Scope-ruling findings (founder decision needed)

**G3 — Supplier has no surface. (MEDIUM-HIGH)** No supplier role in RBAC (admin/field_manager/focus_worker only), no supplier-facing route or read model. All supplier coordination (deliveries, confirmations) lives in WhatsApp/calls/spreadsheets. Verdict: gap if supplier flows are in Alpha scope; needs a founder scope ruling, not an assumption either way.

**G6 — Parent cannot check status proactively. (MEDIUM)** Parents are receive-only channel subscribers; no portal or guest read. Fallback: phone call. May be acceptable for Alpha if outbound updates are reliable — but that depends on production provider delivery, which is currently unproven end-to-end (no receipt surface; v1.19 §19 deliveries read is post-demo).

## Other findings

**G5 — No ad-hoc manager→worker operational message. (MEDIUM)** `POST /v1/messages` -> 404. "Bring the cables" goes to WhatsApp. A lightweight task-scoped note would cover most of this without building chat.

**G7 — English UI unverified/absent at API level. (MEDIUM)** User requirement (2026-09-16 22:33 WhatsApp) for English support in the next version. API returns Hebrew-only messageHe/templates; v1.19 i18n contracts exist (sha 95c705fe); FE-side rendering unverified without FE repo access (standing blocker).

**Onboarding-order friction (note, not a defect):** approving a new focus_worker requires a `linkedResourceId` of an existing event person-resource, so the first worker cannot be approved before the org has an event with person resources. Worth a product note in onboarding UX.

**ENV-LIMITED (not product verdicts):** staging delivers nothing externally (log-sandbox WhatsApp/SMS/push) and exposes OTP devCode; pilot mandates CONTAKE_DEV_OTP=false with real providers. Production delivery/receipt remains unproven until v1.19 §19 ships. Staging devCode exposure is a deploy-hygiene flag if staging is ever shown externally.

## What works (evidence-backed, kept honest)

Manager: build day + dependencies + assign + publish; versioned edit after publish; disruption move builds notification jobs incl. external channel intents; delay report escalates to CR with an admin approval-needed job, and the approve/reject loop closes in-app; staff invite loop (whitelist invite → register → approve → OTP login) passes end-to-end (local, disposable). Worker: OTP login; today view filters to assigned events; tasks readable with times; report done and report delayed+delayMin both accepted (local). Parent: schedule-change update intents are built for the parent channel. Tenant isolation, audit trail, RBAC denials and domino correctness are covered by the reliability suites (rbac-matrix 282/282, audit-evidence, idempotency-contract, dispatch-evidence) and are not re-litigated here.

## Independence and rerunnability

This verdict is independent of the technical-reliability office (PQM-3) and the TL; shared evidence is cited, not adopted. The probe harness is rerunnable on demand (`--local-only` for the disposable segment; staging segment respects the Thursday blackout and the zz-qa-/leftover rules — all sweeps verified zero leftovers).
