#!/usr/bin/env bash
# Guardian v7: alive BEFORE the sentinel exists (two-ack design).
#  ack1 (guardian-armed.json): deadline validated and armed - the controller
#    records launch-intent and creates the sentinel only after ack1.
#  bind window: waits for the pre-exec identity.json until the absolute
#    deadline; when it appears, verifies the exact target (pid/pgid/sid/
#    start-ticks/sentinel) and writes ack2 (guardian-ack.json, bound identity).
#  enforcement at deadline+GUARDIAN_GRACE_S: strict identity -> TERM ->
#    bounded wait -> KILL -> residue proof. If launch-intent exists but no
#    identity was ever published (controller SIGKILLed pre-publication), the
#    guardian sweeps processes whose cmdline carries this run's unique path
#    (intent-sweep), so cleanup still lands by the original cap+grace.
# Every event line is valid JSON, including error paths.
# usage: guardian.sh <deadline-file>
set -u
DF="${1:-}"
[ -n "$DF" ] && [ -f "$DF" ] || exit 2
RUN=$(dirname "$DF")
DONE=$RUN/done
GLOG=$RUN/guardian.jsonl
IDENTITY_FILE=$RUN/identity.json
INTENT_FILE=$RUN/launch-intent.json
GRACE="${GUARDIAN_GRACE_S:-15}"
gev() { local line; line=$(jq -nc --arg ts "$(date -Iseconds)" --arg ev "guardian-$1" "${@:2}" '{ts:$ts,ev:$ev}+($ARGS.named|del(.ts,.ev))' 2>/dev/null) && { echo "$line" >> "$GLOG"; sync -f "$GLOG" 2>/dev/null || sync; }; }
fsync_dir() { sync -f "$RUN" 2>/dev/null || sync; }

# --- deadline: validate; then ack1 (armed) ---
DEADLINE=""; DSENT=""
for _ in $(seq 1 20); do
  [ -f "$DONE" ] && { gev done-observed --arg phase pre-arm; exit 0; }
  if jq -e . "$DF" >/dev/null 2>&1; then
    DEADLINE=$(jq -r '.deadline_epoch // empty' "$DF")
    DSENT=$(jq -r '.sentinel // empty' "$DF")
    [[ "$DEADLINE" =~ ^[0-9]+$ ]] && [ -n "$DSENT" ] && break
  fi
  DEADLINE=""; DSENT=""; sleep 0.5
done
if [ -z "$DEADLINE" ]; then
  gev invalid-deadline-file --arg file "$DF" --arg reason "missing, malformed JSON, or missing deadline_epoch/sentinel after retries"
  exit 3
fi
ENFORCE=$(( DEADLINE + GRACE ))
jq -nc --argjson pid $$ --argjson sid "$(ps -o sid= -p $$ | tr -d ' ')" --arg ts "$(date -Iseconds)" \
  --argjson deadline "$DEADLINE" --argjson enforce "$ENFORCE" --arg sent "$DSENT" \
  '{guardian_pid:$pid,guardian_sid:$sid,armed_at:$ts,deadline_epoch:$deadline,enforce_epoch:$enforce,sentinel:$sent,ack:"deadline-armed"}' \
  > "$RUN/guardian-armed.json.tmp" && { sync -f "$RUN/guardian-armed.json.tmp" 2>/dev/null || sync; } \
  && mv "$RUN/guardian-armed.json.tmp" "$RUN/guardian-armed.json" && fsync_dir
gev armed --argjson deadline_epoch "$DEADLINE" --argjson enforce_epoch "$ENFORCE" --argjson grace_s "$GRACE" --argjson guardian_pid "$$"

# --- bind window: wait for pre-exec identity until the enforce time ---------
BPID=""; BPGID=""; BSID=""; BTICKS=""
while true; do
  [ -f "$DONE" ] && { gev done-observed --arg phase pre-identity; exit 0; }
  NOW=$(date +%s)
  [ "$NOW" -ge "$ENFORCE" ] && break
  if [ -f "$IDENTITY_FILE" ] && jq -e . "$IDENTITY_FILE" >/dev/null 2>&1; then
    ISENT=$(jq -r '.sentinel // empty' "$IDENTITY_FILE")
    BPID=$(jq -r '.pid // empty' "$IDENTITY_FILE")
    BPGID=$(jq -r '.pgid // empty' "$IDENTITY_FILE")
    BSID=$(jq -r '.sid // empty' "$IDENTITY_FILE")
    BTICKS=$(jq -r '.start_ticks // empty' "$IDENTITY_FILE")
    if [ "$ISENT" != "$DSENT" ] || ! [[ "$BPID" =~ ^[0-9]+$ ]] || ! [[ "$BPGID" =~ ^[0-9]+$ ]] || ! [[ "$BSID" =~ ^[0-9]+$ ]] || ! [[ "$BTICKS" =~ ^[0-9]+$ ]]; then
      gev identity-refuse --arg reason "identity sentinel mismatch or invalid fields; NO ack, no signal"
      exit 4
    fi
    break
  fi
  BPID=""; BPGID=""; BSID=""; BTICKS=""
  sleep 0.2
done

verify_target() {
  [ -d "/proc/$BPID" ] || return 1
  [ "$(ps -o pgid= -p "$BPID" 2>/dev/null | tr -d ' ')" = "$BPGID" ] || return 1
  [ "$(ps -o sid= -p "$BPID" 2>/dev/null | tr -d ' ')" = "$BSID" ] || return 1
  [ "$(sed 's/^.*) //' "/proc/$BPID/stat" 2>/dev/null | awk '{print $20}')" = "$BTICKS" ] || return 1
  return 0
}

# --- ack2: bound identity ack (permits release) ---
if [ -n "$BPID" ]; then
  if ! verify_target; then
    gev identity-refuse --arg reason "bound identity does not match live process; NO ack, no signal" --argjson pid "$BPID"
    exit 4
  fi
  jq -nc --argjson pid $$ --argjson sid "$(ps -o sid= -p $$ | tr -d ' ')" --arg ts "$(date -Iseconds)" \
    --argjson bp "$BPID" --argjson bg "$BPGID" --argjson bs "$BSID" --argjson bt "$BTICKS" --arg sent "$DSENT" \
    '{guardian_pid:$pid,guardian_sid:$sid,acked_at:$ts,bound_pid:$bp,bound_pgid:$bg,bound_sid:$bs,bound_ticks:$bt,sentinel:$sent,ack:"bound-identity"}' \
    > "$RUN/guardian-ack.json.tmp" && { sync -f "$RUN/guardian-ack.json.tmp" 2>/dev/null || sync; } \
    && mv "$RUN/guardian-ack.json.tmp" "$RUN/guardian-ack.json" && fsync_dir
  gev bound --argjson bound_pid "$BPID" --argjson bound_pgid "$BPGID" --argjson bound_ticks "$BTICKS"
fi

# --- enforcement loop ---
while true; do
  [ -f "$DONE" ] && { gev done-observed; exit 0; }
  NOW=$(date +%s)
  if [ "$NOW" -ge "$ENFORCE" ]; then
    if [ -z "$BPID" ]; then
      # no bound identity. Launch-intent without identity: controller died
      # pre-publication -> sweep the blocked sentinel via unique run path.
      if [ -f "$INTENT_FILE" ]; then
        gev intent-sweep --arg reason "launch-intent present, identity never published"
        SWPT=""
        for pid in $(pgrep -f "sentinel-launch.sh $RUN" 2>/dev/null); do
          if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF "sentinel-launch.sh $RUN"; then
            SWPT="$SWPT $pid"
          fi
        done
        SWPT=$(echo "$SWPT" | xargs 2>/dev/null)
        if [ -n "$SWPT" ]; then
          gev term-sent --arg pids "$SWPT" --arg via intent-sweep
          kill -TERM $SWPT 2>/dev/null
          i=0
          while [ $i -lt 10 ]; do
            REM=""
            for pid in $SWPT; do [ -d "/proc/$pid" ] && REM="$REM $pid"; done
            [ -z "$REM" ] && break
            sleep 1; i=$((i+1))
          done
          REM=""
          for pid in $SWPT; do [ -d "/proc/$pid" ] && REM="$REM $pid"; done
          if [ -n "$REM" ]; then
            STILL=""
            for pid in $REM; do
              tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF "sentinel-launch.sh $RUN" && STILL="$STILL $pid"
            done
            if [ -n "$STILL" ]; then
              gev kill-sent --arg pids "$STILL" --arg via intent-sweep
              kill -KILL $STILL 2>/dev/null
              sleep 1
            fi
          fi
        fi
        LEFT=0
        for pid in $(pgrep -f "sentinel-launch.sh $RUN" 2>/dev/null); do
          tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF "sentinel-launch.sh $RUN" && LEFT=$((LEFT+1))
        done
        gev residue --argjson members_remaining "$LEFT" --arg via intent-sweep
        exit 0
      fi
      gev no-identity-at-enforce-window --arg reason "no launch-intent, no identity; experiment launch never began"
      exit 0
    fi
    if ! verify_target; then
      if pgrep -g "$BPGID" >/dev/null 2>&1; then
        gev identity-refuse --arg reason "identity mismatch at enforce time with group members present; NO signal sent" --argjson pgid "$BPGID"
        exit 4
      fi
      gev residue --argjson members_remaining 0 --arg note "target already exited before enforcement"
      exit 0
    fi
    gev deadline-expired --argjson target_pgid "$BPGID"
    {
      echo "--- guardian diagnostics $(date -Iseconds) ---"
      ps auxf | head -60
      for pid in $(pgrep -g "$BPGID" 2>/dev/null); do
        echo "--- /proc/$pid ---"
        grep -E 'State|Threads|VmRSS|SigQ' "/proc/$pid/status" 2>/dev/null
        echo "wchan: $(cat "/proc/$pid/wchan" 2>/dev/null)"
        ls -l "/proc/$pid/fd" 2>/dev/null | awk '{print $NF}' | sed 's/[0-9]*$//' | sort | uniq -c | sort -rn | head -10
      done
    } >> "$GLOG" 2>&1
    sync -f "$GLOG" 2>/dev/null || sync
    gev term-sent --argjson target_pgid "$BPGID"
    kill -TERM -"$BPGID" 2>/dev/null
    i=0; while pgrep -g "$BPGID" >/dev/null 2>&1 && [ $i -lt 10 ]; do sleep 1; i=$((i+1)); done
    if pgrep -g "$BPGID" >/dev/null 2>&1; then
      if verify_target; then
        gev kill-sent --argjson target_pgid "$BPGID"
        kill -KILL -"$BPGID" 2>/dev/null
        sleep 2
      else
        gev identity-refuse --arg reason "identity changed after TERM wait; KILL withheld"
        exit 4
      fi
    fi
    LEFT=$(pgrep -g "$BPGID" 2>/dev/null | wc -l)
    gev residue --argjson members_remaining "$LEFT"
    exit 0
  fi
  sleep 1
done
