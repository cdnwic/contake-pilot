#!/usr/bin/env bash
# Controller v5 (QA spec): guardian-first gated launcher.
# Launch order: preflight -> unique run dir (atomic, never reused) ->
# deadline.json (sentinel, atomic+fsync) -> guardian (own session) ->
# bounded guardian-ack wait -> ONLY THEN experiment group -> identity.json
# (pid/pgid/sid/start-ticks/cmdline+sentinel, atomic+fsync) -> sampler.
# Identity binding: every signal is preceded by identity verification
# (pgid+sid+start-ticks+cmdline+sentinel); mismatch -> loud refusal, no signal.
# Truthful status: experiment-outcome (success|failed|cap-killed|signal-
# interrupted) is separate from cleanup-complete; cap/signal exits are nonzero.
# experiment.log is BEST-EFFORT (plain shell append); the fsynced JSONL streams
# (events.jsonl, guardian.jsonl, ext.jsonl) are the authoritative artifacts.
# Test hooks (default off): CTRL_PHASE_SLEEP, CTRL_RUN_BASE, CTRL_ACK_TIMEOUT,
# GUARDIAN_GRACE_S (passed through to guardian env).
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
OUTLOG=$RUN/experiment.log
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

# --- phase 1: deadline + sentinel, atomic+fsync, BEFORE guardian/experiment ---
phase 1
SENTINEL=$(cat /proc/sys/kernel/random/uuid)
DEADLINE=$(( $(date +%s) + CAP ))
jq -nc --argjson deadline "$DEADLINE" --argjson cap "$CAP" --arg lbl "$LABEL" --arg run "$RUN" --arg sentinel "$SENTINEL" \
  '{deadline_epoch:$deadline,cap_s:$cap,"label":$lbl,run_dir:$run,sentinel:$sentinel,controller_pid:'"$$"'}' > "$DEADLINE_FILE.tmp" \
  && mv "$DEADLINE_FILE.tmp" "$DEADLINE_FILE" && { sync -f "$DEADLINE_FILE" 2>/dev/null || sync; }
ev deadline-written --argjson deadline "$DEADLINE"

# --- phase 2: guardian first ---
phase 2
GUARDIAN_GRACE_S="${GUARDIAN_GRACE_S:-15}" setsid "$HERE/guardian.sh" "$DEADLINE_FILE" >/dev/null 2>&1 &
GPID=$!
ev guardian-launched --argjson pid "$GPID"

# --- phase 3: bounded ack wait; experiment is HELD until ack ---
phase 3
i=0; while [ ! -f "$RUN/guardian-ack.json" ] && [ $i -lt $((ACK_TIMEOUT * 10)) ]; do sleep 0.1; i=$((i+1)); done
if [ ! -f "$RUN/guardian-ack.json" ]; then
  ev guardian-ack-timeout --argjson waited_ms $((i * 100))
  refuse "guardian did not ack within ${ACK_TIMEOUT}s; experiment never launched (see $EVLOG)"
fi
ev guardian-acked

# --- phase 4: launch experiment group ---
phase 4
cd "$WORKDIR" || exit 2
setsid "$@" >> "$OUTLOG" 2>&1 &
XPID=$!
XPGID=""
for _ in $(seq 1 50); do
  XPGID=$(ps -o pgid= -p "$XPID" 2>/dev/null | tr -d ' ')
  [ -n "$XPGID" ] && [ "$XPGID" = "$XPID" ] && break
  sleep 0.1
done
if [ "$XPGID" != "$XPID" ]; then
  ev preflight-refuse --arg reason "pgid resolution failed for experiment child $XPID (got $XPGID)"
  exit 2
fi
XSID=$(ps -o sid= -p "$XPID" | tr -d ' ')
XTICKS=$(sed 's/^.*) //' "/proc/$XPID/stat" | awk '{print $20}')
XCMD=$(tr '\0' ' ' < "/proc/$XPID/cmdline" | sed 's/ $//')
XCMDSHA=$(printf '%s' "$XCMD" | sha1sum | cut -d' ' -f1)
jq -nc --argjson pid "$XPID" --argjson pgid "$XPGID" --argjson sid "$XSID" --argjson ticks "$XTICKS" \
  --arg cmdsha "$XCMDSHA" --arg cmd "$XCMD" --arg sentinel "$SENTINEL" \
  '{pid:$pid,pgid:$pgid,sid:$sid,start_ticks:$ticks,cmdline_sha1:$cmdsha,cmdline:$cmd,sentinel:$sentinel}' > "$IDENTITY_FILE.tmp" \
  && mv "$IDENTITY_FILE.tmp" "$IDENTITY_FILE" && { sync -f "$IDENTITY_FILE" 2>/dev/null || sync; }
ev experiment-launched --argjson pid "$XPID" --argjson pgid "$XPGID" --argjson sid "$XSID" --argjson ticks "$XTICKS"

# --- identity verification (used before every signal) ---
verify_identity() {
  [ -f "$IDENTITY_FILE" ] || return 1
  local vpid vpgid vsid vticks vsent vcmdsha
  vpid=$(jq -r '.pid' "$IDENTITY_FILE"); vpgid=$(jq -r '.pgid' "$IDENTITY_FILE")
  vsid=$(jq -r '.sid' "$IDENTITY_FILE"); vticks=$(jq -r '.start_ticks' "$IDENTITY_FILE")
  vsent=$(jq -r '.sentinel' "$IDENTITY_FILE"); vcmdsha=$(jq -r '.cmdline_sha1' "$IDENTITY_FILE")
  [ "$vsent" = "$SENTINEL" ] || return 1
  [ -d "/proc/$vpid" ] || return 1
  [ "$(ps -o pgid= -p "$vpid" 2>/dev/null | tr -d ' ')" = "$vpgid" ] || return 1
  [ "$(ps -o sid= -p "$vpid" 2>/dev/null | tr -d ' ')" = "$vsid" ] || return 1
  [ "$(sed 's/^.*) //' "/proc/$vpid/stat" 2>/dev/null | awk '{print $20}')" = "$vticks" ] || return 1
  [ "$(tr '\0' ' ' < "/proc/$vpid/cmdline" 2>/dev/null | sed 's/ $//' | sha1sum | cut -d' ' -f1)" = "$vcmdsha" ] || return 1
  return 0
}

# --- sampler (child of controller; verifies identity before any cap signal) ---
"$HERE/ext-sampler.sh" "$XPGID" "$RUN/ext.jsonl" "$CAP" "$RUN" "$IDENTITY_FILE" "$SENTINEL" &
SPID=$!

SIGNALED=""
cleanup() {
  local why="$1" signum="$2"
  SIGNALED="$signum"
  ev cleanup-start --arg reason "$why"
  if pgrep -g "$XPGID" >/dev/null 2>&1; then
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
  fi
  local left
  left=$(pgrep -g "$XPGID" 2>/dev/null | wc -l)
  ev experiment-outcome --arg outcome signal-interrupted --argjson rc 128
  ev cleanup-complete --argjson residue "$left"
  touch "$DONE_MARKER"
  ev controller-done --arg outcome signal-interrupted --argjson exit_code $((128 + signum))
  exit $((128 + signum))
}
trap 'cleanup signal-term 15' TERM; trap 'cleanup signal-int 2' INT; trap 'cleanup signal-hup 1' HUP

wait "$XPID"; RC=$?
echo "$RC" > "$RUN/exitcode"; sync -f "$RUN/exitcode" 2>/dev/null || true
ev experiment-exited --argjson rc "$RC"
wait "$SPID" 2>/dev/null
LEFT=$(pgrep -g "$XPGID" 2>/dev/null | wc -l)
if [ -f "$RUN/cap-fired" ]; then
  OUTCOME=cap-killed; EXIT_CODE=124
elif [ "$RC" -eq 0 ]; then
  OUTCOME=success; EXIT_CODE=0
else
  OUTCOME=failed; EXIT_CODE=$RC; [ "$EXIT_CODE" -gt 125 ] && EXIT_CODE=1
fi
ev experiment-outcome --arg outcome "$OUTCOME" --argjson rc "$RC"
ev cleanup-complete --argjson residue "$LEFT"
touch "$DONE_MARKER"
ev controller-done --arg outcome "$OUTCOME" --argjson exit_code "$EXIT_CODE"
exit "$EXIT_CODE"
