# Contake QA — E2E Journey Specs v1.0 (Playwright, gate G1/G3)
Charter §6. Runs against the integrated build only, never against components in isolation.
Harness: Playwright, `locale: 'he-IL'`, `timezoneId: 'Asia/Jerusalem'`, seeded fixtures from domain-profiles v1.1 + golden corpus graph.

## P0 journeys (gate G1 — every one must pass)

### E2E-1 Build a day (AC: charter 6.1-1)
1. Login as admin → POST /v1/events (camp profile) → add 5 tasks via builder UI.
2. Assign all 4 generic resource kinds; create dependency chain t1→t5; lock t5.
3. Assert: timeline renders all tasks RTL; dependency edges visible in Day Grid; lock glyph on t5.
4. API assertion: GET /v1/events/:id/graph returns exact fixture shape; DAG validated (attempt cycle → 400 with Hebrew error naming cycle members).
5. A11y: full journey keyboard-only; axe = 0 critical/serious.

### E2E-2 The slip (flagship)
1. Seed golden corpus G1 graph. Admin moves t1 +45min via UI drag.
2. Assert preview shows 5 moved tasks, summaryHe "אפקט דומינו: 4 משימות תלויות יזוזו (ארוחת בוקר)", maxImpactClass S3, locked t6 unmoved.
3. Approve → timeline updates; Update Stub shows "3 מדריכים · 28 הורים".
4. Notification assertion (sandbox providers): exactly 3 staff + 28 parent jobs enqueued, zero others (recipient-set EQUALITY, AC-NOT-1); idempotencyKey = eventId+changeRequestId+kind.

### E2E-3 Field escalation (regression of prototype-verified flow)
1. Login field_manager (site-1). Attempt cross-scope change (locked task / shared exclusive resource / domino into site-2).
2. Assert: pending approval card with computed reasonHe; graph byte-identical before decision (AC-RBAC-7).
3. Admin approves → change applies atomically; audit log entry links ChangeRequest id.
4. change_needs_approval notification went to admins only (in_app + WhatsApp sandbox).

### E2E-4 Reject path
1. As E2E-3, admin rejects with reason → graph untouched; proposer sees rejection + reasonHe; no stakeholder notifications (AC-NOT-5).

### E2E-5 Focus loop
1. OTP login as focus_worker → sees ONLY current task + place + gear chips (AC-RBAC-4: response-shape assertion on every endpoint the session touches — no full graph, no sibling tasks, no other workers).
2. Report "delayed +30" on own unlocked task (S0) → auto-applies (reportApplyRule); Control Tower updates live (Socket.IO user:{id} room only).
3. Report on a LOCKED task → pending_review card for admin, task unmoved.
4. Double-tap report button → one report (clientReportId dedupe, AC-FR-5).

## P1 journeys (gate G3)

### E2E-6 Domain profile switch
Same org runs film-shoot day: identical engine results (structural equality with camp run), vocabulary stripe + labels swap, notification wording from film templates.

### E2E-7 Multi-branch concurrency
Two field_managers, two sites, simultaneous edits → optimistic concurrency conflict on collision (AC-FR-1), no silent last-write-wins; Control Tower matrix view consistent after resolution.

### E2E-8 Quiet hours
S3 parent notification at 21:55 on an active published day → sends immediately (active-day exception). Same at 21:55 on tomorrow's draft event → held until 07:00 local (N2).

### E2E-9 Offline Focus Mode
Airplane mode: 3 reports queued → reconnect → sync in order, exactly once, clientTimestamp preserved (AC-FR-2). Kill mid-sync → no duplicates, no loss.

### E2E-10 Audit trail
After E2E-2: manager opens "who moved what" from timeline in ≤3 clicks; every mutation present with actor/before/after/CR link (AC-AUD-1/3). Focus worker sees no audit data (AC-AUD-4).

## Cross-cutting assertions on every journey
- RTL: no horizontal page scroll; times LTR-isolated; bidi test string שלום John 050-1234567 ₪1,234 renders correctly wherever user names appear.
- Visual snapshots 390/768/1440 × Day/Night × active vertical stripe.
- Reduced-motion run: journey completes with animations zeroed.
