#!/usr/bin/env bash
# Guardian v5: separately launched (own session) backstop enforcing the
# persisted deadline at deadline+GUARDIAN_GRACE_S (default 15) so a live
# controller/sampler always acts first. Writes guardian-ack.json (atomic+fsync)
# immediately after validating the deadline file - the controller holds the
# experiment until that ack exists. Binds process identity (sentinel, pgid,
# sid, start ticks, cmdline) before any signal; mismatch -> loud refusal, no
# signal, nonzero exit. Every event line is valid JSON, including error paths.
# usage: guardian.sh <deadline-file>
set -u
DF="${1:-}"
[ -n "$DF" ] && [ -f "$DF" ] || exit 2
RUN=$(dirname "$DF")
DONE=$RUN/done
GLOG=$RUN/guardian.jsonl
IDENTITY_FILE=$RUN/identity.json
GRACE="${GUARDIAN_GRACE_S:-15}"
gev() { local line; line=$(jq -nc --arg ts "$(date -Iseconds)" --arg ev "guardian-$1" "${@:2}" '{ts:$ts,ev:$ev}+($ARGS.named|del(.ts,.ev))' 2>/dev/null) && { echo "$line" >> "$GLOG"; sync -f "$GLOG" 2>/dev/null || sync; }; }

# --- read + validate deadline (retry for transients; malformed -> valid-JSON error, exit 3) ---
DEADLINE=""; DSENT=""; DPGID=""
for _ in $(seq 1 20); do
  [ -f "$DONE" ] && { gev done-observed --arg phase pre-bind; exit 0; }
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
# ack (atomic + fsync): the controller gates experiment launch on this file
jq -nc --argjson pid $$ --argjson sid "$(ps -o sid= -p $$ | tr -d ' ')" --arg ts "$(date -Iseconds)" \
  '{guardian_pid:$pid,guardian_sid:$sid,acked_at:$ts}' > "$RUN/guardian-ack.json.tmp" \
  && mv "$RUN/guardian-ack.json.tmp" "$RUN/guardian-ack.json" && { sync -f "$RUN/guardian-ack.json" 2>/dev/null || sync; }
gev start --argjson deadline_epoch "$DEADLINE" --argjson enforce_epoch "$ENFORCE" --argjson grace_s "$GRACE" --argjson guardian_pid "$$"

# --- identity binding check (returns 0 only on full match) ---
verify_identity() {
  [ -f "$IDENTITY_FILE" ] || return 1
  jq -e . "$IDENTITY_FILE" >/dev/null 2>&1 || return 1
  local vpid vpgid vsid vticks vsent vcmdsha
  vpid=$(jq -r '.pid // empty' "$IDENTITY_FILE"); vpgid=$(jq -r '.pgid // empty' "$IDENTITY_FILE")
  vsid=$(jq -r '.sid // empty' "$IDENTITY_FILE"); vticks=$(jq -r '.start_ticks // empty' "$IDENTITY_FILE")
  vsent=$(jq -r '.sentinel // empty' "$IDENTITY_FILE"); vcmdsha=$(jq -r '.cmdline_sha1 // empty' "$IDENTITY_FILE")
  [[ "$vpid" =~ ^[0-9]+$ ]] || return 1
  [ "$vsent" = "$DSENT" ] || return 1
  if [ ! -d "/proc/$vpid" ]; then
    # leader exited: accept only remnants verifiably in the recorded session
    local m ms ok=1
    for m in $(pgrep -g "$vpgid" 2>/dev/null); do
      ms=$(ps -o sid= -p "$m" 2>/dev/null | tr -d ' ')
      [ "$ms" = "$vsid" ] || { ok=0; break; }
    done
    [ "$ok" = "1" ] && [ -n "$(pgrep -g "$vpgid" 2>/dev/null)" ]
    return $?
  fi
  [ "$(ps -o pgid= -p "$vpid" 2>/dev/null | tr -d ' ')" = "$vpgid" ] || return 1
  [ "$(ps -o sid= -p "$vpid" 2>/dev/null | tr -d ' ')" = "$vsid" ] || return 1
  [ "$(sed 's/^.*) //' "/proc/$vpid/stat" 2>/dev/null | awk '{print $20}')" = "$vticks" ] || return 1
  [ "$(tr '\0' ' ' < "/proc/$vpid/cmdline" 2>/dev/null | sed 's/ $//' | sha1sum | cut -d' ' -f1)" = "$vcmdsha" ] || return 1
  return 0
}

while true; do
  [ -f "$DONE" ] && { gev done-observed; exit 0; }
  NOW=$(date +%s)
  if [ "$NOW" -ge "$ENFORCE" ]; then
    if [ ! -f "$IDENTITY_FILE" ]; then
      gev enforce-no-target --arg reason "no identity.json at enforce time; experiment never launched or controller died pre-launch"
      exit 0
    fi
    TPGID=$(jq -r '.pgid // 0' "$IDENTITY_FILE" 2>/dev/null)
    if ! verify_identity; then
      gev identity-refuse --arg reason "identity mismatch (sentinel/pid/pgid/sid/start-ticks/cmdline); NO signal sent" --argjson target_pgid "${TPGID:-0}"
      exit 4
    fi
    gev deadline-expired --argjson target_pgid "$TPGID"
    {
      echo "--- guardian diagnostics $(date -Iseconds) ---"
      ps auxf | head -60
      for pid in $(pgrep -g "$TPGID" 2>/dev/null); do
        echo "--- /proc/$pid ---"
        grep -E 'State|Threads|VmRSS|SigQ' "/proc/$pid/status" 2>/dev/null
        echo "wchan: $(cat "/proc/$pid/wchan" 2>/dev/null)"
        ls -l "/proc/$pid/fd" 2>/dev/null | awk '{print $NF}' | sed 's/[0-9]*$//' | sort | uniq -c | sort -rn | head -10
      done
    } >> "$GLOG" 2>&1
    sync -f "$GLOG" 2>/dev/null || sync
    if pgrep -g "$TPGID" >/dev/null 2>&1; then
      gev term-sent --argjson target_pgid "$TPGID"
      kill -TERM -"$TPGID" 2>/dev/null
      i=0; while pgrep -g "$TPGID" >/dev/null 2>&1 && [ $i -lt 10 ]; do sleep 1; i=$((i+1)); done
      if pgrep -g "$TPGID" >/dev/null 2>&1; then
        if verify_identity; then
          gev kill-sent --argjson target_pgid "$TPGID"
          kill -KILL -"$TPGID" 2>/dev/null
          sleep 2
        else
          gev identity-refuse --arg reason "identity changed after TERM wait; KILL withheld"
          exit 4
        fi
      fi
    fi
    LEFT=$(pgrep -g "$TPGID" 2>/dev/null | wc -l)
    gev residue --argjson members_remaining "$LEFT"
    exit 0
  fi
  sleep 2
done
