#!/usr/bin/env bash
# Guardian v4: separately launched (own session) deadline enforcer. If the
# controller dies before marking done, the guardian enforces the persisted
# absolute deadline on the target group: diagnostics, TERM, bounded wait,
# KILL, zero-residue event. Writes its own guardian.jsonl (append+fsync).
# The guardian is a backstop: it enforces at deadline + GUARDIAN_GRACE_S so a
# live controller/sampler always gets first turn at cap enforcement.
# usage: guardian.sh <deadline-file>
set -u
DF="${1:-}"
[ -n "$DF" ] && [ -f "$DF" ] || exit 2
RUN=$(dirname "$DF")
DONE=$RUN/done
# tolerate a transiently unreadable deadline file (created atomically by the
# controller, but never trust one read): retry until valid numerics appear
TARGET=""; DEADLINE=""
for _ in $(seq 1 20); do
  [ -f "$DONE" ] && exit 0
  TARGET=$(jq -r '.target_pgid // empty' "$DF" 2>/dev/null)
  DEADLINE=$(jq -r '.deadline_epoch // empty' "$DF" 2>/dev/null)
  [[ "$TARGET" =~ ^[0-9]+$ ]] && [[ "$DEADLINE" =~ ^[0-9]+$ ]] && break
  TARGET=""; DEADLINE=""; sleep 0.5
done
if [ -z "$TARGET" ] || [ -z "$DEADLINE" ]; then
  echo "{"ts":"$(date -Iseconds)","ev":"guardian-invalid-deadline-file"}" >> "$RUN/guardian.jsonl"
  sync -f "$RUN/guardian.jsonl" 2>/dev/null || sync
  exit 3
fi
GLOG=$RUN/guardian.jsonl
GRACE="${GUARDIAN_GRACE_S:-15}"
ENFORCE=$(( DEADLINE + GRACE ))
gev() { echo "{\"ts\":\"$(date -Iseconds)\",\"ev\":\"guardian-$1\"${2:-}}" >> "$GLOG"; sync -f "$GLOG" 2>/dev/null || sync; }
gev start ",\"target_pgid\":$TARGET,\"deadline_epoch\":$DEADLINE,\"enforce_epoch\":$ENFORCE,\"grace_s\":$GRACE,\"guardian_pid\":$$"
while true; do
  [ -f "$DONE" ] && { gev done-observed; exit 0; }
  NOW=$(date +%s)
  if [ "$NOW" -ge "$ENFORCE" ]; then
    gev deadline-expired
    {
      echo "--- guardian diagnostics $(date -Iseconds) ---"
      ps auxf | head -60
      for pid in $(pgrep -g "$TARGET" 2>/dev/null); do
        echo "--- /proc/$pid ---"
        grep -E 'State|Threads|VmRSS|SigQ' "/proc/$pid/status" 2>/dev/null
        echo "wchan: $(cat "/proc/$pid/wchan" 2>/dev/null)"
        ls -l "/proc/$pid/fd" 2>/dev/null | awk '{print $NF}' | sed 's/[0-9]*$//' | sort | uniq -c | sort -rn | head -10
      done
    } >> "$GLOG" 2>&1
    sync -f "$GLOG" 2>/dev/null || sync
    if pgrep -g "$TARGET" >/dev/null 2>&1; then
      gev term-sent ",\"target_pgid\":$TARGET"
      kill -TERM -"$TARGET" 2>/dev/null
      i=0; while pgrep -g "$TARGET" >/dev/null 2>&1 && [ $i -lt 10 ]; do sleep 1; i=$((i+1)); done
      if pgrep -g "$TARGET" >/dev/null 2>&1; then
        gev kill-sent ",\"target_pgid\":$TARGET"
        kill -KILL -"$TARGET" 2>/dev/null
        sleep 2
      fi
    fi
    LEFT=$(pgrep -g "$TARGET" 2>/dev/null | wc -l)
    gev residue ",\"members_remaining\":$LEFT"
    exit 0
  fi
  sleep 2
done
