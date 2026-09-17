#!/usr/bin/env bash
# Self-test v6 (controller v6 family). QA scenarios: normal exit with bound
# ack; cap expiry (truthful 124); forced controller death with guardian
# cleanup; TERM-resistant child via sampler; guardian-after-controller-death
# TERM-resistant target; incremental persistence; PGID guard; identity
# mismatch/PGID-reuse refusal (guardian + sampler, target survives);
# preflight refusals (outer timeout, bounded cap, label, writable path);
# stale done/deadline/malformed (valid-JSON error paths); concurrent labels;
# kill hooks: after child creation before PGID, after PGID, during proc
# reads, before identity rename, after rename before bound ack, after ack
# before release; PGID-resolution failure; controller TERM -> 143; zero
# residue. Run dirs preserved (never rm).
set -u
D=$(cd "$(dirname "$0")" && pwd)
export CTRL_RUN_BASE=/tmp/g4-v6 GUARDIAN_GRACE_S=4 SENTINEL_GATE_S=6
mkdir -p /tmp/g4-v6
FAILS=0
note() { echo "[selftest-v6] $*"; }
ok()   { local v="$1"; shift || true; note "  -> $v $*"; [ "$v" = ok ] || FAILS=$((FAILS+1)); }
latest() { ls -dt /tmp/g4-v6/g4-ctrl-"$1"-* 2>/dev/null | head -1; }
jsonlines_valid() { grep '^{' "$1" 2>/dev/null | jq -e . >/dev/null 2>&1; }
wait_for() { local i=0; while [ $i -lt $(( $3 * 4 )) ]; do grep -q "$2" "$1" 2>/dev/null && return 0; sleep 0.25; i=$((i+1)); done; return 1; }
residue_of() { local pgid; pgid=$(jq -r '.pgid // 0' "$1/identity.json" 2>/dev/null || echo 0); if [ "$pgid" != "0" ] && [ -n "$pgid" ]; then pgrep -g "$pgid" 2>/dev/null | wc -l; else echo 0; fi; }

# --- A: normal exit + bound ack ---------------------------------------------
note "A: normal exit with bound ack"
setsid "$D/controller.sh" --label na --cap 30 --workdir /tmp -- bash -c 'sleep 2' >/dev/null 2>&1 &
C=$!; wait "$C"; RC=$?; R=$(latest na); wait_for "$R/guardian.jsonl" 'guardian-done-observed' 15
G=ok
[ "$RC" -eq 0 ] || G="FAIL rc=$RC"
grep -q '"ev":"identity-published"' "$R/events.jsonl" || G="FAIL no identity-published"
grep -q '"ev":"guardian-acked"' "$R/events.jsonl" || G="FAIL no guardian-acked"
grep -q '"ev":"sentinel-released"' "$R/events.jsonl" || G="FAIL no release"
[ -f "$R/release" ] || G="FAIL no release file"
AB=$(jq -r '[.bound_pid,.bound_pgid,.bound_sid,.bound_ticks]|@csv' "$R/guardian-ack.json" 2>/dev/null)
ID=$(jq -r '[.pid,.pgid,.sid,.start_ticks]|@csv' "$R/identity.json" 2>/dev/null)
[ "$AB" = "$ID" ] || G="FAIL ack ($AB) != identity ($ID)"
grep -q '"ev":"experiment-outcome","outcome":"success"' "$R/events.jsonl" || G="FAIL outcome"
grep -q '"ev":"cleanup-complete","residue":0' "$R/events.jsonl" || G="FAIL cleanup"
grep -q 'guardian-done-observed' "$R/guardian.jsonl" || G="FAIL guardian-not-done"
[ "$(residue_of "$R")" = "0" ] || G="FAIL residue"
ok "$G"

# --- B: cap expiry -> 124 ----------------------------------------------------
note "B: cap expiry (cap 6; sleep 300)"
setsid "$D/controller.sh" --label nb --cap 6 --workdir /tmp -- bash -c 'sleep 300' >/dev/null 2>&1 &
C=$!; wait "$C"; RC=$?; R=$(latest nb); wait_for "$R/guardian.jsonl" 'guardian-done-observed' 30
G=ok
[ "$RC" -eq 124 ] || G="FAIL rc=$RC"
[ -f "$R/cap-fired" ] || G="FAIL no cap-fired"
grep -q '"outcome":"cap-killed"' "$R/events.jsonl" || G="FAIL outcome"
grep -q '"outcome":"success"' "$R/events.jsonl" && G="FAIL success claimed"
grep -q '"ev":"sigterm-sent"' "$R/ext.jsonl" || G="FAIL no sigterm"
grep -q 'guardian-done-observed' "$R/guardian.jsonl" || G="FAIL guardian-not-done"
[ "$(residue_of "$R")" = "0" ] || G="FAIL residue"
ok "$G"

# --- C: forced controller death mid-run, guardian cleanup --------------------
note "C: controller killed at 4s mid-run (cap 14, grace 4)"
setsid "$D/controller.sh" --label nc --cap 14 --workdir /tmp -- bash -c 'sleep 300' >/dev/null 2>&1 &
C=$!; sleep 4
kill -KILL -"$(ps -o pgid= -p "$C" | tr -d ' ')" 2>/dev/null; wait "$C" 2>/dev/null
R=$(latest nc); wait_for "$R/guardian.jsonl" 'guardian-residue' 40
G=ok
grep -q 'guardian-deadline-expired' "$R/guardian.jsonl" || G="FAIL no enforcement"
grep -q 'guardian diagnostics' "$R/guardian.jsonl" || G="FAIL no diagnostics"
grep -q '"ev":"guardian-residue","members_remaining":0' "$R/guardian.jsonl" || G="FAIL residue-nonzero"
[ -f "$R/done" ] && G="FAIL done present"
ok "$G"

# --- D: TERM-resistant child via sampler --------------------------------------
note "D: TERM-resistant child (cap 6)"
setsid "$D/controller.sh" --label nd --cap 6 --workdir /tmp -- bash -c 'trap "" TERM; while true; do sleep 1; done' >/dev/null 2>&1 &
C=$!; wait "$C"; RC=$?; R=$(latest nd); sleep 2
G=ok
[ "$RC" -eq 124 ] || G="FAIL rc=$RC"
grep -q '"ev":"sigterm-sent"' "$R/ext.jsonl" || G="FAIL no term"
grep -q '"ev":"sigkill-sent"' "$R/ext.jsonl" || G="FAIL no kill"
[ "$(residue_of "$R")" = "0" ] || G="FAIL residue"
ok "$G"

# --- E: guardian enforces on TERM-RESISTANT target after controller death -----
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

# --- F: incremental persistence -----------------------------------------------
note "F: incremental persistence (cap 6; 60 lines/1s)"
setsid "$D/controller.sh" --label nf --cap 6 --workdir /tmp -- bash -c 'i=0; while [ $i -lt 60 ]; do echo "line-$i"; i=$((i+1)); sleep 1; done' >/dev/null 2>&1 &
C=$!; wait "$C"; R=$(latest nf); sleep 2
G=ok
LINES=$(grep -c '^line-' "$R/experiment.log" 2>/dev/null) || true; LINES=${LINES:-0}
[ "$LINES" -ge 4 ] || G="FAIL only $LINES lines"
jsonlines_valid "$R/events.jsonl" || G="FAIL events invalid"
jsonlines_valid "$R/guardian.jsonl" || G="FAIL guardian invalid"
grep -q '"ev":"sample"' "$R/ext.jsonl" || G="FAIL no samples"
ok "$G" "($LINES lines)"

# --- G: PGID guard --------------------------------------------------------------
note "G: PGID guard"
G=ok
for bad in "" 1 $$; do
  "$D/ext-sampler.sh" $bad /dev/null 5 >/dev/null 2>&1
  [ "$?" -eq 2 ] || { G="FAIL accepted '$bad'"; break; }
done
ok "$G"

# --- H: identity mismatch / PGID-reuse refusal -----------------------------------
note "H: identity mismatch refusal (guardian + sampler), target survives"
HDIR=/tmp/g4-v6/manual-id; rm -rf "$HDIR"; mkdir -p "$HDIR"
setsid bash -c 'sleep 60' & DP=$!; sleep 0.5
DPGID=$(ps -o pgid= -p "$DP" | tr -d ' '); DSID=$(ps -o sid= -p "$DP" | tr -d ' ')
jq -nc --argjson d $(( $(date +%s) - 5 )) --arg s "sent-1" --arg r "$HDIR" '{deadline_epoch:$d,sentinel:$s,run_dir:$r}' > "$HDIR/deadline.json"
jq -nc --argjson p "$DP" --argjson g "$DPGID" --argjson s "$DSID" --argjson t 999999999 --arg sent "sent-1" \
  '{pid:$p,pgid:$g,sid:$s,start_ticks:$t,sentinel:$sent,bound_pre_exec:true}' > "$HDIR/identity.json"
GUARDIAN_GRACE_S=0 "$D/guardian.sh" "$HDIR/deadline.json"; GRC=$?
G=ok
[ "$GRC" -eq 4 ] || G="FAIL guardian rc=$GRC (want 4)"
grep -q '"ev":"guardian-identity-refuse"' "$HDIR/guardian.jsonl" || G="FAIL no refuse event"
[ ! -f "$HDIR/guardian-ack.json" ] || G="FAIL ack written despite mismatch"
jsonlines_valid "$HDIR/guardian.jsonl" || G="FAIL guardian invalid JSON"
kill -0 "$DP" 2>/dev/null || G="FAIL target killed despite refusal"
"$D/ext-sampler.sh" "$DPGID" "$HDIR/ext.jsonl" 1 "$HDIR" "$HDIR/identity.json" "wrong-sentinel" >/dev/null 2>&1; SRC=$?
[ "$SRC" -eq 3 ] || G="FAIL sampler rc=$SRC (want 3)"
grep -q '"ev":"identity-refuse"' "$HDIR/ext.jsonl" || G="FAIL no sampler refuse"
kill -0 "$DP" 2>/dev/null || G="FAIL target killed by sampler"
kill -KILL -"$DPGID" 2>/dev/null
ok "$G"

# --- I: preflight refusals --------------------------------------------------------
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

# --- J: stale done/deadline/malformed ----------------------------------------------
note "J: stale done/deadline/malformed"
G=ok
SD=/tmp/g4-v6/manual-stale; rm -rf "$SD"; mkdir -p "$SD"
jq -nc --argjson d $(( $(date +%s) - 100 )) --arg s x '{deadline_epoch:$d,sentinel:$s}' > "$SD/deadline.json"; touch "$SD/done"
GUARDIAN_GRACE_S=0 "$D/guardian.sh" "$SD/deadline.json"; [ "$?" -eq 0 ] || G="FAIL stale-done rc"
grep -q '"ev":"guardian-done-observed"' "$SD/guardian.jsonl" || G="FAIL stale-done"
SD2=/tmp/g4-v6/manual-malformed; rm -rf "$SD2"; mkdir -p "$SD2"
echo 'not json{{{' > "$SD2/deadline.json"
GUARDIAN_GRACE_S=0 "$D/guardian.sh" "$SD2/deadline.json"; [ "$?" -eq 3 ] || G="FAIL malformed rc"
grep -q '"ev":"guardian-invalid-deadline-file"' "$SD2/guardian.jsonl" || G="FAIL malformed event"
jsonlines_valid "$SD2/guardian.jsonl" || G="FAIL malformed JSON"
SD3=/tmp/g4-v6/manual-past; rm -rf "$SD3"; mkdir -p "$SD3"
jq -nc --argjson d $(( $(date +%s) - 100 )) --arg s x '{deadline_epoch:$d,sentinel:$s}' > "$SD3/deadline.json"
GUARDIAN_GRACE_S=0 "$D/guardian.sh" "$SD3/deadline.json"; [ "$?" -eq 0 ] || G="FAIL past rc"
grep -q '"ev":"guardian-no-identity-at-enforce-window"' "$SD3/guardian.jsonl" || G="FAIL no no-identity event"
jsonlines_valid "$SD3/guardian.jsonl" || G="FAIL past JSON"
ok "$G"

# --- K: concurrent labels ---------------------------------------------------------
note "K: concurrent same-label controllers"
setsid "$D/controller.sh" --label conc --cap 20 --workdir /tmp -- bash -c 'sleep 2' >/dev/null 2>&1 &
K1=$!
setsid "$D/controller.sh" --label conc --cap 20 --workdir /tmp -- bash -c 'sleep 2' >/dev/null 2>&1 &
K2=$!
wait "$K1"; R1=$?; wait "$K2"; R2=$?
N=$(ls -d /tmp/g4-v6/g4-ctrl-conc-* 2>/dev/null | wc -l)
G=ok
[ "$R1" -eq 0 ] && [ "$R2" -eq 0 ] || G="FAIL rc $R1/$R2"
[ "$N" -eq 2 ] || G="FAIL dirs=$N"
ok "$G"

# --- L: kill hooks across every launch window --------------------------------------
note "L: kill hooks (QA windows)"
G=ok
kill_at_phase() { # label, phase-name; returns run dir in $KHR
  local lbl="$1" ph="$2"
  # 1s phase windows; sentinel gate (10s) must outlast the whole pre-release
  # path (~7 phase sleeps + ack) or the sentinel self-exits before the ack
  SENTINEL_GATE_S=10 CTRL_PHASE_SLEEP=1 setsid "$D/controller.sh" --label "$lbl" --cap 8 --workdir /tmp -- bash -c 'sleep 300' >/dev/null 2>&1 &
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
# W1: after child creation before PGID
kill_at_phase k1 child-created; R=$KHR
for _ in $(seq 1 60); do pgrep -f "sentinel-launch.sh $R" >/dev/null 2>&1 || break; sleep 0.5; done
pgrep -f "sentinel-launch.sh $R" >/dev/null 2>&1 && G="FAIL W1 sentinel leaked"
[ ! -f "$R/identity.json" ] || G="FAIL W1 identity written"
[ ! -f "$R/release" ] || G="FAIL W1 release written"
note "  W1 (after child creation before PGID) checked"
# W2: after PGID
kill_at_phase k2 pgid-read; R=$KHR
for _ in $(seq 1 60); do pgrep -f "sentinel-launch.sh $R" >/dev/null 2>&1 || break; sleep 0.5; done
pgrep -f "sentinel-launch.sh $R" >/dev/null 2>&1 && G="FAIL W2 sentinel leaked"
[ ! -f "$R/identity.json" ] || G="FAIL W2 identity written"
note "  W2 (after PGID) checked"
# W3: during proc reads
kill_at_phase k3 proc-reads; R=$KHR
for _ in $(seq 1 60); do pgrep -f "sentinel-launch.sh $R" >/dev/null 2>&1 || break; sleep 0.5; done
pgrep -f "sentinel-launch.sh $R" >/dev/null 2>&1 && G="FAIL W3 sentinel leaked"
[ ! -f "$R/identity.json" ] || G="FAIL W3 identity written"
note "  W3 (during proc reads) checked"
# W4: before identity rename
kill_at_phase k4 identity-pre-rename; R=$KHR
for _ in $(seq 1 60); do pgrep -f "sentinel-launch.sh $R" >/dev/null 2>&1 || break; sleep 0.5; done
pgrep -f "sentinel-launch.sh $R" >/dev/null 2>&1 && G="FAIL W4 sentinel leaked"
[ ! -f "$R/identity.json" ] || G="FAIL W4 identity renamed"
note "  W4 (before identity rename) checked"
# W5: after rename before bound ack -> guardian enforces if launched; else the
# bounded sentinel gate is the designed backstop. Either way: zero residue.
kill_at_phase k5 identity-published; R=$KHR
W5OK=""
for _ in $(seq 1 90); do
  grep -q '"ev":"guardian-residue","members_remaining":0' "$R/guardian.jsonl" 2>/dev/null && { W5OK=guardian; break; }
  if grep -q 'sentinel-release-timeout' "$R/events.jsonl" 2>/dev/null && ! pgrep -f "sentinel-launch.sh $R" >/dev/null 2>&1; then W5OK=gate; break; fi
  sleep 0.5
done
[ -n "$W5OK" ] || G="FAIL W5 blocked sentinel cleaned by neither guardian nor gate"
[ ! -f "$R/release" ] || G="FAIL W5 release written"
[ -f "$R/guardian.jsonl" ] && { jsonlines_valid "$R/guardian.jsonl" || G="FAIL W5 guardian JSON"; }
pgrep -f "sentinel-launch.sh $R" >/dev/null 2>&1 && G="FAIL W5 sentinel leaked"
note "  W5 (after rename before bound ack) checked via $W5OK"
# W6: after ack before release -> guardian enforces on blocked sentinel
kill_at_phase k6 ack-received; R=$KHR
wait_for "$R/guardian.jsonl" 'guardian-residue' 40
grep -q '"ev":"guardian-residue","members_remaining":0' "$R/guardian.jsonl" 2>/dev/null || G="FAIL W6 guardian did not clean blocked sentinel"
[ ! -f "$R/release" ] || G="FAIL W6 release written"
note "  W6 (after ack before release) checked"
# W7: PGID-resolution failure -> controller kills/reaps blocked sentinel itself
CTRL_TEST_PGID_POISON=1 setsid "$D/controller.sh" --label k7 --cap 8 --workdir /tmp -- bash -c 'sleep 300' >/dev/null 2>&1 &
C7=$!; wait "$C7"; RC7=$?; R=$(latest k7); sleep 2
[ "$RC7" -eq 2 ] || G="FAIL W7 rc=$RC7"
grep -q '"ev":"launch-failure"' "$R/events.jsonl" || G="FAIL W7 no launch-failure"
grep -q '"ev":"cleanup-complete","residue":0' "$R/events.jsonl" || G="FAIL W7 cleanup"
pgrep -f "sentinel-launch.sh $R" >/dev/null 2>&1 && G="FAIL W7 sentinel leaked"
note "  W7 (PGID-resolution failure) checked"
ok "$G"

# --- M: controller TERM -> 143 -------------------------------------------------------
note "M: controller TERM"
setsid "$D/controller.sh" --label tm --cap 60 --workdir /tmp -- bash -c 'sleep 300' >/dev/null 2>&1 &
C=$!; sleep 3
kill -TERM "$C" 2>/dev/null; wait "$C"; RC=$?; R=$(latest tm); sleep 2
G=ok
[ "$RC" -eq 143 ] || G="FAIL rc=$RC"
grep -q '"ev":"experiment-outcome","outcome":"signal-interrupted"' "$R/events.jsonl" || G="FAIL outcome"
grep -q '"ev":"cleanup-complete","residue":0' "$R/events.jsonl" || G="FAIL cleanup"
grep -q '"outcome":"success"' "$R/events.jsonl" && G="FAIL success claimed"
[ "$(residue_of "$R")" = "0" ] || G="FAIL residue"
ok "$G"

# --- N: zero residue ------------------------------------------------------------------
note "N: zero residue (global)"
for _ in $(seq 1 40); do
  STRAY=$(pgrep -af 'sentinel-launch.sh|ext-sampler.sh|guardian.sh|sleep 300' 2>/dev/null | grep -v pgrep || true)
  [ -z "$STRAY" ] && break
  sleep 0.5
done
[ -z "$STRAY" ] && ok ok || ok "FAIL stray: $STRAY"

note "self-test v6 complete: $FAILS failure(s)"
[ "$FAILS" -eq 0 ]
