#!/usr/bin/env bash
# Self-test for controller v4 + guardian v4 + sampler (v4 family).
# QA-required scenarios (verbatim): normal exit; cap expiry; forced
# parent/controller death with guardian cleanup; TERM-resistant child
# requiring KILL; incremental output/artifact persistence; PGID guard;
# outer-timeout preflight refusal; zero residue.
# usage: self-test-v4.sh
set -u
D=$(cd "$(dirname "$0")" && pwd)
FAILS=0
note() { echo "[selftest-v4] $*"; }
rm -rf /tmp/g4-ctrl-st1 /tmp/g4-ctrl-st2 /tmp/g4-ctrl-st3 /tmp/g4-ctrl-st4 /tmp/g4-ctrl-st5 /tmp/g4-ctrl-st7

residue_of() { local r=$1; local pgid; pgid=$(jq -r '.target_pgid' "$r/deadline.json" 2>/dev/null || echo 0); if [ "$pgid" != "0" ]; then pgrep -g "$pgid" 2>/dev/null | wc -l; else echo 0; fi; }

# --- 1. normal exit -------------------------------------------------------
note "1: normal exit"
R1=/tmp/g4-ctrl-st1
setsid "$D/controller.sh" --label st1 --cap 60 --workdir /tmp -- bash -c 'sleep 2' >/dev/null 2>&1 &
C1=$!; wait "$C1"; RC1=$?
sleep 4
G1=ok
[ "$RC1" -eq 0 ] || G1="FAIL rc=$RC1"
[ "$(residue_of "$R1")" = "0" ] || G1="FAIL residue=$(residue_of "$R1")"
[ -f "$R1/done" ] || G1="FAIL no-done-marker"
grep -q '"ev":"controller-done","rc":0' "$R1/events.jsonl" 2>/dev/null || G1="FAIL no-controller-done-event"
grep -q 'guardian-done-observed' "$R1/guardian.jsonl" 2>/dev/null || G1="FAIL guardian-not-done"
grep -q '"ev":"sampler-done","reason":"target-exit"' "$R1/ext.jsonl" 2>/dev/null || G1="FAIL sampler-exit-event"
note "  -> $G1"; [ "$G1" = ok ] || FAILS=$((FAILS+1))

# --- 2. cap expiry --------------------------------------------------------
note "2: cap expiry (cap 6s, experiment sleeps 300s)"
R2=/tmp/g4-ctrl-st2
setsid "$D/controller.sh" --label st2 --cap 6 --workdir /tmp -- bash -c 'sleep 300' >/dev/null 2>&1 &
C2=$!; wait "$C2"
sleep 3
G2=ok
grep -q '"ev":"cap-reached"' "$R2/ext.jsonl" || G2="FAIL no-cap-event"
grep -q '"ev":"sigterm-sent"' "$R2/ext.jsonl" || G2="FAIL no-term"
[ "$(residue_of "$R2")" = "0" ] || G2="FAIL residue=$(residue_of "$R2")"
grep -q 'guardian-done-observed' "$R2/guardian.jsonl" 2>/dev/null || G2="FAIL guardian-not-done"
note "  -> $G2"; [ "$G2" = ok ] || FAILS=$((FAILS+1))

# --- 3. forced controller death + guardian cleanup ------------------------
note "3: forced controller death (kill -KILL controller group at ~4s; guardian enforces deadline cap 14s)"
R3=/tmp/g4-ctrl-st3
setsid "$D/controller.sh" --label st3 --cap 14 --workdir /tmp -- bash -c 'sleep 300' >/dev/null 2>&1 &
C3=$!
sleep 4
CPGID=$(ps -o pgid= -p "$C3" | tr -d ' ')
kill -KILL -"$CPGID" 2>/dev/null   # kills controller + sampler only; guardian and experiment are separate sessions
wait "$C3" 2>/dev/null
note "  controller group $CPGID killed; assessing after deadline passes (scenarios 4-5 run meanwhile)"

# --- 4. TERM-resistant child requires KILL --------------------------------
note "4: TERM-resistant child (cap 6s, child ignores TERM)"
R4=/tmp/g4-ctrl-st4
setsid "$D/controller.sh" --label st4 --cap 6 --workdir /tmp -- bash -c 'trap "" TERM; while true; do sleep 1; done' >/dev/null 2>&1 &
C4=$!; wait "$C4"
sleep 3
G4=ok
grep -q '"ev":"sigterm-sent"' "$R4/ext.jsonl" || G4="FAIL no-term"
grep -q '"ev":"sigkill-sent"' "$R4/ext.jsonl" || G4="FAIL no-kill"
[ "$(residue_of "$R4")" = "0" ] || G4="FAIL residue=$(residue_of "$R4")"
note "  -> $G4"; [ "$G4" = ok ] || FAILS=$((FAILS+1))

# --- 5. incremental output/artifact persistence ---------------------------
note "5: incremental persistence (cap 6s; experiment writes 60 lines/1s; artifacts must hold writes up to kill)"
R5=/tmp/g4-ctrl-st5
setsid "$D/controller.sh" --label st5 --cap 6 --workdir /tmp -- bash -c 'i=0; while [ $i -lt 60 ]; do echo "line-$i"; i=$((i+1)); sleep 1; done' >/dev/null 2>&1 &
C5=$!; wait "$C5"
sleep 2
G5=ok
LINES=$(grep -c '^line-' "$R5/experiment.log" 2>/dev/null) || true
LINES=${LINES:-0}
[ "$LINES" -ge 4 ] || G5="FAIL only $LINES persisted lines"
for f in ext.jsonl events.jsonl guardian.jsonl; do
  grep '^{' "$R5/$f" 2>/dev/null | jq -e . >/dev/null 2>&1 || { G5="FAIL $f corrupt"; break; }
done
grep -q '"ev":"sample"' "$R5/ext.jsonl" || G5="FAIL no samples persisted"
note "  -> $G5 ($LINES experiment lines persisted through forced kill)"; [ "$G5" = ok ] || FAILS=$((FAILS+1))

# --- scenario 3 assessment (deadline now passed) ---------------------------
sleep 8
G3=ok
grep -q 'guardian-deadline-expired' "$R3/guardian.jsonl" || G3="FAIL no-deadline-event"
grep -q 'guardian-residue","members_remaining":0' "$R3/guardian.jsonl" || G3="FAIL guardian-residue-nonzero"
grep -q 'guardian diagnostics' "$R3/guardian.jsonl" || G3="FAIL no-diagnostics"
[ -f "$R3/done" ] && G3="FAIL done-marker-present (controller dead, none expected)"
if [ -f "$R3/events.jsonl" ] && grep -q '"ev":"controller-done"' "$R3/events.jsonl"; then G3="FAIL controller-done-present"; fi
note "3 result -> $G3"; [ "$G3" = ok ] || FAILS=$((FAILS+1))

# --- 6. PGID guard ---------------------------------------------------------
note "6: PGID guard (bad pgids refused)"
G6=ok
for bad in "" 1 $$; do
  "$D/ext-sampler.sh" $bad /dev/null 5 >/dev/null 2>&1
  [ "$?" -eq 2 ] || { G6="FAIL accepted bad pgid '$bad'"; break; }
done
note "  -> $G6"; [ "$G6" = ok ] || FAILS=$((FAILS+1))

# --- 7. outer-timeout preflight refusal ------------------------------------
note "7: preflight refusal (controller NOT session leader; OUTER_TIMEOUT_S=10 < cap 60)"
R7=/tmp/g4-ctrl-st7
OUTER_TIMEOUT_S=10 "$D/controller.sh" --label st7 --cap 60 --workdir /tmp -- bash -c 'sleep 1' >/dev/null 2>&1
RC7=$?
G7=ok
[ "$RC7" -eq 2 ] || G7="FAIL rc=$RC7"
grep -q '"ev":"preflight-refuse"' "$R7/events.jsonl" || G7="FAIL no-preflight-event"
[ -f "$R7/deadline.json" ] && G7="FAIL deadline persisted despite refusal"
note "  -> $G7"; [ "$G7" = ok ] || FAILS=$((FAILS+1))

# --- 8. zero residue (global) ----------------------------------------------
note "8: zero residue (global sweep)"
sleep 2
G8=ok
STRAY=$(pgrep -af 'ext-sampler.sh|guardian.sh|sleep 300' 2>/dev/null || true)
[ -z "$STRAY" ] || G8="FAIL stray: $STRAY"
note "  -> $G8"; [ "$G8" = ok ] || FAILS=$((FAILS+1))

note "self-test v4 complete: $FAILS failure(s)"
[ "$FAILS" -eq 0 ]
