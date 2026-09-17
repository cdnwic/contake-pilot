# REGISTRY ADDENDUM v2 — 2026-09-17 (TL; additive; REGISTRY.md and 0247 control snapshot stay immutable)

## Correction of false metadata (explicit)
- docs/REGISTRY.md line 79 lists for archive 0246: "TL-run 6f01408f...; QA-run 8bca12edd52d...". The "QA-run 8bca12ed" claim is FALSE metadata: 8bca12edd52d905b2627abe3c54fb19ce813c3dd70877ee1540965de4562d8a5 is QA's observed hash of the generator v1.1 scripts tarball (archive-gen-scripts.tar, announced suffix 0058aac4 — the announced-hash mismatch QA flagged), NOT a hash of archive 0246. Archive 0246's outer SHA-256 is 6f01408f87a07f998d0a7c520e149ffa4773b1cedc36882ccfe7d8e6425f5927, observed identically by TL and QA (QA 02:45: "Outer SHA-256 independently matches 6f01408f"). 0246 fails validator v1.2 T8 (root '.' entry; 56 members vs 55). REGISTRY.md itself is intentionally NOT edited (0247 manifest immutability); this addendum carries the correction.

## RBAC matrix lifecycle (canonical)
| Version | Actions | Artifact | sha256 | Status |
|---|---|---|---|---|
| v1.4 | 27 | apps/api matrix (repo base) | — | base |
| v1.5 | 45 | matrix.v1.5.additions.json | 56ce68db2b6fe118b686618aaf5a9a01173a7cd2948e0793e6ffd3b9945f1a44 | current-corrected (supersedes 16b4b1b01e60e83ac6f42366d049c773edf6df5ff3aa66df4d9f0d47eb80592f; content.delete fm=deny) |
| v1.6 | 48 | artifacts/matrix/matrix.v1.6.additions.json | 82a71774479f296d5c2bd2369ceb4a46371b7469cd288741f1afbcbefb3cfa32 | current (supersedes fc49035cb5b358c47cac2f3235e8b4a8924d208549e54d8ee338f0c6f14c9427; channel.optout = machine-principal-only, all user roles deny; +task.advance, report.correct) |

v1.6 = v1.5 (45) + channel.optout + task.advance + report.correct. QA gate: 48 actions, deny-by-default, v1.5 cells unchanged.

## Staging identity & release sequencing
- Verified via Render (read lease, vault-injected key): staging live deploy = a32d1c06e062c55941a9b544aab52f404f358eeb; origin/main ef65394 = a32d1c0 + 3 evidence commits; apps/packages byte-identical. Evidence: artifacts/staging-identity-evidence-43b9de36.json.
- staging tracks main with autoDeploy=ON: any merge/push to main triggers redeploy + cold start (~60s).
- Sequencing rule: before merging any PR to main, confirm whether a demo window exists. None confirmed as of 2026-09-17 03:00 IDT → merges proceed under normal controlled redeploy + post-deploy health verification; no preemptive autoDeploy change. If a demo window is later confirmed: narrowly timed freeze/autoDeploy hold with restoration immediately after the window. **Render live deploy must be re-checked immediately before any merge to main.**
