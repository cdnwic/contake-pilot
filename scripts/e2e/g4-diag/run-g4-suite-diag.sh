#!/usr/bin/env bash
# G4 suite-context diagnostic runner (QA-authorized one-shot, 8 files).
# Exactly: api dispatch realtime whitelist-pg qa-g4-security qa-g4-load
# report-resolve profile-parity in ONE invocation; project default forks pool
# (NO worker/sequencing overrides); REPO_IMPL=postgres; N=200; unchanged
# tests/hooks/assertions; controller v3 with 300s guarded cap; G4 probes +
# PG_HARNESS_TRACE=1 kept; behavior-neutral lifecycle reporter.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
API=/tmp/contake/apps/api
FILES="tests/api.test.ts tests/dispatch.test.ts tests/realtime.test.ts tests/whitelist-pg.test.ts tests/qa-g4-security.test.ts tests/qa-g4-load.test.ts tests/report-resolve.test.ts tests/profile-parity.test.ts"
LOG=/tmp/g4-suite-run.log
DIAG=/tmp/g4-suite-probes.jsonl
EXT=/tmp/g4-suite-ext.jsonl
SELFTEST=/tmp/g4-suite-selftest.log
MANIFEST=/tmp/g4-suite-manifest.txt
rm -f "$DIAG" "$EXT" /tmp/g4-suite-exitcode

if ! "$HERE/self-test.sh" > "$SELFTEST" 2>&1; then
  echo "SELF-TEST FAILED - aborting before Vitest, preserving artifacts" >> "$SELFTEST"
  sha256sum "$SELFTEST" > "$SELFTEST.sha256"
  cat "$SELFTEST"
  exit 1
fi

cd "$API"
VITEST_BIN=$(readlink -f node_modules/.bin/vitest)
VITEST_PKGVER=$(node -p "require('./node_modules/vitest/package.json').version")
cd /tmp/contake
{
  echo "=== PROVENANCE HEADER (pre-run, contemporaneous) ==="
  echo "start: $(date -Iseconds)"
  echo "HEAD: $(git rev-parse HEAD)"
  echo "tree: $(git rev-parse 'HEAD^{tree}')"
  echo "parent: $(git rev-parse HEAD^)"
  echo "git-status-porcelain: [$(git status --porcelain)]"
  echo "command: REPO_IMPL=postgres PG_HARNESS_TRACE=1 G4_DIAG_LOG=$DIAG G4_EXT_LOG=$EXT node_modules/.bin/vitest run $FILES --reporter=default --reporter=$API/tests/helpers/g4-diag-reporter.mjs (cwd apps/api)"
  echo "scope: exactly 8 files, ONE invocation; pool: project default (forks, NO worker/sequencing overrides); N=200 (G4_N unset); cap 300s guarded process-group cleanup"
  echo "env: REPO_IMPL=postgres PG_HARNESS_TRACE=1 G4_DIAG_LOG G4_EXT_LOG (no G4_N, no STRESS_OPT_IN)"
  echo "vitest-resolved-bin: $VITEST_BIN"
  echo "vitest-package-version: $VITEST_PKGVER"
  echo "node: $(node --version)"
  echo "npm: $(npm --version)"
  echo "pnpm-lockfile-sha256: $(sha256sum pnpm-lock.yaml | awk '{print $1}')"
  echo "file-hashes:"
  ( cd "$API" && sha256sum $FILES tests/helpers/repo.ts tests/helpers/g4-diag.ts tests/helpers/g4-diag-reporter.mjs vitest.config.ts | sed 's/^/  /' )
  echo "cpus: $(nproc)"
  echo "mem: $(free -m | head -2 | tail -1)"
  echo "loadavg: $(cat /proc/loadavg)"
  echo "self-test: PASS (see $SELFTEST)"
  echo "=== BEGIN VITEST ==="
} > "$LOG" 2>&1

cd "$API"
setsid bash -c "REPO_IMPL=postgres PG_HARNESS_TRACE=1 G4_DIAG_LOG=$DIAG G4_EXT_LOG=$EXT node_modules/.bin/vitest run $FILES --reporter=default --reporter=$API/tests/helpers/g4-diag-reporter.mjs >> $LOG 2>&1; echo \$? > /tmp/g4-suite-exitcode" &
VPID=$!
VPGID=""
for _ in $(seq 1 50); do
  VPGID=$(ps -o pgid= -p "$VPID" 2>/dev/null | tr -d ' ')
  [ -n "$VPGID" ] && [ "$VPGID" = "$VPID" ] && break
  sleep 0.1
done
if [ "$VPGID" != "$VPID" ]; then
  echo "pgid resolution FAILED for vitest child $VPID (got '$VPGID') - aborting conservatively" >> "$LOG"
  [ -n "$VPGID" ] && [ "$VPGID" != "$(ps -o pgid= -p $$ | tr -d ' ')" ] && kill -TERM -"$VPGID" 2>/dev/null
  exit 1
fi
jq -nc --arg ts "$(date -Iseconds)" --argjson pid "$VPID" --argjson pgid "$VPGID" '{ts:$ts,ev:"vitest-launched",pid:$pid,pgid:$pgid}' >> "$EXT"
"$HERE/ext-sampler.sh" "$VPGID" "$EXT" 300 &
SPID=$!
wait "$VPID"
RC=$(cat /tmp/g4-suite-exitcode 2>/dev/null || echo 99)
jq -nc --arg ts "$(date -Iseconds)" --argjson rc "$RC" '{ts:$ts,ev:"vitest-exited",exit_code:$rc}' >> "$EXT"
wait "$SPID" 2>/dev/null
LEFT=$(pgrep -g "$VPGID" 2>/dev/null | wc -l)
jq -nc --arg ts "$(date -Iseconds)" --argjson n "$LEFT" '{ts:$ts,ev:"wrapper-residue-check",members_remaining:$n}' >> "$EXT"
cd /tmp/contake
{
  echo "=== END VITEST ==="
  echo "end: $(date -Iseconds)"
  echo "exit-code: $RC"
  grep -E 'Test Files|Tests  ' "$LOG" | tail -2 | sed 's/^/summary: /'
  echo "residue: $LEFT group members remaining"
  echo "host-recovery: loadavg [$(cat /proc/loadavg)] mem [$(free -m | head -2 | tail -1)]"
} >> "$LOG"
: > "$MANIFEST"
for f in "$LOG" "$DIAG" "$EXT" "$SELFTEST"; do
  if [ -f "$f" ]; then sha256sum "$f" | tee -a "$MANIFEST" > "$f.sha256"; fi
done
echo "RUNNER-DONE rc=$RC"
