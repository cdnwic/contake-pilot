#!/usr/bin/env bash
# Sentinel v8: STABLE session/group leader for the whole experiment. It does
# NOT exec the command. After release it launches the command as a CHILD in
# the same process group, waits, durably records the command RC
# (command-rc.json, atomic+fsynced), then drains descendants for a bounded
# time. If descendants remain beyond the drain bound it STAYS ALIVE and
# reports residue (sentinel-residue event) so the controller/guardian can
# identity-verify and TERM/KILL the group. Exit code propagates the command
# RC. Release gate timeout derives from deadline.json (deadline + margin),
# never a separate fixed timeout. usage: sentinel-launch.sh <run-dir> -- <cmd...>
set -u
RUN="${1:-}"
[ -n "$RUN" ] && [ "${2:-}" = "--" ] || exit 2
shift 2
[ $# -gt 0 ] || exit 2
DF=$RUN/deadline.json
EVLOG=$RUN/events.jsonl
MARGIN="${SENTINEL_MARGIN_S:-15}"
DRAIN="${SENTINEL_DRAIN_S:-5}"
sev() { local line; line=$(jq -nc --arg ts "$(date -Iseconds)" --arg ev "$1" "${@:2}" '{ts:$ts,ev:$ev}+($ARGS.named|del(.ts,.ev))' 2>/dev/null) && { echo "$line" >> "$EVLOG"; sync -f "$EVLOG" 2>/dev/null || sync; }; }

CUTOFF=""
for _ in $(seq 1 100); do
  if jq -e . "$DF" >/dev/null 2>&1; then
    DE=$(jq -r '.deadline_epoch // empty' "$DF")
    [[ "$DE" =~ ^[0-9]+$ ]] && { CUTOFF=$(( DE + MARGIN )); break; }
  fi
  sleep 0.2
done
if [ -z "$CUTOFF" ]; then
  sev sentinel-no-deadline --arg reason "deadline.json missing/invalid after retries"
  exit 98
fi

while [ ! -f "$RUN/release" ]; do
  NOW=$(date +%s)
  if [ "$NOW" -ge "$CUTOFF" ]; then
    sev sentinel-release-timeout --argjson cutoff_epoch "$CUTOFF" --argjson deadline_epoch "$DE" --argjson margin_s "$MARGIN"
    exit 98
  fi
  sleep 0.2
done
sev sentinel-released --argjson sentinel_pid $$

# command as CHILD in the same process group (sentinel stays group leader);
# stdout/stderr relayed to experiment.log (best-effort stream)
"$@" >> "$RUN/experiment.log" 2>&1 &
CPID=$!
sev command-started --argjson cpid "$CPID" --arg cmd "$*"
wait "$CPID"; RC=$?
jq -nc --argjson rc "$RC" --argjson cpid "$CPID" --arg ts "$(date -Iseconds)" \
  '{rc:$rc,cpid:$cpid,recorded_at:$ts}' > "$RUN/command-rc.json.tmp" \
  && { sync -f "$RUN/command-rc.json.tmp" 2>/dev/null || sync; } \
  && mv "$RUN/command-rc.json.tmp" "$RUN/command-rc.json" \
  && { sync -f "$RUN" 2>/dev/null || sync; }
sev command-exited --argjson rc "$RC" --argjson cpid "$CPID"

# bounded drain of remaining group members (excluding self). Pure-bash
# /proc scan with NO child processes: a forked pipeline/subshell would be a
# member of this very group and count itself as phantom residue.
group_pids_except_self() {
  GROUP_PIDS=""
  local d line rest pid
  for d in /proc/[0-9]*/stat; do
    [ -r "$d" ] || continue
    read -r line < "$d" 2>/dev/null || continue
    rest=${line##*) }
    set -- $rest
    [ "${3:-}" = "$$" ] || continue
    pid=${d#/proc/}; pid=${pid%/stat}
    [ "$pid" != "$$" ] && GROUP_PIDS="$GROUP_PIDS $pid"
  done
  GROUP_PIDS="${GROUP_PIDS# }"
}
i=0
while [ $i -lt $(( DRAIN * 5 )) ]; do
  group_pids_except_self
  [ -z "$GROUP_PIDS" ] && break
  sleep 0.2; i=$((i+1))
done
group_pids_except_self
LEFT="$GROUP_PIDS"
if [ -n "$LEFT" ]; then
  sev sentinel-residue --arg pids "$(echo $LEFT | xargs)" --argjson drain_s "$DRAIN" --argjson rc "$RC"
  # stay alive: controller/guardian identity-verify and TERM/KILL the group
  while true; do sleep 5; done
fi
exit "$RC"
