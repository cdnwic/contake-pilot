#!/usr/bin/env bash
# Render-shaped release check (fail-closed hotfix v2, 2026-09-17). Mirrors the
# Render blueprint EXACTLY: install -> build -> start, then boot-gate probes.
# Usage: apps/api/scripts/render-release-check.sh [DATABASE_URL]
#   DATABASE_URL optional; when given, the positive production-shaped boot
#   probe runs against it (a scratch database is created/dropped by the caller).
set -euo pipefail
cd "$(dirname "$0")/../../.."   # repo root

echo '== blueprint checks =='
grep -q 'key: CONTAKE_AUTH_SECRET' render.yaml || { echo 'FAIL: render.yaml lacks managed CONTAKE_AUTH_SECRET'; exit 1; }
grep -A1 'key: CONTAKE_AUTH_SECRET' render.yaml | grep -q 'sync: false' || { echo 'FAIL: CONTAKE_AUTH_SECRET must be sync:false (managed, no value in repo)'; exit 1; }
! grep -q 'CONTAKE_SEED' render.yaml || { echo 'FAIL: render.yaml must not set CONTAKE_SEED (production is seed-free)'; exit 1; }
grep -q 'key: NODE_ENV' render.yaml || { echo 'FAIL: render.yaml must declare NODE_ENV=production'; exit 1; }
echo 'render.yaml: managed secret sync:false, no CONTAKE_SEED, NODE_ENV declared - OK'

echo '== exact Render install/build =='
pnpm install --frozen-lockfile
pnpm --filter @contake/core build
pnpm --filter @contake/api build

echo '== negative: production-shaped boot without secret refuses =='
# pipefail-safe: capture, require non-zero exit, then match the refusal text.
neg_out=$(env -u CONTAKE_AUTH_SECRET NODE_ENV=production DATABASE_URL="${1:-postgres://localhost:1/x}" PORT=0 node apps/api/dist/server.js 2>&1) && { echo 'FAIL: boot SUCCEEDED without secret'; exit 1; }
echo "$neg_out" | grep -q CONTAKE_AUTH_SECRET || { echo 'FAIL: refusal did not name CONTAKE_AUTH_SECRET'; echo "$neg_out" | head -5; exit 1; }
echo 'refusal names CONTAKE_AUTH_SECRET - OK'

if [ -n "${1:-}" ]; then
  echo '== positive: valid production-shaped config reaches health =='
  PORT=0 env NODE_ENV=production DATABASE_URL="$1" CONTAKE_AUTH_SECRET="${CONTAKE_AUTH_SECRET:?set a >=32-char secret for the positive probe}" \
    PORT=18932 node apps/api/dist/server.js & SRV=$!
  for i in $(seq 1 20); do curl -sf -m 2 http://127.0.0.1:18932/v1/health >/dev/null 2>&1 && break; sleep 1; done
  curl -sf -m 2 http://127.0.0.1:18932/v1/health >/dev/null && echo 'health 200 - OK' || { echo 'FAIL: no health'; kill $SRV 2>/dev/null; exit 1; }
  kill $SRV 2>/dev/null || true
fi
echo 'render-release-check: PASS'
