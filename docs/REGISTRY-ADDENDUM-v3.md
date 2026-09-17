# REGISTRY ADDENDUM v3 — Release-safety + PR #5 closeout (2026-09-17, TL; additive)

## Release-safety ruling v1.0 (durable; full text: TL doc sidecar hash 31e20ad62b2b0dd31e48a8fe4a85b97e4505e0b5b8e685c521993ba10a20d26a)
- Preservation/docs-only merges MUST NOT promote runtime services.
- autoDeploy is OFF on staging (srv-dak86d15efls73d1r6gg) and prod (srv-dajej6gjo6nc73dien70) since 2026-09-17 03:08 IDT; stays OFF until an explicit release plan approved through the trusted owner channel; restoration only per that plan. Every merge to main repeats this protocol until autoDeploy is deliberately re-enabled.
- Authority provenance (reported context, not a grant from these files): parent instruction 2026-09-17 03:07-03:09 IDT; TL ruling v1.0 + addendum.

## Structured preservation records (lifecycle: current)
| File | sha256 | Created | Provenance | Lifecycle | Destination |
|---|---|---|---|---|---|
| docs/REGISTRY-ADDENDUM-v3.md | (see ADDENDUM-v3-MANIFEST.sha256) | 2026-09-17 03:13 IDT | TL | current | repo canonical |
| artifacts/release-safety/render-state-pr5-recheck-0ceb6270.json | (manifest) | 2026-09-17 03:07 IDT | infra Render read lease | current | repo canonical |
| artifacts/release-safety/autodeploy-hold-evidence-704dbb58.json | (manifest) | 2026-09-17 03:08 IDT; corrected 03:13 (before=yes, workaround field removed; originally received hash daedf7c9) | infra Render write lease L-4tuekmphlye6ladraapekrilsu | current | repo canonical |
| artifacts/release-safety/post-merge-pr5-recheck-50add039.json | (manifest) | 2026-09-17 03:11 IDT | infra Render read lease | current | repo canonical |

- Evidence files are point-in-time historical snapshots. Any statement about CURRENT Render state requires a live re-read; these snapshots do not prove present state.
- Hook anomaly ("pushes to main triggered no deploys since Sep 15/16") is a HYPOTHESIS, unverified; not a fact about Render behavior.

## PR #5 closeout
- Merged fast-forward: main = 49d8c978bb3cca85be0b74cac6cf457a06671d21. PR: https://github.com/cdnwic/contake-pilot/pull/5. Post-merge: no deploy fired; live SHAs unchanged (staging a32d1c06e062c55941a9b544aab52f404f358eeb, prod ea02ba0064375c8cd00294f205e5aa4acc963b77).
- Incident: a transient incorrect branch head (reported prefix 0dbe562b) existed on the PR branch for ~1 minute and was force-corrected to 725d742 before QA fetch. It was never merged and no canonical reference uses it. Lesson: full-SHA citation in every handoff + head verification before fetch.
- Candidate lineage: 725d742 (superseded) → 5a187c2 (local patch-header identity) → 49d8c978 (remote QA-green, merged).
