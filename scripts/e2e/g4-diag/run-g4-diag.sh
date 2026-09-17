#!/usr/bin/env bash
# G4 diagnostic runner v2 (QA-authorized one-shot sampler-fixed repeat).
# Identical scope: N=200, single file qa-g4-load.test.ts, one worker, quiet
# box, unchanged assertions/timeouts. Controller correction: verified pgid
# resolution before sampler start, guarded cap, controller self-test
# pre-flight (abort + preserve if validation fails), exact project Vitest
# identity (fixes root-vs-project 5.0.1/3.2.7 label mismatch).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
cd /tmp/contake
LOG=/tmp/g4-diag-run2.log
DIAG=/tmp/g4-diag2.jsonl
EXT=/tmp/g4-ext2.jsonl
SELFTEST=/tmp/g4-selftest-run2.log
MANIFEST=/tmp/g4-diag2-manifest.txt
rm -f "$DIAG" "$EXT" /tmp/g4-diag-exitcode2

# --- controller self-test BEFORE Vitest (abort and preserve if it fails) ---
if ! "$HERE/self-test.sh" > "$SELFTEST" 2>&1; then
  echo "SELF-TEST FAILED - aborting before Vitest, preserving artifacts" >> "$SELFTEST"
  for f in "$SELFTEST"; do sha256sum "$f" > "$f.sha256"; done
  cat "$SELFTEST"
  exit 1
fi

cd /tmp/contake/apps/api
VITEST_BIN=$(readlink -f node_modules/.bin/vitest)
VITEST_PKGVER=$(node -p "require('./node_modules/vitest/package.json').version")
VITEST_NPXVER=$(npx vitest --version 2>/dev/null | head -1)
cd /tmp/contake
{
  echo "=== PROVENANCE HEADER (pre-run, contemporaneous) ==="
  echo "start: $(date -Iseconds)"
  echo "HEAD: $(git rev-parse HEAD)"
  echo "tree: $(git rev-parse 'HEAD^{tree}')"
  echo "parent: $(git rev-parse HEAD^)"
  echo "git-status-porcelain: [$(git status --porcelain)]"
  echo "controller: scripts/e2e/g4-diag/{ext-sampler,run-g4-diag,self-test}.sh (v2, in this commit)"
  echo "self-test: PASS (see $SELFTEST)"
  echo "command: REPO_IMPL=postgres PG_HARNESS_TRACE=1 G4_DIAG_LOG=$DIAG node_modules/.bin/vitest run tests/qa-g4-load.test.ts --maxWorkers=1 --minWorkers=1 (cwd apps/api)"
  echo "scope: single file, one worker, no other load; external sampler 1s; cap 600s with guarded process-group cleanup"
  echo "vitest-resolved-bin: $VITEST_BIN"
  echo "vitest-package-version: $VITEST_PKGVER"
  echo "vitest-npx-version-from-apps-api: $VITEST_NPXVER"
  echo "node: $(node --version)"
  echo "npm: $(npm --version)"
  echo "pnpm-lockfile-sha256: $(sha256sum pnpm-lock.yaml | awk '{print $1}')"
  echo "cpus: $(nproc)"
  echo "mem: $(free -m | head -2 | tail -1)"
  echo "loadavg: $(cat /proc/loadavg)"
  echo "=== BEGIN VITEST ==="
} > "$LOG" 2>&1

cd apps/api
setsid bash -c "REPO_IMPL=postgres PG_HARNESS_TRACE=1 G4_DIAG_LOG=$DIAG node_modules/.bin/vitest run tests/qa-g4-load.test.ts --maxWorkers=1 --minWorkers=1 >> $LOG 2>&1; echo \$? > /tmp/g4-diag-exitcode2" &
VPID=$!
# verified pgid resolution (root cause of v1 sampler failure: first sample
# raced the child's setsid() call and falsely declared target-exit)
VPGID=""
for _ in $(seq 1 50); do
  VPGID=$(ps -o pgid= -p "$VPID" 2>/dev/null | tr -d ' ')
  [ -n "$VPGID" ] && [ "$VPGID" = "$VPID" ] && break
  sleep 0.1
done
if [ "$VPGID" != "$VPID" ]; then
  echo "pgid resolution FAILED for vitest child $VPID (got '$VPGID') - aborting, killing child group conservatively" >> "$LOG"
  [ -n "$VPGID" ] && [ "$VPGID" != "$(ps -o pgid= -p $$ | tr -d ' ')" ] && kill -TERM -"$VPGID" 2>/dev/null
  exit 1
fi
jq -nc --arg ts "$(date -Iseconds)" --argjson pid "$VPID" --argjson pgid "$VPGID" '{ts:$ts,ev:"vitest-launched",pid:$pid,pgid:$pgid}' >> "$EXT"
"$HERE/ext-sampler.sh" "$VPGID" "$EXT" 600 &
SPID=$!
wait "$VPID"
RC=$(cat /tmp/g4-diag-exitcode2 2>/dev/null || echo 99)
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
# sidecar manifest immediately
: > "$MANIFEST"
for f in "$LOG" "$DIAG" "$EXT" "$SELFTEST"; do
  if [ -f "$f" ]; then sha256sum "$f" | tee -a "$MANIFEST" > "$f.sha256"; fi
done
echo "RUNNER-DONE rc=$RC"
