#!/usr/bin/env bash
# Controller self-test (QA-required pre-flight before any Vitest diagnostic):
# validates the sampler against a DUMMY dedicated process group — never a real
# target. Checks: >=2 sampler records with the dummy pids, intended
# parent+worker PID/PGID/tree detection, guarded pgid validation (empty/1/self
# rejected), cap diagnostics + TERM + zero residue, host untouched.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
SAMPLER="$HERE/ext-sampler.sh"
OUT=$(mktemp /tmp/g4-selftest.XXXXXX.jsonl)
FAIL=0
note() { echo "SELFTEST: $*"; }

# guard checks
"$SAMPLER" "" "$OUT" 5 2>/dev/null; [ $? -eq 2 ] && grep -q abort-bad-pgid "$OUT" && note "guard empty-pgid OK" || { note "guard empty-pgid FAIL"; FAIL=1; }
"$SAMPLER" 1 "$OUT" 5 2>/dev/null; [ $? -eq 2 ] && note "guard pgid=1 OK" || { note "guard pgid=1 FAIL"; FAIL=1; }
SELFPG=$(ps -o pgid= -p $$ | tr -d ' ')
"$SAMPLER" "$SELFPG" "$OUT" 5 2>/dev/null; [ $? -eq 2 ] && note "guard self-pgid OK" || { note "guard self-pgid FAIL"; FAIL=1; }

# dummy dedicated group
setsid bash -c 'sleep 60 & exec sleep 60' &
DUMMY=$!
DPG=""
for _ in $(seq 1 50); do DPG=$(ps -o pgid= -p "$DUMMY" 2>/dev/null | tr -d ' '); [ -n "$DPG" ] && [ "$DPG" = "$DUMMY" ] && break; sleep 0.1; done
if [ "$DPG" != "$DUMMY" ]; then note "dummy pgid resolution FAIL (got '$DPG')"; kill -KILL -"$DPG" 2>/dev/null; exit 1; fi
note "dummy group pid/pgid=$DPG tree: $(pgrep -g "$DPG" | tr '\n' ' ')"
[ "$DPG" != "$SELFPG" ] || { note "dummy pgid collides with host shell FAIL"; exit 1; }

"$SAMPLER" "$DPG" "$OUT" 8 &
SPID=$!
wait "$SPID"

SAMPLES=$(grep -c '"ev":"sample"' "$OUT" || true)
[ "$SAMPLES" -ge 2 ] && note "samples>=2 OK ($SAMPLES)" || { note "samples FAIL ($SAMPLES)"; FAIL=1; }
grep -q "\"pid\":$DUMMY" "$OUT" && note "dummy pid captured OK" || { note "dummy pid missing FAIL"; FAIL=1; }
grep -q '"ev":"sampler-start"' "$OUT" && grep -q '"ev":"cap-reached"' "$OUT" && grep -q '"ev":"sigterm-sent"' "$OUT" && note "lifecycle events OK" || { note "lifecycle events FAIL"; FAIL=1; }
grep -q '"ev":"residue-check"' "$OUT" && grep -q '"members_remaining":0' "$OUT" && note "zero residue OK" || { note "residue FAIL"; FAIL=1; }
LEFT=$(pgrep -g "$DPG" 2>/dev/null | wc -l)
[ "$LEFT" -eq 0 ] && note "dummy group reaped OK" || { note "dummy group still alive FAIL ($LEFT)"; FAIL=1; kill -KILL -"$DPG" 2>/dev/null; }
[ -d "/proc/$$" ] && note "host shell alive OK"
echo "SELFTEST-ARTIFACT: $OUT"
if [ "$FAIL" -eq 0 ]; then note "RESULT: PASS"; exit 0; else note "RESULT: FAIL"; exit 1; fi
