#!/usr/bin/env bash
# G4 diagnostic external sampler (controller v6 family). 1s JSONL series for the
# dedicated diagnostic process group: per-process PID/PPID/state/cumulative
# CPU jiffies/RSS/threads/fds/socket-fds/wchan + birth/death events; system
# memory/load/PSI/OOM counter/cgroup limits. Events: sampler-start,
# proc-birth, proc-death, target-exit, cap-reached, sigterm-sent,
# sigkill-sent, residue-check, sampler-done. Guards refuse empty/non-numeric/
# low/self pgids so the cap can only target the dedicated diagnostic group.
# usage: ext-sampler.sh <target-pgid> <outfile> <cap-seconds>
set -u
PGID_T="${1:-}"; OUT="${2:-}"; CAP="${3:-600}"; RUN_DIR="${4:-}"; IDENTITY_FILE="${5:-}"; SENTINEL="${6:-}"
# v5: when given an identity file, verify process identity (sentinel, pgid,
# sid, start ticks, cmdline) before any signal; mismatch -> loud refusal.
verify_identity() {
  [ -n "$IDENTITY_FILE" ] && [ -f "$IDENTITY_FILE" ] || return 1
  jq -e . "$IDENTITY_FILE" >/dev/null 2>&1 || return 1
  local vpid vpgid vsid vticks vsent
  vpid=$(jq -r '.pid // empty' "$IDENTITY_FILE"); vpgid=$(jq -r '.pgid // empty' "$IDENTITY_FILE")
  vsid=$(jq -r '.sid // empty' "$IDENTITY_FILE"); vticks=$(jq -r '.start_ticks // empty' "$IDENTITY_FILE")
  vsent=$(jq -r '.sentinel // empty' "$IDENTITY_FILE")
  [[ "$vpid" =~ ^[0-9]+$ ]] || return 1
  [ "$vsent" = "$SENTINEL" ] || return 1
  [ "$vpgid" = "$PGID_T" ] || return 1
  [ -d "/proc/$vpid" ] || return 1
  [ "$(ps -o pgid= -p "$vpid" 2>/dev/null | tr -d ' ')" = "$vpgid" ] || return 1
  [ "$(ps -o sid= -p "$vpid" 2>/dev/null | tr -d ' ')" = "$vsid" ] || return 1
  [ "$(sed 's/^.*) //' "/proc/$vpid/stat" 2>/dev/null | awk '{print $20}')" = "$vticks" ] || return 1
  return 0
}
SELF_PGID=$(ps -o pgid= -p $$ | tr -d ' ')
if [ -z "$PGID_T" ] || ! [[ "$PGID_T" =~ ^[0-9]+$ ]] || [ "$PGID_T" -lt 100 ] || [ "$PGID_T" = "$SELF_PGID" ] || [ "$PGID_T" = "$PPID" ]; then
  echo "{\"ts\":\"$(date -Iseconds)\",\"ev\":\"abort-bad-pgid\",\"given\":\"$PGID_T\",\"self_pgid\":$SELF_PGID}" >> "$OUT"
  sync -f "$OUT" 2>/dev/null || sync
  exit 2
fi
T0=$(date +%s)
jq -nc --arg ts "$(date -Iseconds)" --argjson pgid "$PGID_T" --argjson selfpid $$ --argjson selfpgid "$SELF_PGID" --argjson cap "$CAP" '{ts:$ts,ev:"sampler-start",target_pgid:$pgid,self_pid:$selfpid,self_pgid:$selfpgid,cap_s:$cap}' >> "$OUT"
  sync -f "$OUT" 2>/dev/null || sync
EMPTY=0
declare -A SEEN=()
sysline() {
  local psi_cpu psi_mem oom cg_cur cg_max mavail
  psi_cpu=$(awk '/^some/{print $2}' /proc/pressure/cpu 2>/dev/null | cut -d= -f2)
  psi_mem=$(awk '/^some/{print $2}' /proc/pressure/memory 2>/dev/null | cut -d= -f2)
  oom=$(awk '/^oom_kill/{print $2}' /proc/vmstat 2>/dev/null)
  cg_cur=$(cat /sys/fs/cgroup/memory.current 2>/dev/null || cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null)
  cg_max=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null)
  mavail=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
  jq -nc --arg la "$(cut -d' ' -f1-3 /proc/loadavg)" --argjson mavail "${mavail:-0}" --arg psi_cpu "${psi_cpu:-na}" --arg psi_mem "${psi_mem:-na}" --argjson oom "${oom:-0}" --argjson cg_cur "${cg_cur:-0}" --arg cg_max "${cg_max:-na}" '{loadavg:$la,mem_available_kb:$mavail,psi_cpu_some_avg10:$psi_cpu,psi_mem_some_avg10:$psi_mem,oom_kill_total:$oom,cgroup_mem_current_bytes:$cg_cur,cgroup_mem_max:$cg_max}'
}
sample() {
  local ts now pids pline pid ppid stat pcpu rss nlwp comm fds socks uj sj wch state
  ts=$(date -Iseconds); now=$(date +%s)
  pids=$(pgrep -g "$PGID_T" 2>/dev/null | tr '\n' ' ' | sed 's/ $//')
  if [ -z "$pids" ]; then
    EMPTY=$((EMPTY+1))
    if [ "$EMPTY" -ge 10 ]; then
      jq -nc --arg ts "$ts" --argjson el "$((now-T0))" '{ts:$ts,ev:"target-exit",elapsed_s:$el,note:"10 consecutive empty samples"}' >> "$OUT"
  sync -f "$OUT" 2>/dev/null || sync
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
    read -r state uj sj < <(sed 's/^.*) //' "/proc/$pid/stat" 2>/dev/null | awk '{print $1, $12, $13}') || true
    wch=$(cat "/proc/$pid/wchan" 2>/dev/null)
    if [ -z "${SEEN[$pid]:-}" ]; then
      SEEN[$pid]=1
      jq -nc --arg ts "$ts" --argjson pid "$pid" --argjson ppid "${ppid:-0}" --arg cmd "${comm:-?}" '{ts:$ts,ev:"proc-birth",pid:$pid,ppid:$ppid,comm:$cmd}' >> "$OUT"
  sync -f "$OUT" 2>/dev/null || sync
    fi
    pline=$(jq -nc --argjson pid "$pid" --argjson ppid "${ppid:-0}" --arg st "${stat:-?}" --arg state "${state:-?}" --argjson pcpu "${pcpu:-0}" --argjson rss "${rss:-0}" --argjson nlwp "${nlwp:-0}" --arg cmd "${comm:-?}" --argjson fds "${fds:-0}" --argjson socks "${socks:-0}" --argjson utime "${uj:-0}" --argjson stime "${sj:-0}" --arg wchan "${wch:-0}" --argjson arr "$pline" '$arr + [{pid:$pid,ppid:$ppid,stat:$st,state:$state,pcpu:$pcpu,rss_kb:$rss,threads:$nlwp,comm:$cmd,fds:$fds,sock_fds:$socks,utime_jiffies_cum:$utime,stime_jiffies_cum:$stime,wchan:$wchan}]')
  done
  for pid in "${!SEEN[@]}"; do
    if [ -n "${SEEN[$pid]:-}" ] && ! [[ " $pids " =~ " $pid " ]]; then
      SEEN[$pid]=""
      jq -nc --arg ts "$ts" --argjson pid "$pid" '{ts:$ts,ev:"proc-death",pid:$pid}' >> "$OUT"
  sync -f "$OUT" 2>/dev/null || sync
    fi
  done
  jq -nc --arg ts "$ts" --argjson el "$((now-T0))" --argjson pgid "$PGID_T" --argjson sys "$(sysline)" --argjson procs "$pline" '{ts:$ts,ev:"sample",elapsed_s:$el,pgid:$pgid,sys:$sys,procs:$procs}' >> "$OUT"
  sync -f "$OUT" 2>/dev/null || sync
  return 0
}
residue_check() {
  local left
  left=$(pgrep -g "$PGID_T" 2>/dev/null | wc -l)
  jq -nc --arg ts "$(date -Iseconds)" --argjson n "$left" --argjson pgid "$PGID_T" '{ts:$ts,ev:"residue-check",target_pgid:$pgid,members_remaining:$n}' >> "$OUT"
  sync -f "$OUT" 2>/dev/null || sync
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
        echo "--- /proc/$pid/task wchan (safe stacks) ---"; for t in "/proc/$pid/task"/*; do echo "$t: $(cat "$t/wchan" 2>/dev/null)"; done
        echo "--- fd types ---"; ls -l "/proc/$pid/fd" 2>/dev/null | awk '{print $NF}' | sed 's/[0-9]*$//' | sort | uniq -c | sort -rn | head -15
      done
      jq -nc --arg ts "$(date -Iseconds)" --argjson pgid "$PGID_T" '{ts:$ts,ev:"sigterm-sent",target_pgid:$pgid}'
    } >> "$OUT" 2>&1
    sync -f "$OUT" 2>/dev/null || sync
    [ -n "$RUN_DIR" ] && { touch "$RUN_DIR/cap-fired"; sync -f "$RUN_DIR/cap-fired" 2>/dev/null || true; }
    if [ -n "$IDENTITY_FILE" ] && ! verify_identity; then
      jq -nc --arg ts "$(date -Iseconds)" --argjson pgid "$PGID_T" '{ts:$ts,ev:"identity-refuse",target_pgid:$pgid,reason:"identity mismatch at cap; no signal sent"}' >> "$OUT"
      sync -f "$OUT" 2>/dev/null || sync
      exit 3
    fi
    kill -TERM -"$PGID_T" 2>/dev/null
    tw=0; while pgrep -g "$PGID_T" >/dev/null 2>&1 && [ $tw -lt 10 ]; do sleep 1; tw=$((tw+1)); done
    if pgrep -g "$PGID_T" >/dev/null 2>&1; then
      if [ -n "$IDENTITY_FILE" ] && ! verify_identity; then
        jq -nc --arg ts "$(date -Iseconds)" --argjson pgid "$PGID_T" '{ts:$ts,ev:"identity-refuse",target_pgid:$pgid,reason:"identity mismatch before KILL; no signal sent"}' >> "$OUT"
        sync -f "$OUT" 2>/dev/null || sync
        exit 3
      fi
      jq -nc --arg ts "$(date -Iseconds)" --argjson pgid "$PGID_T" '{ts:$ts,ev:"sigkill-sent",target_pgid:$pgid}' >> "$OUT"
  sync -f "$OUT" 2>/dev/null || sync
      kill -KILL -"$PGID_T" 2>/dev/null
      sleep 2
    fi
    residue_check || true
    jq -nc --arg ts "$(date -Iseconds)" '{ts:$ts,ev:"sampler-done",reason:"cap"}' >> "$OUT"
  sync -f "$OUT" 2>/dev/null || sync
    exit 0
  fi
  sleep 1
done
residue_check || true
jq -nc --arg ts "$(date -Iseconds)" '{ts:$ts,ev:"sampler-done",reason:"target-exit"}' >> "$OUT"
  sync -f "$OUT" 2>/dev/null || sync
exit 0
