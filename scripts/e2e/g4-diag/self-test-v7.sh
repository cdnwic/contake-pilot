#!/usr/bin/env bash
# Self-test v7 (controller v7 family). QA scenarios: guardian alive before
# sentinel creation (two-ack); sentinel timeout derived from the absolute
# deadline + margin; pre-publication SIGKILL with wall-clock proof of cleanup
# by original CAP+grace; bounded reap distinguishing reaped from absent;
# normal completion requires residue 0 (residue => nonzero, never success);
# carried v6 scenarios. Run dirs preserved (never rm).
set -u
D=$(cd "$(dirname "$0")" && pwd)
export CTRL_RUN_BASE=/tmp/g4-v7 GUARDIAN_GRACE_S=4 SENTINEL_MARGIN_S=8
mkdir -p /tmp/g4-v7
FAILS=0
note() { echo "[selftest-v7] $*"; }
ok()   { local v="$1"; shift || true; note "  -> $v $*"; [ "$v" = ok ] || FAILS=$((FAILS+1)); }
latest() { ls -dt /tmp/g4-v7/g4-ctrl-"$1"-* 2>/dev/null | head -1; }
jsonlines_valid() { grep '^{' "$1" 2>/dev/null | jq -e . >/dev/null 2>&1; }
wait_for() { local i=0; while [ $i -lt $(( $3 * 4 )) ]; do grep -q "$2" "$1" 2>/dev/null && return 0; sleep 0.25; i=$((i+1)); done; return 1; }
residue_of() { local pgid; pgid=$(jq -r '.pgid // 0' "$1/identity.json" 2>/dev/null || echo 0); if [ "$pgid" != "0" ] && [ -n "$pgid" ]; then pgrep -g "$pgid" 2>/dev/null | wc -l; else echo 0; fi; }
epoch_of_event() { local ts; ts=$(grep "$2" "$1" 2>/dev/null | head -1 | jq -r '.ts' 2>/dev/null); [ -n "$ts" ] && [ "$ts" != "null" ] && date -d "$ts" +%s || echo ""; }

# --- A: normal exit, two-ack, success requires residue 0 ----------------------
note "A: normal exit with armed ack + bound ack"
setsid "$D/controller.sh" --label na --cap 30 --workdir /tmp -- bash -c 'sleep 2' >/dev/null 2>&1 &
C=$!; wait "$C"; RC=$?; R=$(latest na); wait_for "$R/guardian.jsonl" 'guardian-done-observed' 15
G=ok
[ "$RC" -eq 0 ] || G="FAIL rc=$RC"
A1=$(jq -r '.deadline_epoch' "$R/guardian-armed.json" 2>/dev/null); DL=$(jq -r '.deadline_epoch' "$R/deadline.json")
[ "$A1" = "$DL" ] || G="FAIL ack1 deadline $A1 != $DL"
[ -f "$R/launch-intent.json" ] || G="FAIL no launch-intent"
AB=$(jq -r '[.bound_pid,.bound_pgid,.bound_sid,.bound_ticks]|@csv' "$R/guardian-ack.json" 2>/dev/null)
ID=$(jq -r '[.pid,.pgid,.sid,.start_ticks]|@csv' "$R/identity.json" 2>/dev/null)
[ "$AB" = "$ID" ] || G="FAIL ack2 mismatch"
grep -q '"ev":"guardian-armed".*guardian-launched\|"ev":"guardian-launched"' "$R/events.jsonl" || G="FAIL guardian launch event"
grep -q '"ev":"experiment-outcome","outcome":"success"' "$R/events.jsonl" || G="FAIL outcome"
grep -q '"ev":"cleanup-complete","residue":0' "$R/events.jsonl" || G="FAIL cleanup"
grep -q 'guardian-done-observed' "$R/guardian.jsonl" || G="FAIL guardian-not-done"
# guardian armed before sentinel existed: armed ts <= identity-published ts
AT=$(epoch_of_event "$R/guardian.jsonl" '"ev":"guardian-armed"'); IT=$(epoch_of_event "$R/events.jsonl" '"ev":"identity-published"')
[ -n "$AT" ] && [ -n "$IT" ] && [ "$AT" -le "$IT" ] || G="FAIL guardian not alive before sentinel identity"
ok "$G"

# --- B: cap expiry -> 124 ------------------------------------------------------
note "B: cap expiry (cap 6; sleep 300)"
setsid "$D/controller.sh" --label nb --cap 6 --workdir /tmp -- bash -c 'sleep 300' >/dev/null 2>&1 &
C=$!; wait "$C"; RC=$?; R=$(latest nb); wait_for "$R/guardian.jsonl" 'guardian-done-observed' 30
G=ok
[ "$RC" -eq 124 ] || G="FAIL rc=$RC"
[ -f "$R/cap-fired" ] || G="FAIL no cap-fired"
grep -q '"outcome":"cap-killed"' "$R/events.jsonl" || G="FAIL outcome"
grep -q '"outcome":"success"' "$R/events.jsonl" && G="FAIL success claimed"
grep -q 'guardian-done-observed' "$R/guardian.jsonl" || G="FAIL guardian-not-done"
[ "$(residue_of "$R")" = "0" ] || G="FAIL residue"
ok "$G"

# --- C: controller death mid-run, guardian cleanup -------------------------------
note "C: controller killed at 4s mid-run (cap 14, grace 4)"
setsid "$D/controller.sh" --label nc --cap 14 --workdir /tmp -- bash -c 'sleep 300' >/dev/null 2>&1 &
C=$!; sleep 4
kill -KILL -"$(ps -o pgid= -p "$C" | tr -d ' ')" 2>/dev/null; wait "$C" 2>/dev/null
R=$(latest nc); wait_for "$R/guardian.jsonl" 'guardian-residue' 40
G=ok
grep -q 'guardian-deadline-expired' "$R/guardian.jsonl" || G="FAIL no enforcement"
grep -q '"ev":"guardian-residue","members_remaining":0' "$R/guardian.jsonl" || G="FAIL residue-nonzero"
[ -f "$R/done" ] && G="FAIL done present"
ok "$G"

# --- D: TERM-resistant child via sampler --------------------------------------------
note "D: TERM-resistant child (cap 6)"
setsid "$D/controller.sh" --label nd --cap 6 --workdir /tmp -- bash -c 'trap "" TERM; while true; do sleep 1; done' >/dev/null 2>&1 &
C=$!; wait "$C"; RC=$?; R=$(latest nd); sleep 2
G=ok
[ "$RC" -eq 124 ] || G="FAIL rc=$RC"
grep -q '"ev":"sigkill-sent"' "$R/ext.jsonl" || G="FAIL no kill"
[ "$(residue_of "$R")" = "0" ] || G="FAIL residue"
ok "$G"

# --- E: guardian enforces on TERM-RESISTANT target after controller death -------------
note "E: controller killed at 4s; TERM-resistant target (cap 14, grace 4)"
setsid "$D/controller.sh" --label ne --cap 14 --workdir /tmp -- bash -c 'trap "" TERM; while true; do sleep 1; done' >/dev/null 2>&1 &
C=$!; sleep 4
kill -KILL -"$(ps -o pgid= -p "$C" | tr -d ' ')" 2>/dev/null; wait "$C" 2>/dev/null
R=$(latest ne); wait_for "$R/guardian.jsonl" 'guardian-residue' 50
G=ok
grep -q '"ev":"guardian-term-sent"' "$R/guardian.jsonl" || G="FAIL no term"
grep -q '"ev":"guardian-kill-sent"' "$R/guardian.jsonl" || G="FAIL no kill"
grep -q '"ev":"guardian-residue","members_remaining":0' "$R/guardian.jsonl" || G="FAIL residue-nonzero"
ok "$G"

# --- F: incremental persistence --------------------------------------------------------
note "F: incremental persistence (cap 6)"
setsid "$D/controller.sh" --label nf --cap 6 --workdir /tmp -- bash -c 'i=0; while [ $i -lt 60 ]; do echo "line-$i"; i=$((i+1)); sleep 1; done' >/dev/null 2>&1 &
C=$!; wait "$C"; R=$(latest nf); sleep 2
G=ok
LINES=$(grep -c '^line-' "$R/experiment.log" 2>/dev/null) || true; LINES=${LINES:-0}
[ "$LINES" -ge 4 ] || G="FAIL only $LINES lines"
jsonlines_valid "$R/events.jsonl" || G="FAIL events invalid"
jsonlines_valid "$R/guardian.jsonl" || G="FAIL guardian invalid"
grep -q '"ev":"sample"' "$R/ext.jsonl" || G="FAIL no samples"
ok "$G" "($LINES lines)"

# --- G: PGID guard ------------------------------------------------------------------------
note "G: PGID guard"
G=ok
for bad in "" 1 $$; do
  "$D/ext-sampler.sh" $bad /dev/null 5 >/dev/null 2>&1
  [ "$?" -eq 2 ] || { G="FAIL accepted '$bad'"; break; }
done
ok "$G"

# --- H: identity mismatch refusal ------------------------------------------------------------
note "H: identity mismatch refusal (guardian + sampler), target survives"
HDIR=/tmp/g4-v7/manual-id; rm -rf "$HDIR"; mkdir -p "$HDIR"
setsid bash -c 'sleep 60' & DP=$!; sleep 0.5
DPGID=$(ps -o pgid= -p "$DP" | tr -d ' '); DSID=$(ps -o sid= -p "$DP" | tr -d ' ')
jq -nc --argjson d $(( $(date +%s) + 60 )) --arg s "sent-1" --arg r "$HDIR" '{deadline_epoch:$d,sentinel:$s,run_dir:$r}' > "$HDIR/deadline.json"
jq -nc --argjson p "$DP" --argjson g "$DPGID" --argjson s "$DSID" --argjson t 999999999 --arg sent "sent-1" \
  '{pid:$p,pgid:$g,sid:$s,start_ticks:$t,sentinel:$sent,bound_pre_exec:true}' > "$HDIR/identity.json"
GUARDIAN_GRACE_S=4 "$D/guardian.sh" "$HDIR/deadline.json"; GRC=$?
G=ok
[ "$GRC" -eq 4 ] || G="FAIL guardian rc=$GRC (want 4)"
grep -q '"ev":"guardian-identity-refuse"' "$HDIR/guardian.jsonl" || G="FAIL no refuse event"
[ -f "$HDIR/guardian-armed.json" ] || G="FAIL no armed ack1"
[ -f "$HDIR/guardian-ack.json" ] && G="FAIL ack2 written despite mismatch"
jsonlines_valid "$HDIR/guardian.jsonl" || G="FAIL guardian invalid JSON"
kill -0 "$DP" 2>/dev/null || G="FAIL target killed despite refusal"
"$D/ext-sampler.sh" "$DPGID" "$HDIR/ext.jsonl" 1 "$HDIR" "$HDIR/identity.json" "wrong-sentinel" >/dev/null 2>&1; SRC=$?
[ "$SRC" -eq 3 ] || G="FAIL sampler rc=$SRC (want 3)"
kill -0 "$DP" 2>/dev/null || G="FAIL target killed by sampler"
kill -KILL -"$DPGID" 2>/dev/null
ok "$G"

# --- I: preflight refusals ---------------------------------------------------------------------
note "I: preflight refusals"
G=ok
OUTER_TIMEOUT_S=10 "$D/controller.sh" --label pi --cap 60 --workdir /tmp -- true >/dev/null 2>&1; [ "$?" -eq 2 ] || G="FAIL outer-timeout"
for badcap in 0 -5 abc 99999999; do
  "$D/controller.sh" --label pc --cap "$badcap" --workdir /tmp -- true >/dev/null 2>&1
  [ "$?" -eq 2 ] || { G="FAIL cap '$badcap'"; break; }
done
"$D/controller.sh" --label '../x' --cap 5 --workdir /tmp -- true >/dev/null 2>&1; [ "$?" -eq 2 ] || G="FAIL label"
CTRL_RUN_BASE=/proc "$D/controller.sh" --label pw --cap 5 --workdir /tmp -- true >/dev/null 2>&1; [ "$?" -eq 2 ] || G="FAIL unwritable base"
ok "$G"

# --- J: stale done/deadline/malformed -------------------------------------------------------------
note "J: stale done/deadline/malformed"
G=ok
SD=/tmp/g4-v7/manual-stale; rm -rf "$SD"; mkdir -p "$SD"
jq -nc --argjson d $(( $(date +%s) - 100 )) --arg s x '{deadline_epoch:$d,sentinel:$s}' > "$SD/deadline.json"; touch "$SD/done"
GUARDIAN_GRACE_S=0 "$D/guardian.sh" "$SD/deadline.json"; [ "$?" -eq 0 ] || G="FAIL stale-done rc"
grep -q '"ev":"guardian-done-observed"' "$SD/guardian.jsonl" || G="FAIL stale-done"
SD2=/tmp/g4-v7/manual-malformed; rm -rf "$SD2"; mkdir -p "$SD2"
echo 'not json{{{' > "$SD2/deadline.json"
GUARDIAN_GRACE_S=0 "$D/guardian.sh" "$SD2/deadline.json"; [ "$?" -eq 3 ] || G="FAIL malformed rc"
grep -q '"ev":"guardian-invalid-deadline-file"' "$SD2/guardian.jsonl" || G="FAIL malformed event"
jsonlines_valid "$SD2/guardian.jsonl" || G="FAIL malformed JSON"
SD3=/tmp/g4-v7/manual-past; rm -rf "$SD3"; mkdir -p "$SD3"
jq -nc --argjson d $(( $(date +%s) - 100 )) --arg s x '{deadline_epoch:$d,sentinel:$s}' > "$SD3/deadline.json"
GUARDIAN_GRACE_S=0 "$D/guardian.sh" "$SD3/deadline.json"; [ "$?" -eq 0 ] || G="FAIL past rc"
grep -q '"ev":"guardian-no-identity-at-enforce-window"' "$SD3/guardian.jsonl" || G="FAIL no-identity event"
ok "$G"

# --- K: concurrent labels ----------------------------------------------------------------------------
note "K: concurrent same-label controllers"
setsid "$D/controller.sh" --label conc --cap 20 --workdir /tmp -- bash -c 'sleep 2' >/dev/null 2>&1 &
K1=$!
setsid "$D/controller.sh" --label conc --cap 20 --workdir /tmp -- bash -c 'sleep 2' >/dev/null 2>&1 &
K2=$!
wait "$K1"; R1=$?; wait "$K2"; R2=$?
N=$(ls -d /tmp/g4-v7/g4-ctrl-conc-* 2>/dev/null | wc -l)
G=ok
[ "$R1" -eq 0 ] && [ "$R2" -eq 0 ] || G="FAIL rc $R1/$R2"
[ "$N" -eq 2 ] || G="FAIL dirs=$N"
ok "$G"

# --- L: kill hooks - SIGKILL across windows, WALL-CLOCK proof cleanup by CAP+grace/margin -------------
note "L: pre-publication SIGKILL hooks with wall-clock proof"
G=ok
kill_at_phase() {
  local lbl="$1" ph="$2"
  SENTINEL_MARGIN_S=8 CTRL_PHASE_SLEEP=1 setsid "$D/controller.sh" --label "$lbl" --cap 8 --workdir /tmp -- bash -c 'sleep 300' >/dev/null 2>&1 &
  local c=$!
  local r=""; local i=0
  while [ $i -lt 60 ]; do
    r=$(latest "$lbl")
    [ -n "$r" ] && [ -f "$r/events.jsonl" ] && grep -q "\"ev\":\"phase-$ph\"" "$r/events.jsonl" && break
    sleep 0.25; i=$((i+1))
  done
  kill -KILL -"$(ps -o pgid= -p "$c" | tr -d ' ')" 2>/dev/null; wait "$c" 2>/dev/null
  KHR="$r"
}
for W in guardian-first launch-intent child-created pgid-read proc-reads identity-pre-rename; do
  kill_at_phase "kw$W" "$W"; R=$KHR
  # cleanup evidence: guardian intent-sweep residue OR sentinel deadline-derived timeout.
  # Pre-creation windows (guardian-first, launch-intent) may leave nothing to clean:
  # proof is the guardian observing no-identity at the enforce time (or no guardian,
  # no sentinel, no identity once the enforce moment has passed).
  DL=$(jq -r '.deadline_epoch' "$R/deadline.json" 2>/dev/null)
  LIMIT=$(( DL + 8 + 2 ))
  PROOF=""; DEADLINE_HIT=""
  for _ in $(seq 1 120); do
    NOW=$(date +%s)
    if grep -q '"ev":"guardian-residue","members_remaining":0' "$R/guardian.jsonl" 2>/dev/null; then
      PROOF=guardian-sweep; DEADLINE_HIT=$(epoch_of_event "$R/guardian.jsonl" '"ev":"guardian-residue"'); break
    fi
    if grep -q 'sentinel-release-timeout' "$R/events.jsonl" 2>/dev/null && ! pgrep -f "sentinel-launch.sh $R" >/dev/null 2>&1; then
      PROOF=sentinel-gate; DEADLINE_HIT=$(epoch_of_event "$R/events.jsonl" 'sentinel-release-timeout'); break
    fi
    if grep -q 'guardian-no-identity-at-enforce-window' "$R/guardian.jsonl" 2>/dev/null        && ! pgrep -f "sentinel-launch.sh $R" >/dev/null 2>&1; then
      PROOF=guardian-nothing-to-clean; DEADLINE_HIT=$(epoch_of_event "$R/guardian.jsonl" 'guardian-no-identity-at-enforce-window'); break
    fi
    if [ ! -f "$R/guardian.jsonl" ] && [ "$NOW" -gt "$LIMIT" ]        && [ ! -f "$R/identity.json" ] && ! pgrep -f "sentinel-launch.sh $R" >/dev/null 2>&1; then
      PROOF=no-guardian-no-orphan; DEADLINE_HIT=$NOW; break
    fi
    sleep 0.5
  done
  [ -n "$PROOF" ] || { G="FAIL $W no cleanup proof"; note "  $W: NO PROOF"; continue; }
  # wall-clock: cleanup state reached by deadline + margin(8) + 2s slack (original CAP + small margin).
  # For no-guardian-no-orphan the controller died before guardian launch, so proof is the
  # absence of any orphan/identity verified once the enforce window has fully passed.
  if [ "$PROOF" != "no-guardian-no-orphan" ]; then
    [ -n "$DEADLINE_HIT" ] && [ "$DEADLINE_HIT" -le "$LIMIT" ] || G="FAIL $W cleanup at $DEADLINE_HIT beyond $LIMIT (deadline $DL)"
  fi
  pgrep -f "sentinel-launch.sh $R" >/dev/null 2>&1 && G="FAIL $W sentinel leaked"
  [ -f "$R/guardian.jsonl" ] && { jsonlines_valid "$R/guardian.jsonl" || G="FAIL $W guardian JSON"; }
  if [ -n "$DEADLINE_HIT" ] && [ "$DEADLINE_HIT" -ge "$DL" ] 2>/dev/null; then
    note "  $W: cleaned by $PROOF at +$(( DEADLINE_HIT - DL ))s after deadline (limit +10s)"
  else
    note "  $W: cleaned by $PROOF (no orphan existed; verified past deadline+margin)"
  fi
done
# W-after-ack: kill after ack2 before release -> guardian enforces strict identity
kill_at_phase kw-ack ack-received; R=$KHR
wait_for "$R/guardian.jsonl" 'guardian-residue' 40
grep -q '"ev":"guardian-residue","members_remaining":0' "$R/guardian.jsonl" 2>/dev/null || G="FAIL ack-window guardian did not clean"
[ ! -f "$R/release" ] || G="FAIL ack-window release written"
note "  ack-received: guardian enforced"
# W-pgid: PGID-resolution failure -> controller kills/reaps blocked sentinel itself
CTRL_TEST_PGID_POISON=1 setsid "$D/controller.sh" --label kpg --cap 8 --workdir /tmp -- bash -c 'sleep 300' >/dev/null 2>&1 &
C7=$!; wait "$C7"; RC7=$?; R=$(latest kpg); sleep 2
[ "$RC7" -eq 2 ] || G="FAIL pgid-fail rc=$RC7"
grep -q '"ev":"launch-failure"' "$R/events.jsonl" || G="FAIL pgid-fail no launch-failure"
grep -q '"ev":"xpid-reaped"' "$R/events.jsonl" || G="FAIL pgid-fail no reap proof"
grep -q '"ev":"cleanup-complete","residue":0' "$R/events.jsonl" || G="FAIL pgid-fail cleanup"
pgrep -f "sentinel-launch.sh $R" >/dev/null 2>&1 && G="FAIL pgid-fail sentinel leaked"
note "  pgid-resolution failure: controller reaped"
ok "$G"

# --- M: controller TERM -> 143 with reap proof ---------------------------------------------------------
note "M: controller TERM"
setsid "$D/controller.sh" --label tm --cap 60 --workdir /tmp -- bash -c 'sleep 300' >/dev/null 2>&1 &
C=$!; sleep 3
kill -TERM "$C" 2>/dev/null; wait "$C"; RC=$?; R=$(latest tm); sleep 2
G=ok
[ "$RC" -eq 143 ] || G="FAIL rc=$RC"
grep -q '"ev":"xpid-reaped"' "$R/events.jsonl" || G="FAIL no reap proof"
grep -q '"ev":"experiment-outcome","outcome":"signal-interrupted"' "$R/events.jsonl" || G="FAIL outcome"
grep -q '"outcome":"success"' "$R/events.jsonl" && G="FAIL success claimed"
[ "$(residue_of "$R")" = "0" ] || G="FAIL residue"
ok "$G"

# --- O: residue on normal path => nonzero, never success --------------------------------------------------
note "O: sampler killed mid-run; stray group member outlives leader"
setsid "$D/controller.sh" --label or --cap 30 --workdir /tmp -- bash -c 'sleep 25 & exec sleep 5' >/dev/null 2>&1 &
C=$!; sleep 2
R=$(latest or)
SP=$(pgrep -f "ext-sampler.sh .* $R/identity.json" | head -1)
[ -n "$SP" ] && kill -KILL "$SP" 2>/dev/null
wait "$C"; RC=$?
G=ok
[ "$RC" -eq 98 ] || G="FAIL rc=$RC (want 98)"
grep -q '"ev":"experiment-outcome","outcome":"residue-left"' "$R/events.jsonl" || G="FAIL outcome not residue-left"
grep -q '"outcome":"success"' "$R/events.jsonl" && G="FAIL success claimed with residue"
grep -q '"ev":"cleanup-complete","residue":0' "$R/events.jsonl" && G="FAIL cleanup claimed zero residue"
ok "$G"

# --- N: zero residue (global) -------------------------------------------------------------------------------
note "N: zero residue (global)"
for _ in $(seq 1 60); do
  STRAY=$(pgrep -af 'sentinel-launch.sh|ext-sampler.sh|guardian.sh|sleep 300|sleep 25' 2>/dev/null | grep -v pgrep || true)
  [ -z "$STRAY" ] && break
  sleep 0.5
done
[ -z "$STRAY" ] && ok ok || ok "FAIL stray: $STRAY"

note "self-test v7 complete: $FAILS failure(s)"
[ "$FAILS" -eq 0 ]
