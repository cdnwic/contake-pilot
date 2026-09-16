# Early-finish / advancement (bidirectional domino) — backend touchpoint analysis v0.1

- Author: backend agent | Date: 2026-09-17 02:46 IDT | Status: design evidence (accepted by main, held for TL v1.21 contract delta)
- Source: founder steering via main, WhatsApp 2026-09-17 02:45 IDT. Base: main @ ef65394d + PR #4 (feat/v1.20-builder-backend @ e06b3d3e). Implementation will stack on PR #4 (main ruling 02:46).

## Directive (paraphrase)
Early-finish/advancement required in Alpha, not only delays. Compute which downstream work can safely move earlier across dependencies, people, location, equipment and Content-in-Context. No automatic day shift: show manager impact, require applicable approval under existing RBAC. On approval move the full work package atomically (timing, assignees/people, equipment/resources, content visibility windows, stakeholder notifications). Immovable downstream items expose the blocker and preserve the freed interval truthfully. Domain-general (not camps). Contract + backend + UX + E2E + QA coverage.

## Touchpoints (verified in tree)
1. Engine: packages/core/src/domino/computeDomino.ts — pure, deterministic, 354 LoC, QA golden-corpus pinned. task.move cascades forward only. Finish-early trigger needs negative-shift propagation honoring pinned semantics: D1 locks, maxShiftMin anchoring, one-conflict-per-code consolidation, trigger-takes-requested-position, blockedTaskIds + truthful freed interval for immovable items.
2. Approval gate: existing ChangeRequest/proposeMutation + rawDecision (matrix.v1) requires approval for FM at >=S1 — advancement can ride this (directive: no auto-shift; approval under existing RBAC).
3. Atomic work-package apply: withAuditSafety-wrapped mutation bundling task timing + assignees + resources + content visibility windows + notifications, single audit trail.
4. Content-in-Context (couples to PR #4): TaskResourceLink.visibleFromOffsetMin is start-relative (travels automatically); absolute visibleUntil does NOT — needs TL ruling (shift-with-start vs clamp).
5. Notifications: dispatcher templates for advancement offer + post-approval move; §22 stakeholder recipients still unwired (v1.20 follow-up).
6. Domain-general: per-DomainProfile maxShiftMin already exists; no camp-specific narrowing.

## Open rulings for TL v1.21
- Finish-early trigger shape (new ProposedChange variant vs task.move with negative delta).
- visibleUntil shift vs clamp.
- Freed-interval representation in DominoResult (explicit field vs conflict metadata).
- Impact classification (S0-S3) of advancement moves.
