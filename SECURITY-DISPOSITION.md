# r3 dependency/security disposition (QA stop-ship correction 4, 2026-09-17)

Audit: `npm audit` on clean `npm ci` (raw JSON: qa/logs/npm-audit-r3.json). 5 findings, ALL in
devDependencies toolchain — vite 5.4.21 (highest 5.x), vitest 2.1.9 (highest 2.x), esbuild 0.21.5,
@vitest/mocker, vite-node. Zero findings in runtime-shipped dependencies.

| pkg | severity | gist | exposure in r3 |
|---|---|---|---|
| vitest | critical | Vitest UI server file read/exec; @vitest/mocker redirect mock traversal | test runner only, local, never exposed |
| vite | high | optimized-deps .map path traversal; Windows NTLMv2/UNC; fs.deny Windows bypass | build tool + local preview only, never exposed |
| @vitest/mocker | moderate | path traversal / arbitrary file read via redirect mock | test-time only |
| vite-node | moderate | via vite | test-time only |
| esbuild | moderate | dev server accepts cross-origin requests | dev server only; no dev server runs anywhere |

Disposition:
1. All five require a RUNNING vite/vitest/esbuild dev/test server. r3 deploys as static dist/
   (surge / Render static): no vite, vitest, esbuild, or node process is part of the runtime.
   Vite dev/preview and Vitest UI are never exposed to any network interface beyond localhost,
   and never run against staging/prod. No secrets or user data exist in the mock runtime.
2. Versions are already at the top of their major lines (vite 5.4.21, vitest 2.1.9); every fix
   requires a major upgrade (vite 8.3.0 / vitest 5.0.1). A major toolchain bump re-opens build
   reproducibility and requires re-running all gates + pixel QA, so it is a separate TL decision,
   not folded into this recovery checkpoint.
3. Runtime bundle contents verified: vite/vitest/esbuild code is NOT in dist/ (build tooling only).
