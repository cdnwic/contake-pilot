#!/usr/bin/env bash
# Sentinel launcher (controller v6 family): a STABLE blocked session leader
# that holds the experiment's process identity (pid == pgid == sid, fixed
# start-ticks) BEFORE exec. Launch via setsid. The controller persists that
# pre-exec identity immediately after fork; the guardian binds and acks that
# exact target; only then does the controller atomically create the release
# file that unblocks this script into exec. The sentinel never execs without
# the release marker, so identity never depends on post-exec observation.
# If the controller dies before release, the bounded gate exits on its own
# (SENTINEL_GATE_S, default 600s) and the guardian enforces on this group.
# usage: sentinel-launch.sh RUN_DIR -- cmd [args...]
set -u
RUN="${1:-}"; shift
[ "${1:-}" = "--" ] && shift
[ -n "$RUN" ] && [ -d "$RUN" ] && [ $# -gt 0 ] || exit 2
GATE="${SENTINEL_GATE_S:-600}"
i=0
while [ ! -f "$RUN/release" ]; do
  sleep 0.05
  i=$((i+1))
  if [ $i -gt $(( GATE * 20 )) ]; then
    echo "{\"ts\":\"$(date -Iseconds)\",\"ev\":\"sentinel-release-timeout\",\"pid\":$$}" >> "$RUN/events.jsonl" 2>/dev/null
    sync -f "$RUN/events.jsonl" 2>/dev/null || sync
    exit 98
  fi
done
exec "$@" >> "$RUN/experiment.log" 2>&1
