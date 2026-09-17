#!/usr/bin/env bash
# Sentinel launcher (controller v7 family): stable blocked session leader
# holding the experiment's pre-exec identity. Its timeout DERIVES from the
# run's absolute deadline (deadline.json) + SENTINEL_MARGIN_S (default 15) -
# never a separate fixed interval. The guardian is always alive before this
# sentinel exists (v7 two-ack design). On timeout the sentinel exits 98 with
# an atomic jq event, which forces a nonzero controller outcome.
# usage: sentinel-launch.sh RUN_DIR -- cmd [args...]
set -u
RUN="${1:-}"; shift
[ "${1:-}" = "--" ] && shift
[ -n "$RUN" ] && [ -d "$RUN" ] && [ $# -gt 0 ] || exit 2
MARGIN="${SENTINEL_MARGIN_S:-15}"
DEADLINE=""
for _ in $(seq 1 20); do
  DEADLINE=$(jq -r '.deadline_epoch // empty' "$RUN/deadline.json" 2>/dev/null)
  [[ "$DEADLINE" =~ ^[0-9]+$ ]] && break
  DEADLINE=""; sleep 0.5
done
if [ -z "$DEADLINE" ]; then
  jq -nc --arg ts "$(date -Iseconds)" --argjson pid $$ '{ts:$ts,ev:"sentinel-no-deadline",pid:$pid}' >> "$RUN/events.jsonl" 2>/dev/null
  sync -f "$RUN/events.jsonl" 2>/dev/null || sync
  exit 98
fi
CUTOFF=$(( DEADLINE + MARGIN ))
while [ ! -f "$RUN/release" ]; do
  NOW=$(date +%s)
  if [ "$NOW" -ge "$CUTOFF" ]; then
    jq -nc --arg ts "$(date -Iseconds)" --argjson pid $$ --argjson deadline "$DEADLINE" --argjson margin "$MARGIN" --argjson cutoff "$CUTOFF" \
      '{ts:$ts,ev:"sentinel-release-timeout",pid:$pid,deadline_epoch:$deadline,margin_s:$margin,cutoff_epoch:$cutoff}' >> "$RUN/events.jsonl" 2>/dev/null
    sync -f "$RUN/events.jsonl" 2>/dev/null || sync
    exit 98
  fi
  sleep 0.1
done
exec "$@" >> "$RUN/experiment.log" 2>&1
