#!/usr/bin/env bash
# G4 diagnostic external sampler v2 (controller). 1s JSONL series for the
# dedicated diagnostic process group: parent+worker PID/PPID/state/CPU/RSS/
# threads/fds/socket-fds/elapsed, loadavg, mem. Events: sampler-start,
# target-exit, cap-reached, sigterm-sent, sigkill-sent, residue-check,
# sampler-done. Guards: refuses empty/non-numeric/low/self pgids so the cap
# can only ever target the dedicated diagnostic group, never the host.
# usage: ext-sampler.sh <target-pgid> <outfile> <cap-seconds>
set -u
PGID_T="${1:-}"; OUT="${2:-}"; CAP="${3:-600}"
SELF_PGID=$(ps -o pgid= -p $$ | tr -d ' ')
if [ -z "$PGID_T" ] || ! [[ "$PGID_T" =~ ^[0-9]+$ ]] || [ "$PGID_T" -lt 100 ] || [ "$PGID_T" = "$SELF_PGID" ] || [ "$PGID_T" = "$PPID" ]; then
  echo "{\"ts\":\"$(date -Iseconds)\",\"ev\":\"abort-bad-pgid\",\"given\":\"$PGID_T\",\"self_pgid\":$SELF_PGID}" >> "$OUT"
  exit 2
fi
T0=$(date +%s)
jq -nc --arg ts "$(date -Iseconds)" --argjson pgid "$PGID_T" --argjson selfpid $$ --argjson selfpgid "$SELF_PGID" --argjson cap "$CAP" '{ts:$ts,ev:"sampler-start",target_pgid:$pgid,self_pid:$selfpid,self_pgid:$selfpgid,cap_s:$cap}' >> "$OUT"
EMPTY=0
sample() {
  local ts now pids pline pid ppid stat pcpu rss nlwp comm fds socks
  ts=$(date -Iseconds); now=$(date +%s)
  pids=$(pgrep -g "$PGID_T" 2>/dev/null | tr '\n' ' ' | sed 's/ $//')
  if [ -z "$pids" ]; then
    EMPTY=$((EMPTY+1))
    if [ "$EMPTY" -ge 10 ]; then
      jq -nc --arg ts "$ts" --argjson el "$((now-T0))" '{ts:$ts,ev:"target-exit",elapsed_s:$el,note:"10 consecutive empty samples"}' >> "$OUT"
      return 1
    fi
    return 0
  fi
  EMPTY=0
  pline="[]"
  for pid in $pids; do
    read -r ppid stat pcpu rss nlwp comm < <(ps -o ppid=,stat=,pcpu=,rss=,nlwp=,comm= -p "$pid" 2>/dev/null) || continue
    fds=$(ls "/proc/$pid/fd" 2>/dev/null | wc -l)
    socks=$(ls -l "/proc/$pid/fd" 2>/dev/null | grep -c 'socket:' || true)
    pline=$(jq -nc --argjson pid "$pid" --argjson ppid "${ppid:-0}" --arg st "${stat:-?}" --argjson pcpu "${pcpu:-0}" --argjson rss "${rss:-0}" --argjson nlwp "${nlwp:-0}" --arg cmd "${comm:-?}" --argjson fds "${fds:-0}" --argjson socks "${socks:-0}" --argjson arr "$pline" '$arr + [{pid:$pid,ppid:$ppid,stat:$st,pcpu:$pcpu,rss_kb:$rss,threads:$nlwp,comm:$cmd,fds:$fds,sock_fds:$socks}]')
  done
  jq -nc --arg ts "$ts" --argjson el "$((now-T0))" --arg la "$(cut -d' ' -f1-3 /proc/loadavg)" --arg mem "$(free -m | awk 'NR==2{print $2"/"$3"/"$4}')" --argjson procs "$pline" --argjson pgid "$PGID_T" '{ts:$ts,ev:"sample",elapsed_s:$el,pgid:$pgid,loadavg:$la,mem_total_used_free_mb:$mem,procs:$procs}' >> "$OUT"
  return 0
}
residue_check() {
  local left
  left=$(pgrep -g "$PGID_T" 2>/dev/null | wc -l)
  jq -nc --arg ts "$(date -Iseconds)" --argjson n "$left" --argjson pgid "$PGID_T" '{ts:$ts,ev:"residue-check",target_pgid:$pgid,members_remaining:$n}' >> "$OUT"
  [ "$left" -eq 0 ]
}
while sample; do
  now=$(date +%s)
  if (( now - T0 > CAP )); then
    {
      jq -nc --arg ts "$(date -Iseconds)" --argjson el "$((now-T0))" '{ts:$ts,ev:"cap-reached",elapsed_s:$el}'
      echo "--- ps auxf ---"; ps auxf
      echo "--- ss -tan state counts ---"; ss -tan | awk 'NR>1{print $1}' | sort | uniq -c
      for pid in $(pgrep -g "$PGID_T" 2>/dev/null); do
        echo "--- /proc/$pid/status (subset) ---"; grep -E 'State|Threads|VmRSS|SigQ' "/proc/$pid/status" 2>/dev/null
        echo "--- /proc/$pid/wchan ---"; cat "/proc/$pid/wchan" 2>/dev/null; echo
        echo "--- fd types ---"; ls -l "/proc/$pid/fd" 2>/dev/null | awk '{print $NF}' | sed 's/[0-9]*$//' | sort | uniq -c | sort -rn | head -15
      done
      jq -nc --arg ts "$(date -Iseconds)" --argjson pgid "$PGID_T" '{ts:$ts,ev:"sigterm-sent",target_pgid:$pgid}'
    } >> "$OUT" 2>&1
    kill -TERM -"$PGID_T" 2>/dev/null
    sleep 10
    if pgrep -g "$PGID_T" >/dev/null 2>&1; then
      jq -nc --arg ts "$(date -Iseconds)" --argjson pgid "$PGID_T" '{ts:$ts,ev:"sigkill-sent",target_pgid:$pgid}' >> "$OUT"
      kill -KILL -"$PGID_T" 2>/dev/null
      sleep 2
    fi
    residue_check || true
    jq -nc --arg ts "$(date -Iseconds)" '{ts:$ts,ev:"sampler-done",reason:"cap"}' >> "$OUT"
    exit 0
  fi
  sleep 1
done
residue_check || true
jq -nc --arg ts "$(date -Iseconds)" '{ts:$ts,ev:"sampler-done",reason:"target-exit"}' >> "$OUT"
exit 0
