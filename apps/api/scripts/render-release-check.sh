#!/usr/bin/env bash
# Render-shaped release check v2 (track-0, 2026-09-18). Executes the LITERAL
# buildCommand parsed from render.yaml from a CLEAN dist-free tree - no
# substitute sequence - then proves boot gates. QA requirement: this script's
# PASS must be evidence for the ACTUAL Render path.
# Usage: CONTAKE_AUTH_SECRET=<random>=<32 chars> apps/api/scripts/render-release-check.sh [SCRATCH_DATABASE_URL]
set -euo pipefail
cd "$(dirname "$0")/../../.."   # repo root

SRV=""
cleanup() { if [ -n "$SRV" ] && kill -0 "$SRV" 2>/dev/null; then kill "$SRV" 2>/dev/null || true; wait "$SRV" 2>/dev/null || true; fi; }
trap cleanup EXIT

echo '== blueprint checks =='
grep -q 'key: CONTAKE_AUTH_SECRET' render.yaml || { echo 'FAIL: render.yaml lacks managed CONTAKE_AUTH_SECRET'; exit 1; }
grep -A1 'key: CONTAKE_AUTH_SECRET' render.yaml | grep -q 'sync: false' || { echo 'FAIL: CONTAKE_AUTH_SECRET must be sync:false (managed, no value in repo)'; exit 1; }
! grep -q 'CONTAKE_SEED' render.yaml || { echo 'FAIL: render.yaml must not set CONTAKE_SEED (production is seed-free)'; exit 1; }
grep -q 'key: NODE_ENV' render.yaml || { echo 'FAIL: render.yaml must declare NODE_ENV=production'; exit 1; }

echo '== extract LITERAL buildCommand from render.yaml =='
BUILD_CMD=$(grep -E '^\s*buildCommand:' render.yaml | sed -E 's/^\s*buildCommand:\s*//')
[ -n "$BUILD_CMD" ] || { echo 'FAIL: no buildCommand in render.yaml'; exit 1; }
echo "literal buildCommand: $BUILD_CMD"
# Contract: the blueprint command itself must build core before api (no
# substitute sequence is allowed to compensate for a broken blueprint).
case "$BUILD_CMD" in
  *"@contake/core build"*"@contake/api build"*) : ;;
  *) echo 'FAIL: blueprint buildCommand does not build @contake/core before @contake/api'; exit 1 ;;
esac

echo '== clean dist-free tree, then execute the LITERAL command verbatim =='
rm -rf packages/core/dist apps/api/dist
bash -c "$BUILD_CMD"
[ -f packages/core/dist/index.js ] || { echo 'FAIL: literal buildCommand did not produce packages/core/dist/index.js'; exit 1; }
[ -f apps/api/dist/server.js ] || { echo 'FAIL: literal buildCommand did not produce apps/api/dist/server.js'; exit 1; }
echo 'literal buildCommand produced core dist + api dist - OK'

echo '== negative: production-shaped boot without secret refuses =='
neg_out=$(env -u CONTAKE_AUTH_SECRET NODE_ENV=production DATABASE_URL="${1:-postgres://localhost:1/x}" PORT=0 node apps/api/dist/server.js 2>&1) && { echo 'FAIL: boot SUCCEEDED without secret'; exit 1; }
echo "$neg_out" | grep -q CONTAKE_AUTH_SECRET || { echo 'FAIL: refusal did not name CONTAKE_AUTH_SECRET'; echo "$neg_out" | head -5; exit 1; }
echo 'refusal names CONTAKE_AUTH_SECRET - OK'

echo '== negative: placeholder-grade secret refuses =='
ph_out=$(env NODE_ENV=production DATABASE_URL="${1:-postgres://localhost:1/x}" CONTAKE_AUTH_SECRET='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' PORT=0 node apps/api/dist/server.js 2>&1) && { echo 'FAIL: boot SUCCEEDED with repeated-char secret'; exit 1; }
echo "$ph_out" | grep -qi 'refusing to boot' || { echo 'FAIL: placeholder refusal missing'; exit 1; }
echo 'placeholder-grade secret refused - OK'

if [ -n "${1:-}" ]; then
  echo '== positive: valid production-shaped config reaches health =='
  : "${CONTAKE_AUTH_SECRET:?set CONTAKE_AUTH_SECRET in the environment (>=32 random chars) for the positive probe}"
  PORT=$(node -e "const s=require('net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})")
  env NODE_ENV=production DATABASE_URL="$1" CONTAKE_AUTH_SECRET="$CONTAKE_AUTH_SECRET" PORT="$PORT" node apps/api/dist/server.js & SRV=$!
  ok=''
  for i in $(seq 1 25); do curl -sf -m 2 "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1 && { ok=1; break; }; sleep 1; done
  [ -n "$ok" ] && echo "health 200 on dynamic port $PORT - OK" || { echo 'FAIL: no health'; exit 1; }
fi
echo '== documented generators pass the built resolver =='
# Every backtick-quoted openssl generator in docs/pilot-auth.md is executed
# and its output fed through the BUILT resolver (dist), so ops docs can never
# drift from the parser again.
grep -oE '`openssl rand [^`]+`' docs/pilot-auth.md | tr -d '`' | while read -r gen; do
  out=$(eval "$gen")
  GEN_OUT="$out" node -e "const{resolveAuthSecret}=require('./apps/api/dist/boot-config.js');resolveAuthSecret({CONTAKE_AUTH_SECRET:process.env.GEN_OUT})" 2>/dev/null ||   GEN_OUT="$out" node --input-type=module -e "const{resolveAuthSecret}=await import('./apps/api/dist/boot-config.js');resolveAuthSecret({CONTAKE_AUTH_SECRET:process.env.GEN_OUT})"     || { echo "FAIL: documented generator rejected by resolver: $gen"; exit 1; }
  echo "documented generator accepted: $gen"
done

echo 'render-release-check: PASS'
