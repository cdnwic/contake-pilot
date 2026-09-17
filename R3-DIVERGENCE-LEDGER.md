# r3 divergence ledger (TL profiles-divergence ruling v1.0, parent 11:43 2026-09-17; additive)

Authority: parent direct messages 11:43:47 / 11:43:59 + ruling doc contake-fe-r3-profiles-divergence-ruling-v1.0
(sha256 872a999860e27bc745b0239583877bf5114fe93090c301638c578ca2ff20d5f7, sidecar-verified).
Rule: no vertical silently added or removed; recovered snapshots preserved unchanged; parity alignment is an
explicit, logged, QA-verified layer — never an edit to the recovered snapshot.

## Row 1 — domain-profiles
- surface: domain-profiles (seed path `src/contracts/domain-profiles.v1.json`, imported by `src/api/seed.ts`)
- recovered: 6 profiles (camp, event-production, film-shoot, conference, logistics, after-school) — education absent
- recovered snapshot sha256: 4e9b1d48c9e1fdef3d38f560f6d51b6f1d62ae289c072e34c070a1f9f1a5ca52 (PRESERVED UNCHANGED)
- canonical: 7 profiles incl. education — `packages/core/src/profiles/profiles.v1.json` @ origin/main 23364c1d
- canonical sha256: 6716b5aa621f52b163dae9c75bd1c0d3c55d7d956903ebb1803cf91592ad5fd8
- resolution: parity-align. Canonical parity layer lives separately at `src/profiles/profiles.v1.json` +
  `src/profiles/profiles.ts` (zod-validated at load). Byte-identical to canonical (same sha256).
- QA evidence: `src/profiles/profiles-parity.test.ts` pins both shas + exact id lists (6 recovered / 7 canonical).
- status: awaiting independent QA verification.

## Row 2 — computeDomino engine
- surface: domino engine (`src/engine/`)
- recovered: r2.1 computeDomino STALE — fails the pinned repo golden corpus (7-vs-5 flagship divergence)
- recovered files preserved: `preserved-candidates/engine-computeDomino-r2.1-stale-20260917.ts`,
  `engine-computeDomino.test-r2.1-stale-20260917.ts`, `engine-qaCorpus-r2.1-wrapper-20260917.ts`
- canonical: repo `packages/core` @ a32d1c0 (staging SHA, ancestor of main; apps/packages byte-identical to main)
  adopted verbatim: computeDomino + time + dag (354 lines) + repo golden-corpus/dag tests + canonical fixture
- resolution: canonical-adopt (behavioral evidence from r2.1 liveApi/PROGRESS-WIRING never treated as source)
- QA evidence: vitest 23/23 incl. repo golden corpus (G1 flagship, lock-mid-chain, film cross-domain) + dag.
- status: awaiting independent QA verification (parent 11:43:47: local 23/23 is not independently verified
  until QA compares normalized source and reruns tests).
