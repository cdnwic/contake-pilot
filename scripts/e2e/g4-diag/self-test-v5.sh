#!/usr/bin/env bash
# Self-test v5 for controller v5 family. QA scenarios: normal exit; cap expiry;
# forced controller death with guardian cleanup; TERM-resistant child requiring
# KILL (sampler path); guardian-after-controller-death TERM-RESISTANT target;
# incremental output/artifact persistence; PGID guard; identity mismatch/PGID
# reuse refusal; outer-timeout preflight refusal + positive bounded CAP +
# writable path checks; stale done/deadline; concurrent labels; phase-kill
# across every launch window; controller TERM -> truthful nonzero; valid JSON
# on every guardian error path; zero residue. Run dirs preserved (never rm).
set -u
D=$(cd "$(dirname "$0")" && pwd)
export CTRL_RUN_BASE=/tmp/g4-v5 GUARDIAN_GRACE_S=4
mkdir -p /tmp/g4-v5
FAILS=0
note() { echo "[selftest-v5] $*"; }
ok()   { local v="$1"; shift || true; note "  -> $v $*"; [ "$v" = ok ] || FAILS=$((FAILS+1)); }
latest() { ls -dt /tmp/g4-v5/g4-ctrl-"$1"-* 2>/dev/null | head -1; }
jsonlines_valid() { grep '^{' "$1" 2>/dev/null | jq -e . >/dev/null 2>&1; }
wait_for() { # wait_for <file> <pattern> <timeout_s>
  local i=0; while [ $i -lt $(( $3 * 4 )) ]; do grep -q "$2" "$1" 2>/dev/null && return 0; sleep 0.25; i=$((i+1)); done; return 1; }
residue_of() { local pgid; pgid=$(jq -r '.pgid // 0' "$1/identity.json" 2>/dev/null || echo 0); if [ "$pgid" != "0" ] && [ -n "$pgid" ]; then pgrep -g "$pgid" 2>/dev/null | wc -l; else echo 0; fi; }

# --- A: normal exit --------------------------------------------------------
note "A: normal exit"
setsid "$D/controller.sh" --label na --cap 30 --workdir /tmp -- bash -c 'sleep 2' >/dev/null 2>&1 &
C=$!; wait "$C"; RC=$?; R=$(latest na); sleep 3
G=ok
[ "$RC" -eq 0 ] || G="FAIL rc=$RC"
grep -q '"ev":"experiment-outcome","outcome":"success"' "$R/events.jsonl" || G="FAIL no success outcome"
grep -q '"ev":"cleanup-complete","residue":0' "$R/events.jsonl" || G="FAIL no separate cleanup-complete"
grep -q '"ev":"controller-done","outcome":"success","exit_code":0' "$R/events.jsonl" || G="FAIL controller-done"
grep -q '"ev":"guardian-acked"' "$R/events.jsonl" || G="FAIL no guardian ack gating"
[ -f "$R/guardian-ack.json" ] && [ -f "$R/identity.json" ] && [ -f "$R/done" ] || G="FAIL missing ack/identity/done"
grep -q 'guardian-done-observed' "$R/guardian.jsonl" || G="FAIL guardian-not-done"
[ "$(residue_of "$R")" = "0" ] || G="FAIL residue"
ok "$G"

# --- B: cap expiry -> truthful 124, cap-killed, never success --------------
note "B: cap expiry (cap 6; experiment sleeps 300)"
setsid "$D/controller.sh" --label nb --cap 6 --workdir /tmp -- bash -c 'sleep 300' >/dev/null 2>&1 &
C=$!; wait "$C"; RC=$?; R=$(latest nb)
wait_for "$R/guardian.jsonl" 'guardian-done-observed' 30
G=ok
[ "$RC" -eq 124 ] || G="FAIL rc=$RC (want 124)"
[ -f "$R/cap-fired" ] || G="FAIL no cap-fired marker"
grep -q '"ev":"experiment-outcome","outcome":"cap-killed"' "$R/events.jsonl" || G="FAIL outcome not cap-killed"
grep -q '"outcome":"success"' "$R/events.jsonl" && G="FAIL success claimed on cap"
grep -q '"ev":"sigterm-sent"' "$R/ext.jsonl" || G="FAIL no sigterm"
grep -q 'guardian-done-observed' "$R/guardian.jsonl" || G="FAIL guardian-not-done"
[ "$(residue_of "$R")" = "0" ] || G="FAIL residue"
ok "$G"

# --- C: forced controller death, guardian cleanup (also phase-kill W5) -----
note "C: forced controller death at 4s (cap 14; guardian enforces deadline+grace)"
setsid "$D/controller.sh" --label nc --cap 14 --workdir /tmp -- bash -c 'sleep 300' >/dev/null 2>&1 &
C=$!; sleep 4
kill -KILL -"$(ps -o pgid= -p "$C" | tr -d ' ')" 2>/dev/null; wait "$C" 2>/dev/null
R=$(latest nc)
wait_for "$R/guardian.jsonl" 'guardian-residue' 40
G=ok
grep -q 'guardian-deadline-expired' "$R/guardian.jsonl" || G="FAIL no enforcement"
grep -q 'guardian diagnostics' "$R/guardian.jsonl" || G="FAIL no diagnostics"
grep -q '"ev":"guardian-residue","members_remaining":0' "$R/guardian.jsonl" || G="FAIL residue-nonzero"
[ -f "$R/done" ] && G="FAIL done marker present"
grep -q '"ev":"controller-done"' "$R/events.jsonl" 2>/dev/null && G="FAIL controller-done present"
ok "$G"

# --- D: TERM-resistant child requires KILL (sampler path) ------------------
note "D: TERM-resistant child (cap 6; trap '' TERM loop)"
setsid "$D/controller.sh" --label nd --cap 6 --workdir /tmp -- bash -c 'trap "" TERM; while true; do sleep 1; done' >/dev/null 2>&1 &
C=$!; wait "$C"; RC=$?; R=$(latest nd); sleep 2
G=ok
[ "$RC" -eq 124 ] || G="FAIL rc=$RC"
grep -q '"ev":"sigterm-sent"' "$R/ext.jsonl" || G="FAIL no term"
grep -q '"ev":"sigkill-sent"' "$R/ext.jsonl" || G="FAIL no kill"
[ "$(residue_of "$R")" = "0" ] || G="FAIL residue"
ok "$G"

# --- E: guardian enforces on TERM-RESISTANT target after controller death --
note "E: controller killed at 4s; TERM-resistant target (cap 14, grace 4)"
setsid "$D/controller.sh" --label ne --cap 14 --workdir /tmp -- bash -c 'trap "" TERM; while true; do sleep 1; done' >/dev/null 2>&1 &
C=$!; sleep 4
kill -KILL -"$(ps -o pgid= -p "$C" | tr -d ' ')" 2>/dev/null; wait "$C" 2>/dev/null
R=$(latest ne)
wait_for "$R/guardian.jsonl" 'guardian-residue' 50
G=ok
grep -q '"ev":"guardian-term-sent"' "$R/guardian.jsonl" || G="FAIL no guardian term"
grep -q '"ev":"guardian-kill-sent"' "$R/guardian.jsonl" || G="FAIL no guardian kill (TERM-resistant survived TERM?)"
grep -q '"ev":"guardian-residue","members_remaining":0' "$R/guardian.jsonl" || G="FAIL residue-nonzero"
ok "$G"

# --- F: incremental persistence --------------------------------------------
note "F: incremental persistence (cap 6; 60 lines/1s)"
setsid "$D/controller.sh" --label nf --cap 6 --workdir /tmp -- bash -c 'i=0; while [ $i -lt 60 ]; do echo "line-$i"; i=$((i+1)); sleep 1; done' >/dev/null 2>&1 &
C=$!; wait "$C"; R=$(latest nf); sleep 2
G=ok
LINES=$(grep -c '^line-' "$R/experiment.log" 2>/dev/null) || true; LINES=${LINES:-0}
[ "$LINES" -ge 4 ] || G="FAIL only $LINES lines"
jsonlines_valid "$R/events.jsonl" || G="FAIL events.jsonl invalid"
jsonlines_valid "$R/guardian.jsonl" || G="FAIL guardian.jsonl invalid"
grep -q '"ev":"sample"' "$R/ext.jsonl" || G="FAIL no samples"
ok "$G" "($LINES lines persisted)"

# --- G: PGID guard ----------------------------------------------------------
note "G: PGID guard (bad pgids refused)"
G=ok
for bad in "" 1 $$; do
  "$D/ext-sampler.sh" $bad /dev/null 5 >/dev/null 2>&1
  [ "$?" -eq 2 ] || { G="FAIL accepted '$bad'"; break; }
done
ok "$G"

# --- H: identity mismatch / PGID reuse refusal ------------------------------
note "H: identity mismatch refusal (guardian + sampler), target must survive"
HDIR=/tmp/g4-v5/manual-id; rm -rf "$HDIR"; mkdir -p "$HDIR"
setsid bash -c 'sleep 60' & DP=$!; sleep 0.5
DPGID=$(ps -o pgid= -p "$DP" | tr -d ' '); DSID=$(ps -o sid= -p "$DP" | tr -d ' ')
jq -nc --argjson d $(( $(date +%s) - 5 )) --arg s "sent-1" --arg r "$HDIR" '{deadline_epoch:$d,sentinel:$s,run_dir:$r}' > "$HDIR/deadline.json"
jq -nc --argjson p "$DP" --argjson g "$DPGID" --argjson s "$DSID" --argjson t 999999999 --arg sent "sent-1" --arg c "fake" \
  '{pid:$p,pgid:$g,sid:$s,start_ticks:$t,sentinel:$sent,cmdline_sha1:$c,cmdline:"fake"}' > "$HDIR/identity.json"
GUARDIAN_GRACE_S=0 "$D/guardian.sh" "$HDIR/deadline.json"; GRC=$?
G=ok
[ "$GRC" -eq 4 ] || G="FAIL guardian rc=$GRC (want 4)"
grep -q '"ev":"guardian-identity-refuse"' "$HDIR/guardian.jsonl" || G="FAIL no refuse event"
jsonlines_valid "$HDIR/guardian.jsonl" || G="FAIL guardian.jsonl invalid JSON"
kill -0 "$DP" 2>/dev/null || G="FAIL target killed despite refusal"
# sampler refusal: wrong sentinel
"$D/ext-sampler.sh" "$DPGID" "$HDIR/ext.jsonl" 1 "$HDIR" "$HDIR/identity.json" "wrong-sentinel" >/dev/null 2>&1; SRC=$?
[ "$SRC" -eq 3 ] || G="FAIL sampler rc=$SRC (want 3)"
grep -q '"ev":"identity-refuse"' "$HDIR/ext.jsonl" || G="FAIL no sampler refuse event"
kill -0 "$DP" 2>/dev/null || G="FAIL target killed by sampler despite refusal"
kill -KILL -"$DPGID" 2>/dev/null
ok "$G"

# --- I: preflight: outer timeout, cap bounds, label, writable path ----------
note "I: preflight refusals"
G=ok
OUTER_TIMEOUT_S=10 "$D/controller.sh" --label pi --cap 60 --workdir /tmp -- true >/dev/null 2>&1; [ "$?" -eq 2 ] || G="FAIL outer-timeout"
for badcap in 0 -5 abc 99999999; do
  "$D/controller.sh" --label pc --cap "$badcap" --workdir /tmp -- true >/dev/null 2>&1
  [ "$?" -eq 2 ] || { G="FAIL cap '$badcap' accepted"; break; }
done
"$D/controller.sh" --label '../x' --cap 5 --workdir /tmp -- true >/dev/null 2>&1; [ "$?" -eq 2 ] || G="FAIL bad label accepted"
CTRL_RUN_BASE=/proc "$D/controller.sh" --label pw --cap 5 --workdir /tmp -- true >/dev/null 2>&1; [ "$?" -eq 2 ] || G="FAIL unwritable base accepted"
R=$(latest pi); [ -n "$R" ] && [ -f "$R/deadline.json" ] && G="FAIL deadline persisted despite refusal"
ok "$G"

# --- J: stale done / stale+malformed deadline -------------------------------
note "J: stale done marker / stale and malformed deadline"
G=ok
SD=/tmp/g4-v5/manual-stale; rm -rf "$SD"; mkdir -p "$SD"
jq -nc --argjson d $(( $(date +%s) - 100 )) --arg s x '{deadline_epoch:$d,sentinel:$s}' > "$SD/deadline.json"; touch "$SD/done"
GUARDIAN_GRACE_S=0 "$D/guardian.sh" "$SD/deadline.json"; [ "$?" -eq 0 ] || G="FAIL stale-done rc"
grep -q '"ev":"guardian-done-observed"' "$SD/guardian.jsonl" || G="FAIL stale-done not observed"
grep -q 'term-sent\|deadline-expired' "$SD/guardian.jsonl" && G="FAIL enforced despite done"
SD2=/tmp/g4-v5/manual-malformed; rm -rf "$SD2"; mkdir -p "$SD2"
echo 'not json{{{' > "$SD2/deadline.json"
GUARDIAN_GRACE_S=0 "$D/guardian.sh" "$SD2/deadline.json"; [ "$?" -eq 3 ] || G="FAIL malformed rc"
grep -q '"ev":"guardian-invalid-deadline-file"' "$SD2/guardian.jsonl" || G="FAIL no invalid event"
jsonlines_valid "$SD2/guardian.jsonl" || G="FAIL malformed guardian.jsonl invalid JSON"
SD3=/tmp/g4-v5/manual-past; rm -rf "$SD3"; mkdir -p "$SD3"
jq -nc --argjson d $(( $(date +%s) - 100 )) --arg s x '{deadline_epoch:$d,sentinel:$s}' > "$SD3/deadline.json"
GUARDIAN_GRACE_S=0 "$D/guardian.sh" "$SD3/deadline.json"; [ "$?" -eq 0 ] || G="FAIL past-deadline rc"
grep -q '"ev":"guardian-enforce-no-target"' "$SD3/guardian.jsonl" || G="FAIL no no-target event"
ok "$G"

# --- K: concurrent labels -> unique dirs, both succeed ----------------------
note "K: concurrent same-label controllers"
setsid "$D/controller.sh" --label conc --cap 20 --workdir /tmp -- bash -c 'sleep 2' >/dev/null 2>&1 &
K1=$!
setsid "$D/controller.sh" --label conc --cap 20 --workdir /tmp -- bash -c 'sleep 2' >/dev/null 2>&1 &
K2=$!
wait "$K1"; R1=$?; wait "$K2"; R2=$?
N=$(ls -d /tmp/g4-v5/g4-ctrl-conc-* 2>/dev/null | wc -l)
G=ok
[ "$R1" -eq 0 ] && [ "$R2" -eq 0 ] || G="FAIL rc $R1/$R2"
[ "$N" -eq 2 ] || G="FAIL dirs=$N (want 2 unique)"
ok "$G"

# --- L: phase-kill across launch windows W1-W4 (W5 = scenario C) ------------
note "L: phase-kill windows W1-W4 (CTRL_PHASE_SLEEP=2)"
G=ok
for W in 1 2 3 4; do
  CTRL_PHASE_SLEEP=2 setsid "$D/controller.sh" --label "pk$W" --cap 8 --workdir /tmp -- bash -c 'sleep 300' >/dev/null 2>&1 &
  C=$!
  R=""; for _ in $(seq 1 40); do R=$(latest "pk$W"); [ -n "$R" ] && [ -f "$R/events.jsonl" ] && grep -q "\"ev\":\"phase-$W\"" "$R/events.jsonl" && break; sleep 0.25; done
  kill -KILL -"$(ps -o pgid= -p "$C" | tr -d ' ')" 2>/dev/null; wait "$C" 2>/dev/null
  case $W in
    1) [ ! -f "$R/deadline.json" ] || G="FAIL W1 deadline written";;
    2) [ -f "$R/deadline.json" ] && [ ! -f "$R/guardian-ack.json" ] || G="FAIL W2 state";;
    3|4) sleep 11
       grep -q '"ev":"guardian-enforce-no-target"\|"ev":"guardian-done-observed"' "$R/guardian.jsonl" 2>/dev/null || G="FAIL W$W guardian not graceful"
       [ ! -f "$R/identity.json" ] || G="FAIL W$W identity written"
       jsonlines_valid "$R/guardian.jsonl" || G="FAIL W$W guardian invalid JSON";;
  esac
  note "  W$W done ($(basename "$R"))"
done
ok "$G"

# --- M: controller TERM -> truthful nonzero ---------------------------------
note "M: controller TERM -> nonzero exit, cleanup-complete"
setsid "$D/controller.sh" --label tm --cap 60 --workdir /tmp -- bash -c 'sleep 300' >/dev/null 2>&1 &
C=$!; sleep 3
kill -TERM "$C" 2>/dev/null; wait "$C"; RC=$?; R=$(latest tm); sleep 3
G=ok
[ "$RC" -eq 143 ] || G="FAIL rc=$RC (want 143)"
grep -q '"ev":"experiment-outcome","outcome":"signal-interrupted"' "$R/events.jsonl" || G="FAIL outcome"
grep -q '"ev":"cleanup-complete","residue":0' "$R/events.jsonl" || G="FAIL cleanup"
grep -q '"outcome":"success"' "$R/events.jsonl" && G="FAIL success claimed on signal"
[ "$(residue_of "$R")" = "0" ] || G="FAIL residue"
ok "$G"

# --- N: zero residue sweep ---------------------------------------------------
note "N: zero residue (global)"
for _ in $(seq 1 40); do
  STRAY=$(pgrep -af 'g4-ctrl|ext-sampler.sh|guardian.sh|sleep 300' 2>/dev/null | grep -v "pgrep" || true)
  [ -z "$STRAY" ] && break
  sleep 0.5
done
[ -z "$STRAY" ] && ok ok || ok "FAIL stray: $STRAY"

note "self-test v5 complete: $FAILS failure(s)"
[ "$FAILS" -eq 0 ]
