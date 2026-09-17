#!/usr/bin/env bash
# Full-suite PGlite diagnostic runner (controller family, QA 2026-09-17).
# Diagnostic harness only - NOT a qualification run. Executes ONLY under an
# explicit per-run QA authorization (exactly-one grants). Emits G4_EXT_LOG
# alongside G4_DIAG_LOG and preflights both paths present+writable.
set -u
CO=${CO:-/tmp/full-v8}
API=$CO/apps/api
CTRL=$CO/scripts/e2e/g4-diag/controller.sh
LOG=${LOG:-/tmp/full-v8-suite.log}
DIAG=${DIAG:-/tmp/full-v8-probes.jsonl}
EXT=${EXT:-/tmp/full-v8-reporter.jsonl}
EXITCODE=${EXITCODE:-/tmp/full-v8-exitcode}
rm -f "$LOG" "$DIAG" "$EXT" "$EXITCODE"
# Preflight (QA 2026-09-17): G4_DIAG_LOG and G4_EXT_LOG destinations must both
# exist and be writable BEFORE launch; refuse otherwise.
PREFLIGHT_OK=1
for P in "$DIAG" "$EXT"; do
  if ! touch "$P" 2>/dev/null || [ ! -f "$P" ] || [ ! -w "$P" ]; then
    echo "PREFLIGHT-FAIL $(date -Iseconds): $P not present+writable; NOT launching" >&2
    PREFLIGHT_OK=0
  fi
done
[ "$PREFLIGHT_OK" = "1" ] || exit 1
VITEST_PKGVER=$(cd "$API" && node -p "require('./node_modules/vitest/package.json').version")
{
  echo "=== PROVENANCE HEADER (pre-run, contemporaneous) ==="
  echo "checkout: $CO"
  echo "HEAD: $(cd $CO && git rev-parse HEAD)"
  echo "tree: $(cd $CO && git rev-parse 'HEAD^{tree}')"
  echo "git-status-porcelain: [$(cd $CO && git status --porcelain)]"
  echo "controller-hashes:"
  ( cd $CO/scripts/e2e/g4-diag && sha256sum controller.sh sentinel-launch.sh guardian.sh ext-sampler.sh | sed 's/^/  /' )
  echo "command: controller.sh --label fullv8 --cap 900 --workdir $API -- bash -c 'REPO_IMPL=postgres PG_HARNESS_TRACE=1 G4_DIAG_LOG=$DIAG G4_EXT_LOG=$EXT vitest run --reporter=default --reporter=g4-diag-reporter.mjs'"
  echo "scope: FULL project suite, ONE invocation, NO file list/excludes; pool: project default (forks, NO worker/sequencing overrides); N untouched (G4_N unset); REPO_IMPL=postgres; PG_HARNESS_TRACE=1; unchanged tests/assertions/timeouts; no retries/noise; controller cap 900s; guardian grace default 15s; outer OUTER_TIMEOUT_S=1020 declared"
  echo "env: REPO_IMPL=postgres PG_HARNESS_TRACE=1 G4_DIAG_LOG G4_EXT_LOG (no G4_N, no STRESS_OPT_IN)"
  echo "g4-diag-log: $DIAG"
  echo "g4-ext-log: $EXT"
  echo "vitest-package-version: $VITEST_PKGVER"
  echo "node: $(node --version)"
  echo "pnpm: $(pnpm --version)"
  echo "pnpm-lockfile-sha256: $(sha256sum $CO/pnpm-lock.yaml | awk '{print $1}')"
  echo "helper-hashes:"
  ( cd "$API" && sha256sum tests/helpers/repo.ts tests/helpers/g4-diag.ts tests/helpers/g4-diag-reporter.mjs vitest.config.ts package.json | sed 's/^/  /' )
  echo "cpus: $(nproc)"
  echo "install: complete before timing (rc 0; no network/install/push/unrelated overlap)"
} > "$LOG" 2>&1
# resource gate: start only when MemAvailable >= 1.4GB and loadavg1 <= 0.5; wait otherwise
GATE_OK=0
for i in $(seq 1 120); do
  MAVAIL=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
  LOAD1=$(cut -d' ' -f1 /proc/loadavg)
  if [ "$MAVAIL" -ge 1400 ] && [ "$(awk -v l="$LOAD1" 'BEGIN{print (l<=0.5)?1:0}')" = "1" ]; then GATE_OK=1; break; fi
  echo "gate-wait $(date -Iseconds): MemAvailable=${MAVAIL}MB load1=$LOAD1 (need >=1400MB, <=0.5); waiting, no processes killed" >> "$LOG"
  sleep 5
done
if [ "$GATE_OK" != "1" ]; then
  echo "gate-FAIL $(date -Iseconds): resources never settled within 10 min; NOT launching" >> "$LOG"
  echo "RUNNER-GATE-FAIL"
  exit 1
fi
{
  echo "gate-pass $(date -Iseconds): MemAvailable=${MAVAIL}MB load1=$LOAD1"
  echo "mem: $(free -m | head -2 | tail -1)"
  echo "loadavg: $(cat /proc/loadavg)"
  echo "start: $(date -Iseconds)"
  echo "=== BEGIN FULL DIAGNOSTIC (controller cap 900s) ==="
} >> "$LOG"
cd "$API"
setsid bash -c "OUTER_TIMEOUT_S=1020 '$CTRL' --label fullv8 --cap 900 --workdir '$API' -- bash -c 'REPO_IMPL=postgres PG_HARNESS_TRACE=1 G4_DIAG_LOG=$DIAG G4_EXT_LOG=$EXT node_modules/.bin/vitest run --reporter=default --reporter=$API/tests/helpers/g4-diag-reporter.mjs' >> '$LOG' 2>&1; echo \$? > '$EXITCODE'" &
WPID=$!
sleep 0.5
echo "controller-wrapper-pid: $WPID launched $(date -Iseconds)" >> "$LOG"
RUNDIR=""
for _ in $(seq 1 200); do
  RUNDIR=$(ls -dt /tmp/g4-ctrl-fullv8-* 2>/dev/null | head -1)
  [ -n "$RUNDIR" ] && break
  sleep 0.2
done
echo "run-dir: ${RUNDIR:-UNRESOLVED} recorded $(date -Iseconds)" >> "$LOG"
echo "RUNNER-LAUNCHED rundir=$RUNDIR wpid=$WPID"
