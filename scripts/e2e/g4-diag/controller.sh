#!/usr/bin/env bash
# Controller v4 (QA next-gen spec): durable top-level controller owning the
# sampler + experiment process group. Must be launched detached (own session);
# refuses unsafe configurations in preflight.
#   controller.sh --label NAME --cap SECONDS --workdir DIR -- <command...>
# Guarantees: persisted absolute deadline; EXIT/INT/TERM/HUP -> TERM target
# group -> bounded wait -> KILL -> reap -> zero-residue event; separately
# launched guardian (own session) enforces the same deadline if this
# controller dies; append+fsync event log; prompt launcher return is the
# invoker's job (launch this script with setsid ... &).
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
[ -n "$LABEL" ] && [ -n "$CAP" ] && [ -n "$WORKDIR" ] && [ $# -gt 0 ] || { echo "usage: controller.sh --label N --cap S --workdir D -- <cmd...>" >&2; exit 2; }
CLEANUP_MARGIN=90
RUN=/tmp/g4-ctrl-$LABEL
mkdir -p "$RUN"
EVLOG=$RUN/events.jsonl
DEADLINE_FILE=$RUN/deadline.json
DONE_MARKER=$RUN/done
OUTLOG=$RUN/experiment.log
ev() { local line; line=$(jq -nc --arg ts "$(date -Iseconds)" --arg ev "$1" "${@:2}" '{ts:$ts,ev:$ev}+($ARGS.named|del(.ts,.ev))' 2>/dev/null) && { echo "$line" >> "$EVLOG"; sync -f "$EVLOG" 2>/dev/null || sync; }; }

# --- preflight ---
MY_PID=$$; MY_PGID=$(ps -o pgid= -p $$ | tr -d ' '); MY_SID=$(ps -o sid= -p $$ | tr -d ' ')
if [ "$MY_SID" != "$MY_PID" ]; then
  # not detached: require declared safe outer timeout
  OUTER="${OUTER_TIMEOUT_S:-0}"
  if [ "$OUTER" -lt $((CAP + CLEANUP_MARGIN)) ]; then
    ev preflight-refuse --arg reason "not session leader and OUTER_TIMEOUT_S=$OUTER < cap($CAP)+margin($CLEANUP_MARGIN)"
    echo "PREFLIGHT REFUSE: not detached and outer timeout unsafe (see $EVLOG)" >&2
    exit 2
  fi
fi
ev controller-start --argjson pid $$ --argjson pgid "$MY_PGID" --argjson sid "$MY_SID" --argjson cap "$CAP" --arg lbl "$LABEL" --arg cmd "$*"

# --- launch experiment group ---
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
DEADLINE=$(( $(date +%s) + CAP ))
jq -nc --argjson deadline "$DEADLINE" --argjson cap "$CAP" --argjson target "$XPGID" --arg lbl "$LABEL" --arg run "$RUN" '{deadline_epoch:$deadline,cap_s:$cap,target_pgid:$target,"label":$lbl,run_dir:$run}' > "$DEADLINE_FILE.tmp" \
  && mv "$DEADLINE_FILE.tmp" "$DEADLINE_FILE" \
  && { sync -f "$DEADLINE_FILE" 2>/dev/null || sync; }
ev experiment-launched --argjson pid "$XPID" --argjson pgid "$XPGID" --argjson deadline "$DEADLINE"

# --- guardian (separately launched, own session) ---
setsid "$HERE/guardian.sh" "$DEADLINE_FILE" >/dev/null 2>&1 &
GPID=$!
ev guardian-launched --argjson pid "$GPID"

# --- sampler (child of this controller; cap = experiment cap) ---
"$HERE/ext-sampler.sh" "$XPGID" "$RUN/ext.jsonl" "$CAP" &
SPID=$!

# --- signal handling: forward TERM, bounded wait, KILL, reap, zero residue ---
cleanup() {
  local why="$1"
  ev cleanup-start --arg reason "$why"
  if pgrep -g "$XPGID" >/dev/null 2>&1; then
    ev term-sent --argjson pgid "$XPGID"
    kill -TERM -"$XPGID" 2>/dev/null
    local i=0
    while pgrep -g "$XPGID" >/dev/null 2>&1 && [ $i -lt 10 ]; do sleep 1; i=$((i+1)); done
    if pgrep -g "$XPGID" >/dev/null 2>&1; then
      ev kill-sent --argjson pgid "$XPGID"
      kill -KILL -"$XPGID" 2>/dev/null
      sleep 2
    fi
  fi
  local left
  left=$(pgrep -g "$XPGID" 2>/dev/null | wc -l)
  ev residue --argjson members "$left"
  touch "$DONE_MARKER"
  exit 0
}
trap 'cleanup signal-term' TERM; trap 'cleanup signal-int' INT; trap 'cleanup signal-hup' HUP

wait "$XPID"; RC=$?
echo "$RC" > "$RUN/exitcode"; sync -f "$RUN/exitcode" 2>/dev/null || true
ev experiment-exited --argjson rc "$RC"
wait "$SPID" 2>/dev/null
LEFT=$(pgrep -g "$XPGID" 2>/dev/null | wc -l)
ev residue --argjson members "$LEFT"
touch "$DONE_MARKER"
ev controller-done --argjson rc "$RC"
exit "$RC"
