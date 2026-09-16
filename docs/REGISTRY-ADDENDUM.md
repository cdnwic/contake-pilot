# REGISTRY addendum (backend, 2026-09-17 02:52 IDT)

Appended during preservation-PR composition; TL owns docs/REGISTRY.md proper.

1. **Matrix supersession**: docs/REGISTRY.md row `matrix.v1.5.additions.json` (16b4b1b0..., marked active) is SUPERSEDED by the TL corrected drop-in sha256 56ce68db2b6fe118b686618aaf5a9a01173a7cd2948e0793e6ffd3b9945f1a44 (content.delete FM propose -> deny, matching §20 admin-only). Corrected drop-in + sidecar preserved at artifacts/matrix/. Code (PR #4 head b42c2b0) carries the corrected cell.
2. **Control files**: ARCHIVE-MANIFEST-0247.sha256 and the 0247 outer sidecar at artifacts/control/.
3. **Transport chain**: artifacts/archive-chain/CHAIN.md registers all six prior unified archives with lifecycle + QA findings.
4. **Generator**: artifacts/generator/ (portable, QA-validated, byte-reproducible).
5. **Contrib design evidence**: artifacts/contrib/early-finish-touchpoint-analysis-v0.1.md (sha256 8cf7407658489421164b6ae0a1350062d1902f7b57998e27d129631e6030fde7; accepted by main 02:46; held for TL v1.21.x implementation).
