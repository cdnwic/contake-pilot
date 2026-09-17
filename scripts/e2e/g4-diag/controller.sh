#!/usr/bin/env bash
# Controller v7 (QA spec): guardian alive BEFORE sentinel creation (two-ack).
# Order: preflight -> unique run dir -> deadline.json (absolute deadline,
# sentinel token, atomic+fsync+dir-fsync) -> guardian launch -> ack1
# (guardian-armed.json verified) -> launch-intent.json (fsynced) -> setsid
# BLOCKED sentinel (gate derives from the SAME absolute deadline + margin)
# -> EXIT/INT/TERM/HUP cleanup armed -> identity.json persisted immediately
# (pre-exec) -> guardian ack2 (bound identity, content verified) -> atomic
# release -> sentinel execs experiment -> sampler -> bounded reap.
# Reaping: bounded wait distinguishes xpid-reaped from xpid-absent. Normal
# completion requires residue 0: any residue -> nonzero exit, never success.
# Identity binding (pid/pgid/sid/start-ticks/sentinel) precedes every signal;
# mismatch -> loud refusal, no signal. Truthful status: experiment-outcome
# separate from cleanup-complete; cap -> 124; signals -> 128+n; residue -> 98.
# experiment.log is BEST-EFFORT; fsynced JSONL streams are authoritative.
# Test hooks (default off): CTRL_PHASE_SLEEP, CTRL_RUN_BASE, CTRL_ACK_TIMEOUT,
# GUARDIAN_GRACE_S, SENTINEL_MARGIN_S, CTRL_TEST_PGID_POISON.
# usage: controller.sh --label N --cap S --workdir D -- <cmd...>
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LABEL=""; CAP=""; WORKDIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="$2"; shift 2;;
    --cap) CAP="$2"; shift 2;;
    --workdir) WORKDIR="$2"; shift 2;;
    --) shift; break;;
    *) echo "unknown arg $1" >&2; exit 2;;
  esac
done
CLEANUP_MARGIN=90
BASE="${CTRL_RUN_BASE:-/tmp}"
ACK_TIMEOUT="${CTRL_ACK_TIMEOUT:-15}"
PHASE_SLEEP="${CTRL_PHASE_SLEEP:-0}"

refuse() { echo "PREFLIGHT REFUSE: $1" >&2; exit 2; }
[ -n "$LABEL" ] && [[ "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]] || refuse "bad label"
[[ "$CAP" =~ ^[0-9]+$ ]] && [ "$CAP" -ge 1 ] && [ "$CAP" -le 86400 ] || refuse "cap must be a positive integer <= 86400 (got '$CAP')"
[ $# -gt 0 ] || refuse "no experiment command"
[ -d "$WORKDIR" ] || refuse "workdir '$WORKDIR' not a directory"
[ -d "$BASE" ] && [ -w "$BASE" ] || refuse "run base '$BASE' not writable"
TMPTEST=$(mktemp "$BASE/.ctrl-wtest-XXXXXX") || refuse "run base write test failed"; rm -f "$TMPTEST"

RUN=$BASE/g4-ctrl-${LABEL}-$(date +%Y%m%dT%H%M%S)-$$
mkdir "$RUN" 2>/dev/null || refuse "run dir $RUN already exists (dirs are unique and never reused)"
EVLOG=$RUN/events.jsonl
DEADLINE_FILE=$RUN/deadline.json
IDENTITY_FILE=$RUN/identity.json
DONE_MARKER=$RUN/done
fsync_dir() { sync -f "$RUN" 2>/dev/null || sync; }
ev() { local line; line=$(jq -nc --arg ts "$(date -Iseconds)" --arg ev "$1" "${@:2}" '{ts:$ts,ev:$ev}+($ARGS.named|del(.ts,.ev))' 2>/dev/null) && { echo "$line" >> "$EVLOG"; sync -f "$EVLOG" 2>/dev/null || sync; }; }
phase() { ev "phase-$1"; [ "$PHASE_SLEEP" -gt 0 ] 2>/dev/null && sleep "$PHASE_SLEEP"; return 0; }

MY_PID=$$; MY_SID=$(ps -o sid= -p $$ | tr -d ' ')
if [ "$MY_SID" != "$MY_PID" ]; then
  OUTER="${OUTER_TIMEOUT_S:-0}"
  if [ "$OUTER" -lt $((CAP + CLEANUP_MARGIN)) ]; then
    ev preflight-refuse --arg reason "not session leader and OUTER_TIMEOUT_S=$OUTER < cap($CAP)+margin($CLEANUP_MARGIN)"
    refuse "not detached and outer timeout unsafe (see $EVLOG)"
  fi
fi
ev controller-start --argjson pid $$ --argjson cap "$CAP" --arg lbl "$LABEL" --arg cmd "$*" \
  --arg stdout_stream best-effort --argjson authoritative '["events.jsonl","guardian.jsonl","ext.jsonl"]'

# --- absolute deadline + sentinel token ------------------------------------
phase 1
SENTINEL=$(cat /proc/sys/kernel/random/uuid)
DEADLINE=$(( $(date +%s) + CAP ))
jq -nc --argjson deadline "$DEADLINE" --argjson cap "$CAP" --arg lbl "$LABEL" --arg run "$RUN" --arg sentinel "$SENTINEL" \
  '{deadline_epoch:$deadline,cap_s:$cap,"label":$lbl,run_dir:$run,sentinel:$sentinel,controller_pid:'"$$"'}' > "$DEADLINE_FILE.tmp" \
  && { sync -f "$DEADLINE_FILE.tmp" 2>/dev/null || sync; } \
  && mv "$DEADLINE_FILE.tmp" "$DEADLINE_FILE" && fsync_dir || { ev write-failure --arg file deadline; exit 2; }
ev deadline-written --argjson deadline "$DEADLINE"

XPID=""
XPGID=""
IDENTITY_PUBLISHED=0
CLEANED=0

verify_identity() {
  [ "$IDENTITY_PUBLISHED" = "1" ] || return 1
  local vticks
  [ -d "/proc/$XPID" ] || return 1
  [ "$(ps -o pgid= -p "$XPID" 2>/dev/null | tr -d ' ')" = "$XPGID" ] || return 1
  [ "$(ps -o sid= -p "$XPID" 2>/dev/null | tr -d ' ')" = "$XPID" ] || return 1
  vticks=$(jq -r '.start_ticks' "$IDENTITY_FILE" 2>/dev/null)
  [ "$(sed 's/^.*) //' "/proc/$XPID/stat" 2>/dev/null | awk '{print $20}')" = "$vticks" ] || return 1
  return 0
}

reap_xpid() { # bounded reap: distinguishes reaped from absent
  local i=0
  while [ $i -lt 20 ]; do
    if ! kill -0 "$XPID" 2>/dev/null; then
      wait "$XPID" 2>/dev/null
      ev xpid-reaped --argjson pid "$XPID"
      return 0
    fi
    sleep 0.5; i=$((i+1))
  done
  ev xpid-absent --argjson pid "$XPID" --arg reason "still present after bounded reap wait"
  return 1
}

kill_reap_sentinel() {
  local left
  if [ "$IDENTITY_PUBLISHED" = "1" ]; then
    if verify_identity; then
      ev term-sent --argjson pgid "$XPGID"
      kill -TERM -"$XPGID" 2>/dev/null
      local i=0
      while pgrep -g "$XPGID" >/dev/null 2>&1 && [ $i -lt 10 ]; do sleep 1; i=$((i+1)); done
      if pgrep -g "$XPGID" >/dev/null 2>&1; then
        verify_identity && { ev kill-sent --argjson pgid "$XPGID"; kill -KILL -"$XPGID" 2>/dev/null; sleep 2; }
      fi
    else
      ev identity-refuse --arg context cleanup --arg reason "identity mismatch; no signal sent"
    fi
    reap_xpid || true
  elif [ -n "$XPID" ] && [ -d "/proc/$XPID" ]; then
    local cpgid ccmd
    cpgid=$(ps -o pgid= -p "$XPID" 2>/dev/null | tr -d ' ')
    ccmd=$(tr '\0' ' ' < "/proc/$XPID/cmdline" 2>/dev/null)
    if [ "$cpgid" = "$XPID" ] && [[ "$ccmd" == *sentinel-launch.sh* ]]; then
      ev kill-sent --argjson pgid "$XPID" --arg context pre-identity-cleanup
      kill -KILL -"$XPID" 2>/dev/null
      sleep 1
      reap_xpid || true
    else
      ev identity-refuse --arg context pre-identity-cleanup --arg reason "child identity uncertain; no signal sent"
    fi
  fi
  left=$([ -n "$XPGID" ] && pgrep -g "$XPGID" 2>/dev/null | wc -l || echo 0)
  ev cleanup-complete --argjson residue "${left:-0}"
}

fail_cleanup() {
  [ "$CLEANED" = "1" ] && return
  CLEANED=1
  trap - EXIT INT TERM HUP
  ev launch-failure --arg reason "$1"
  kill_reap_sentinel
  ev experiment-outcome --arg outcome launch-failure --argjson rc 0
  touch "$DONE_MARKER"; fsync_dir
  ev controller-done --arg outcome launch-failure --argjson exit_code 2
  exit 2
}

signal_cleanup() {
  [ "$CLEANED" = "1" ] && return
  CLEANED=1
  trap - EXIT INT TERM HUP
  ev cleanup-start --arg reason "signal-$1"
  kill_reap_sentinel
  ev experiment-outcome --arg outcome signal-interrupted --argjson rc 128
  touch "$DONE_MARKER"; fsync_dir
  ev controller-done --arg outcome signal-interrupted --argjson exit_code $((128 + $2))
  exit $((128 + $2))
}

exit_cleanup() {
  [ "$CLEANED" = "1" ] && return
  CLEANED=1
  trap - EXIT INT TERM HUP
  ev cleanup-start --arg reason exit-trap
  kill_reap_sentinel
  ev experiment-outcome --arg outcome interrupted --argjson rc 0
  touch "$DONE_MARKER"; fsync_dir
  ev controller-done --arg outcome interrupted --argjson exit_code 97
  exit 97
}

# --- guardian FIRST (alive before the sentinel exists) ----------------------
phase guardian-first
GUARDIAN_GRACE_S="${GUARDIAN_GRACE_S:-15}" setsid "$HERE/guardian.sh" "$DEADLINE_FILE" >/dev/null 2>&1 &
GPID=$!
ev guardian-launched --argjson pid "$GPID"
i=0
while true; do
  if [ -f "$RUN/guardian-armed.json" ]; then
    A1=$(jq -r 'select(.sentinel=="'"$SENTINEL"'") | .deadline_epoch' "$RUN/guardian-armed.json" 2>/dev/null)
    [ "$A1" = "$DEADLINE" ] && break
    jq -e . "$RUN/guardian-armed.json" >/dev/null 2>&1 && { ev armed-mismatch --arg got "$A1" --argjson want "$DEADLINE"; exit 2; }
  fi
  i=$((i+1)); [ $i -gt $((ACK_TIMEOUT * 10)) ] && { ev guardian-arm-timeout; exit 2; }
  sleep 0.1
done
ev guardian-armed --argjson guardian_pid "$GPID"

# --- launch intent (fsynced) ------------------------------------------------
phase launch-intent
jq -nc --arg ts "$(date -Iseconds)" --arg sentinel "$SENTINEL" --arg cmd "$*" --argjson cpid $$ \
  '{ts:$ts,sentinel:$sentinel,intended_cmd:$cmd,controller_pid:$cpid}' > "$RUN/launch-intent.json.tmp" \
  && { sync -f "$RUN/launch-intent.json.tmp" 2>/dev/null || sync; } \
  && mv "$RUN/launch-intent.json.tmp" "$RUN/launch-intent.json" && fsync_dir || { ev write-failure --arg file launch-intent; exit 2; }
ev launch-intent-recorded

# --- blocked sentinel (gate derives from deadline + margin) -----------------
phase child-created
SENTINEL_MARGIN_S="${SENTINEL_MARGIN_S:-15}" setsid "$HERE/sentinel-launch.sh" "$RUN" -- "$@" &
XPID=$!
trap 'exit_cleanup' EXIT
trap 'signal_cleanup term 15' TERM; trap 'signal_cleanup int 2' INT; trap 'signal_cleanup hup 1' HUP

phase pgid-read
i=0
while true; do
  [ -d "/proc/$XPID" ] || fail_cleanup "sentinel child $XPID died before identity publication"
  XPGID=$(ps -o pgid= -p "$XPID" 2>/dev/null | tr -d ' ')
  [ -n "${CTRL_TEST_PGID_POISON:-}" ] && XPGID="poisoned"
  [ "$XPGID" = "$XPID" ] && break
  i=$((i+1)); [ $i -gt 50 ] && fail_cleanup "pgid resolution failed for sentinel $XPID (got '$XPGID')"
  sleep 0.1
done
phase proc-reads
XSID=$(ps -o sid= -p "$XPID" | tr -d ' ')
XTICKS=$(sed 's/^.*) //' "/proc/$XPID/stat" | awk '{print $20}')
[ "$XSID" = "$XPID" ] && [[ "$XTICKS" =~ ^[0-9]+$ ]] || fail_cleanup "session/start-ticks read failed for sentinel $XPID"
phase identity-pre-rename
jq -nc --argjson pid "$XPID" --argjson pgid "$XPGID" --argjson sid "$XSID" --argjson ticks "$XTICKS" --arg sentinel "$SENTINEL" \
  '{pid:$pid,pgid:$pgid,sid:$sid,start_ticks:$ticks,sentinel:$sentinel,bound_pre_exec:true}' > "$IDENTITY_FILE.tmp" \
  && { sync -f "$IDENTITY_FILE.tmp" 2>/dev/null || sync; } \
  && mv "$IDENTITY_FILE.tmp" "$IDENTITY_FILE" && fsync_dir || fail_cleanup "identity publication failed"
IDENTITY_PUBLISHED=1
ev identity-published --argjson pid "$XPID" --argjson pgid "$XPGID" --argjson sid "$XSID" --argjson ticks "$XTICKS"

# --- ack2: bound identity permits release ------------------------------------
phase identity-published
i=0
while true; do
  if [ -f "$RUN/guardian-ack.json" ]; then
    AB=$(jq -r 'select(.sentinel=="'"$SENTINEL"'") | [.bound_pid,.bound_pgid,.bound_sid,.bound_ticks] | @csv' "$RUN/guardian-ack.json" 2>/dev/null)
    [ "$AB" = "$XPID,$XPGID,$XSID,$XTICKS" ] && break
    jq -e . "$RUN/guardian-ack.json" >/dev/null 2>&1 && fail_cleanup "guardian ack2 does not match bound pre-exec identity (ack=$AB want $XPID,$XPGID,$XSID,$XTICKS)"
  fi
  i=$((i+1)); [ $i -gt $((ACK_TIMEOUT * 10)) ] && fail_cleanup "guardian did not ack bound identity within ${ACK_TIMEOUT}s"
  sleep 0.1
done
ev guardian-acked --argjson guardian_pid "$GPID"

phase ack-received
touch "$RUN/release.tmp" && { sync -f "$RUN/release.tmp" 2>/dev/null || sync; } \
  && mv "$RUN/release.tmp" "$RUN/release" && fsync_dir || fail_cleanup "release publication failed"
ev sentinel-released

"$HERE/ext-sampler.sh" "$XPGID" "$RUN/ext.jsonl" "$CAP" "$RUN" "$IDENTITY_FILE" "$SENTINEL" &
SPID=$!

wait "$XPID"; RC=$?
echo "$RC" > "$RUN/exitcode"; sync -f "$RUN/exitcode" 2>/dev/null || true
ev experiment-exited --argjson rc "$RC"
wait "$SPID" 2>/dev/null
LEFT=$(pgrep -g "$XPGID" 2>/dev/null | wc -l)
if [ "$LEFT" != "0" ]; then
  OUTCOME=residue-left; EXIT_CODE=98
elif [ -f "$RUN/cap-fired" ]; then
  OUTCOME=cap-killed; EXIT_CODE=124
elif [ "$RC" -eq 0 ]; then
  OUTCOME=success; EXIT_CODE=0
else
  OUTCOME=failed; EXIT_CODE=$RC; [ "$EXIT_CODE" -gt 125 ] && EXIT_CODE=1; [ "$EXIT_CODE" -eq 0 ] && EXIT_CODE=1
fi
ev experiment-outcome --arg outcome "$OUTCOME" --argjson rc "$RC"
ev cleanup-complete --argjson residue "$LEFT"
CLEANED=1
trap - EXIT INT TERM HUP
touch "$DONE_MARKER"; fsync_dir
ev controller-done --arg outcome "$OUTCOME" --argjson exit_code "$EXIT_CODE"
exit "$EXIT_CODE"
