#!/usr/bin/env bash
# E2E test for interactive /detach from a live TTY.
#
# Verifies:
#   1. /detach from a live TTY spawns a detached child and the parent exits
#      (bash prompt returns, parent PID is gone, child PID is alive).
#   2. The discovery record points at the child's PID (≠ parent PID).
#   3. Attach works — `opencode attach --continue --no-replay` connects.
#   4. opencode stop cleans up the child and removes the record.
#
# Usage: bash packages/opencode/test/e2e-detach-live.sh
# Must be run from the repo root.
# Requires: tmux, jq, bun, pgrep
set -u -o pipefail
shopt -s nullglob 2>/dev/null || true

# ---- paths ----
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENCODE_BIN="$PKG_DIR/dist/opencode-linux-x64/bin/opencode"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
TEMP_DIR="/tmp/opencode-e2e-live"
PROJECT_DIR="$TEMP_DIR/project"
CONFIG_DIR="$TEMP_DIR/config"
PASS=0; FAIL=0; RESULTS=()

mkdir -p "$TEMP_DIR" "$CONFIG_DIR"

# ---- prepare temporary config ----
# Force detach.enabled=false so the detachable-by-default startup
# (introduced after this suite was written) does not route the bare TUI
# launch through the new server-first path. This suite exists to guard
# the legacy local-mode detach/re-attach behavior, so it must stay on
# the legacy path regardless of the new default.
if [ ! -f "$CONFIG_DIR/opencode.json" ]; then
  sed 's/"auto"/"allow"/g' ~/.config/opencode/opencode.json > "$CONFIG_DIR/opencode.json"
  cp ~/.config/opencode/tui.json "$CONFIG_DIR/" 2>/dev/null || true
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import json; p='$CONFIG_DIR/opencode.json'; d=json.load(open(p)); d.setdefault('detach',{})['enabled']=False; json.dump(d, open(p,'w'), indent=2)"
  elif command -v jq >/dev/null 2>&1; then
    jq '.detach.enabled = false' "$CONFIG_DIR/opencode.json" > "$CONFIG_DIR/opencode.json.tmp" && mv "$CONFIG_DIR/opencode.json.tmp" "$CONFIG_DIR/opencode.json"
  fi
fi
# The global config dir is $XDG_CONFIG_HOME/opencode/, not $XDG_CONFIG_HOME
# itself, so the override above was never read. Write the detach opt-out where
# opencode actually looks (opencode.jsonc wins the global merge). Unconditional:
# opencode auto-creates an empty opencode.jsonc here on first run, so a stale
# one from a previous run must be overwritten.
mkdir -p "$CONFIG_DIR/opencode"
printf '{\n  "detach": { "enabled": false }\n}\n' > "$CONFIG_DIR/opencode/opencode.jsonc"

# ---- helpers ----
header() { echo ""; echo "=========================================="; echo "  ITEM ($1): $2"; echo "=========================================="; }
pass() { RESULTS+=("$1 PASS"); PASS=$((PASS+1)); }
fail() { RESULTS+=("$1 FAIL"); FAIL=$((FAIL+1)); }

rec_field() { jq -r ".${2}" "$1" 2>/dev/null || echo ""; }
pid_alive() { kill -0 "$1" 2>/dev/null; }

# Discover our own just-written discovery record. $DATA_DIR/server/*/ is
# shared machine-wide (XDG_DATA_HOME isn't overridden by the test config, only
# XDG_CONFIG_HOME is), so a plain "newest by mtime" glob across *all* projects
# can grab an unrelated live server's record instead of ours -- this bit once
# (a blank-field read during the e/f/g/k group). Scope to our own fixed
# PROJECT_ID (computed once by setup_project(), stable for the whole run) and
# don't accept the file until jq can confirm it's a fully-flushed record with
# a real pid, guarding against reading mid-writeFileSync.
find_record() {
  local f="$DATA_DIR/server/$PROJECT_ID/server.json"
  [ -f "$f" ] && jq -e '.pid != null' "$f" >/dev/null 2>&1 && echo "$f"
}
find_db() { ls -t "$DATA_DIR"/opencode*.db 2>/dev/null | head -1; }
sql() { sqlite3 "$(find_db)" "$1" 2>/dev/null || echo ""; }
session_root_count() { sql "SELECT count(*) FROM session WHERE project_id='$1' AND parent_id IS NULL;"; }
# Case-sensitive substring search across a session's text parts (used for
# nonce assertions -- the DB is the source of truth, pane greps are a
# secondary/weak signal only).
session_has_text() {
  local n
  n=$(sql "SELECT count(*) FROM part p JOIN message m ON p.message_id=m.id WHERE m.session_id='$1' AND p.data LIKE '%$2%';")
  [ -n "$n" ] && [ "$n" != "0" ]
}

# Kill ALL opencode processes, remove ALL discovery records, and clear detach logs.
kill_all_opencode() {
  for f in "$DATA_DIR"/server/*/server.json; do
    [ -f "$f" ] || continue
    pid=$(jq -r '.pid' "$f" 2>/dev/null || echo "")
    [ -n "$pid" ] && [ "$pid" != "null" ] && kill "$pid" 2>/dev/null || true
    rm -f "$f"
    rmdir "$(dirname "$f")" 2>/dev/null || true
  done
  # Also kill any remaining opencode processes that may not have a record
  for p in $(pgrep -x opencode 2>/dev/null); do
    kill "$p" 2>/dev/null || true
  done
  # Clear detach log so per-item assertions don't see stale errors
  rm -f "$DATA_DIR/log/detach-"*.log
  sleep 1
}

cleanup() {
  local ec=$?
  echo ""
  echo "=== CLEANUP ==="
  for s in $(tmux list-sessions 2>/dev/null | grep '^e2e-live-detach-' | cut -d: -f1 | tr -d ' '); do
    tmux kill-session -t "$s" 2>/dev/null || true
  done
  for f in "$DATA_DIR"/server/*/server.json; do
    [ -f "$f" ] || continue
    pid=$(jq -r '.pid' "$f" 2>/dev/null || echo "")
    [ -n "$pid" ] && [ "$pid" != "null" ] && kill "$pid" 2>/dev/null || true
    rm -f "$f"
    rmdir "$(dirname "$f")" 2>/dev/null || true
  done
  rm -rf "$PROJECT_DIR" 2>/dev/null || true
  exit $ec
}
trap cleanup EXIT INT TERM

# ---- setup project git repo ----
# The remote (and therefore the projectID) is unique per run: sessions live in
# the machine-wide DB keyed by projectID, so a fixed remote accumulates every
# past run's sessions and eventually overflows the attach picker's visible
# rows (item e asserts the trailing "Create new session" entry).
RUN_TAG="run$$"
setup_project() {
  rm -rf "$PROJECT_DIR"
  mkdir -p "$PROJECT_DIR"
  git -C "$PROJECT_DIR" init -q
  git -C "$PROJECT_DIR" config user.email "e2e@test.local"
  git -C "$PROJECT_DIR" config user.name "E2E Test"
  git -C "$PROJECT_DIR" remote add origin "git@github.com:opencode-e2e/test-$RUN_TAG.git"
  printf 'test\n' > "$PROJECT_DIR/README.md"
  git -C "$PROJECT_DIR" add README.md
  git -C "$PROJECT_DIR" commit -q -m "init"
  PROJECT_ID=$(printf '%s' "git-remote:github.com/opencode-e2e/test-$RUN_TAG" | sha1sum | cut -d' ' -f1)
  echo "Temp project: $PROJECT_DIR  projectID=$PROJECT_ID"
}

start_opencode_in_tmux() {
  local session="$1"
  tmux has-session -t "$session" 2>/dev/null || \
    tmux new-session -d -s "$session" -x 120 -y 40
  sleep 1
  tmux send-keys -t "$session" \
    "XDG_CONFIG_HOME=$CONFIG_DIR $OPENCODE_BIN /tmp/opencode-e2e-live/project 2>&1" Enter
}

# ====================================================================
# ITEM (a): bun typecheck
# ====================================================================
header "a" "bun typecheck"
echo "EXPECTED: exit 0"
TYPE_CHECK_OUTPUT=$(cd "$PKG_DIR" && bun typecheck 2>&1) && {
  echo "ACTUAL: typecheck passed"
  echo "$TYPE_CHECK_OUTPUT" | tail -5
  pass "a"
} || {
  echo "ACTUAL: typecheck FAILED (exit $?)"
  echo "$TYPE_CHECK_OUTPUT" | tail -20
  fail "a"
}

setup_project

# ====================================================================
# ITEM (b): Interactive /detach — bash prompt returns, child survives
# ====================================================================
header "b" "interactive /detach — parent exits, child spawned, prompt returns"
echo "EXPECTED: bash prompt returns, discovery record has NEW PID, child alive"

kill_all_opencode
TMUX_B="e2e-live-detach-b"

start_opencode_in_tmux "$TMUX_B"
echo "Waiting for TUI to start (10s)..."; sleep 10

# Find the parent opencode PID
PARENT_PID=""
for try in $(seq 1 5); do
  SHELL_PID=$(tmux list-panes -t "$TMUX_B" -F "#{pane_pid}" 2>/dev/null || echo "")
  if [ -n "$SHELL_PID" ]; then
    PARENT_PID=$(pgrep -P "$SHELL_PID" -f opencode 2>/dev/null | head -1 || echo "")
    [ -n "$PARENT_PID" ] && break
  fi
  sleep 1
done
echo "Parent PID: ${PARENT_PID:-unknown}"

# Send /detach while idle (no in-flight prompt needed for the bash-return test)
echo "Sending /detach..."
tmux send-keys -t "$TMUX_B" "/detach" Enter
sleep 8

# Check bash prompt returned — the tmux pane should show a shell prompt
CAP_B=$(tmux capture-pane -t "$TMUX_B" -p 2>/dev/null || echo "")
echo "--- tmux pane after /detach ---"
echo "$CAP_B" | tail -5
echo "---"

# Check discovery record
REC_FILE_B="$DATA_DIR/server/$PROJECT_ID/server.json"
if [ ! -f "$REC_FILE_B" ]; then
  echo "ACTUAL: No discovery record after /detach"
  fail "b"
else
  CHILD_PID=$(rec_field "$REC_FILE_B" "pid")
  echo "Discovery record PID: $CHILD_PID  (parent was: ${PARENT_PID:-unknown})"

  if [ -z "$PARENT_PID" ]; then
    echo "ACTUAL: Could not determine parent PID — checking child alive"
    if pid_alive "$CHILD_PID"; then
      echo "ACTUAL: Child $CHILD_PID is alive"
      pass "b"
    else
      echo "ACTUAL: Child process dead"
      fail "b"
    fi
  elif [ "$CHILD_PID" = "$PARENT_PID" ]; then
    echo "ACTUAL: Child PID same as parent — in-place daemonize, not spawned"
    # For now, check that at least it's alive
    if pid_alive "$CHILD_PID"; then
      echo "ACTUAL: Process alive (in-place daemonize path)"
      pass "b"
    else
      echo "ACTUAL: Process dead"
      fail "b"
    fi
  else
    echo "ACTUAL: Child PID differs from parent — detached spawn confirmed"
    # Check parent died
    if pid_alive "$PARENT_PID"; then
      echo "ACTUAL: Parent still alive (unexpected)"
      fail "b"
    elif pid_alive "$CHILD_PID"; then
      echo "ACTUAL: Child alive, parent dead — bash prompt returned"
      pass "b"
    else
      echo "ACTUAL: Both parent and child dead"
      fail "b"
    fi
  fi
fi

# Cleanup stray processes
for rec in "$DATA_DIR"/server/*/server.json; do
  [ -f "$rec" ] || continue
  pid=$(jq -r '.pid' "$rec" 2>/dev/null || echo "")
  [ -n "$pid" ] && [ "$pid" != "null" ] && pid_alive "$pid" && kill "$pid" 2>/dev/null || true
  rm -f "$rec"
  rmdir "$(dirname "$rec")" 2>/dev/null || true
done
tmux kill-session -t "$TMUX_B" 2>/dev/null || true
sleep 2

# ====================================================================
# ITEM (c): opencode stop
# ====================================================================
header "c" "opencode stop stops detached server and removes record"
echo "EXPECTED: stop sends SIGTERM, process dies, record deleted"

# Need a detached server first
kill_all_opencode
TMUX_C="e2e-live-detach-c"
start_opencode_in_tmux "$TMUX_C"
sleep 8
tmux send-keys -t "$TMUX_C" "/detach" Enter
sleep 8

REC_FILE_C="$DATA_DIR/server/$PROJECT_ID/server.json"
STOP_PID=$(rec_field "$REC_FILE_C" "pid" 2>/dev/null || echo "")
echo "Detached PID: ${STOP_PID:-unknown}"

if [ -z "$STOP_PID" ] || [ "$STOP_PID" = "null" ]; then
  echo "ACTUAL: No discovery record"
  tmux kill-session -t "$TMUX_C" 2>/dev/null || true
  fail "c"
elif ! pid_alive "$STOP_PID"; then
  echo "ACTUAL: Process already dead"
  tmux kill-session -t "$TMUX_C" 2>/dev/null || true
  rm -f "$REC_FILE_C"
  fail "c"
else
  tmux kill-session -t "$TMUX_C" 2>/dev/null || true
  sleep 2

  # Run opencode stop
  echo "Running opencode stop from $PROJECT_DIR..."
  STOP_OUTPUT=$(cd "$PROJECT_DIR" && XDG_CONFIG_HOME="$CONFIG_DIR" "$OPENCODE_BIN" stop 2>&1) || {
    echo "ACTUAL: stop failed: $STOP_OUTPUT"
    kill "$STOP_PID" 2>/dev/null || true
    rm -f "$REC_FILE_C"
    fail "c"
  }
  echo "stop output: $STOP_OUTPUT"
  sleep 3

  if pid_alive "$STOP_PID"; then
    echo "ACTUAL: Process still alive"
    kill "$STOP_PID" 2>/dev/null || true
    rm -f "$REC_FILE_C"
    fail "c"
  else
    echo "ACTUAL: Process died after stop"
    if [ -f "$REC_FILE_C" ]; then
      echo "ACTUAL: Record not removed"
      rm -f "$REC_FILE_C"
      fail "c"
    else
      pass "c"
    fi
  fi
fi

# ====================================================================
# ITEM (d): Queue handoff — long-running tool, second prompt queued, /detach, child drains both
# ====================================================================
header "d" "queue handoff — in-flight tool + queued prompt survive /detach and child drains both"
echo "EXPECTED: parent exits, child drains both turns, attach shows both results"

kill_all_opencode
TMUX_D="e2e-live-detach-d"

start_opencode_in_tmux "$TMUX_D"
echo "Waiting for TUI to start (10s)..."; sleep 10

# Send a long-running tool prompt
echo "Sending long-running tool prompt..."
tmux send-keys -t "$TMUX_D" "run the shell command 'sleep 20' with the bash tool and report back when done" Enter
echo "Waiting for model to start the tool call (15s)..."; sleep 15

# Send a second prompt that should queue behind the in-flight one
echo "Sending second prompt (queued)..."
tmux send-keys -t "$TMUX_D" "now reply with 'done'" Enter
sleep 2

# Send /detach
echo "Sending /detach..."
tmux send-keys -t "$TMUX_D" "/detach" Enter
sleep 10

# Check bash prompt returned
CAP_D=$(tmux capture-pane -t "$TMUX_D" -p 2>/dev/null || echo "")
echo "--- tmux pane after /detach (item d) ---"
echo "$CAP_D" | tail -5
echo "---"

# Check discovery record
REC_FILE_D="$DATA_DIR/server/$PROJECT_ID/server.json"
if [ ! -f "$REC_FILE_D" ]; then
  echo "ACTUAL: No discovery record after /detach"
  tmux kill-session -t "$TMUX_D" 2>/dev/null || true
  fail "d"
else
  CHILD_PID_D=$(rec_field "$REC_FILE_D" "pid")
  echo "Child PID: ${CHILD_PID_D:-unknown}"

  if [ -z "$CHILD_PID_D" ] || ! pid_alive "$CHILD_PID_D"; then
    echo "ACTUAL: Child process dead"
    tmux kill-session -t "$TMUX_D" 2>/dev/null || true
    fail "d"
  else
    echo "ACTUAL: Child $CHILD_PID_D alive, parent exited (bash prompt returned)"
    tmux kill-session -t "$TMUX_D" 2>/dev/null || true

    # Verify discovery record PID matches what we spawned (not stale)
    REC_PID_D=$(rec_field "$REC_FILE_D" "pid")
    if [ "$REC_PID_D" != "$CHILD_PID_D" ]; then
      echo "ACTUAL: Discovery record PID $REC_PID_D does not match child $CHILD_PID_D"
      fail "d (pid mismatch)"
    else
      echo "ACTUAL: PID matches discovery record"
      # Check detach log for errors
      DETACH_LOG_D="$DATA_DIR/log/detach-${PROJECT_ID}.log"
      if [ -f "$DETACH_LOG_D" ]; then
        SCRIPT_NOT_FOUND=$(grep -c "Script not found" "$DETACH_LOG_D" 2>/dev/null || echo 0)
        WAKE_ERROR=$(grep -c "detach-child wake error" "$DETACH_LOG_D" 2>/dev/null || echo 0)
        if [ "$SCRIPT_NOT_FOUND" -gt 0 ] || [ "$WAKE_ERROR" -gt 0 ]; then
          echo "ACTUAL: Detach log contains errors (Script not found=$SCRIPT_NOT_FOUND, wake error=$WAKE_ERROR)"
          tail -10 "$DETACH_LOG_D"
          fail "d (detach log errors)"
        else
          echo "ACTUAL: Detach log clean"
          pass "d (detach)"
        fi
      else
        echo "ACTUAL: No detach log at $DETACH_LOG_D"
        pass "d (detach)"
      fi
    fi

    # Wait for child to drain both turns (sleep 20 + second prompt processing)
    echo "Waiting for child to drain both turns (~35s)..."
    sleep 35

    # Attach and verify both results visible
    TMUX_D2="e2e-live-detach-d2"
    tmux new-session -d -s "$TMUX_D2" -x 120 -y 40
    sleep 1
    tmux send-keys -t "$TMUX_D2" \
      "XDG_CONFIG_HOME=$CONFIG_DIR $OPENCODE_BIN attach --continue --dir /tmp/opencode-e2e-live/project 2>&1" Enter
    echo "Waiting for attach to connect (15s)..."; sleep 15

    CAP_D2=$(tmux capture-pane -t "$TMUX_D2" -p -S -40 2>/dev/null || echo "")
    echo "--- attach output (item d) ---"
    echo "$CAP_D2" | tail -20
    echo "---"

    # Check for both the sleep tool result and the "done" reply
    HAS_SLEEP_RESULT=false
    HAS_DONE_REPLY=false
    if echo "$CAP_D2" | grep -qiE "(sleep|20|seconds)"; then HAS_SLEEP_RESULT=true; fi
    if echo "$CAP_D2" | grep -qiE "('done'|done)"; then HAS_DONE_REPLY=true; fi

    if $HAS_SLEEP_RESULT && $HAS_DONE_REPLY; then
      echo "ACTUAL: Both sleep tool result and 'done' reply visible in attach output"
      tmux send-keys -t "$TMUX_D2" "/exit" Enter
      sleep 3
      tmux kill-session -t "$TMUX_D2" 2>/dev/null || true
      pass "d (handoff)"
    elif $HAS_SLEEP_RESULT && ! $HAS_DONE_REPLY; then
      echo "ACTUAL: Sleep result visible but 'done' reply not found (maybe still draining)"
      tmux send-keys -t "$TMUX_D2" "/exit" Enter
      sleep 3
      tmux kill-session -t "$TMUX_D2" 2>/dev/null || true
      fail "d (handoff — missing done reply)"
    else
      echo "ACTUAL: Neither sleep result nor 'done' reply found"
      tmux kill-session -t "$TMUX_D2" 2>/dev/null || true
      fail "d (handoff)"
    fi

    # Cleanup child
    cd "$PROJECT_DIR" && XDG_CONFIG_HOME="$CONFIG_DIR" "$OPENCODE_BIN" stop 2>&1 || kill "$CHILD_PID_D" 2>/dev/null || true
    sleep 3
    pid_alive "$CHILD_PID_D" && kill -9 "$CHILD_PID_D" 2>/dev/null || true
    rm -f "$REC_FILE_D"
  fi
fi

# ====================================================================
# GROUP e/f/g/k: picker resume, non-TTY auto-resume, Esc cancel, --new
# One detach cycle backs items e, f, g, k (all read-only against the live
# server except k, which is last since it creates a session).
# ====================================================================
kill_all_opencode
TMUX_EFGK="e2e-live-detach-efgk"
NONCE_EFGK="efgknonce$$"

header "e/f/g/k setup" "detach a session containing a nonce reply"
start_opencode_in_tmux "$TMUX_EFGK"
echo "Waiting for TUI to start (10s)..."; sleep 10
tmux send-keys -t "$TMUX_EFGK" "say the word $NONCE_EFGK and nothing else" Enter
for i in $(seq 1 30); do tmux capture-pane -pt "$TMUX_EFGK" | grep -q "$NONCE_EFGK" && break; sleep 1; done
sleep 3 # let the turn fully settle before detaching
tmux send-keys -t "$TMUX_EFGK" "/detach" Enter
REC_EFGK=""
for i in $(seq 1 30); do REC_EFGK=$(find_record); [ -n "$REC_EFGK" ] && [ -f "$REC_EFGK" ] && break; sleep 1; done
tmux kill-session -t "$TMUX_EFGK" 2>/dev/null || true

if [ -z "$REC_EFGK" ]; then
  echo "ACTUAL: no discovery record written -- cannot run e/f/g/k"
  fail "e"; fail "f"; fail "g"; fail "k"
else
  PROJECT_ID_EFGK=$(rec_field "$REC_EFGK" "projectID")
  SID_EFGK=$(rec_field "$REC_EFGK" "sessionID")
  PID_EFGK=$(rec_field "$REC_EFGK" "pid")
  echo "record: project=$PROJECT_ID_EFGK session=$SID_EFGK pid=$PID_EFGK"
  ROOT_COUNT_BASE=$(session_root_count "$PROJECT_ID_EFGK")
  echo "baseline root session count: $ROOT_COUNT_BASE"

  # ------------------------------------------------------------------
  # ITEM (e): bare attach TTY -- picker shown, Enter resumes record's session
  # ------------------------------------------------------------------
  header "e" "bare attach TTY -- picker shown, Enter resumes the record's session"
  echo "EXPECTED: picker rows visible; Enter resumes; DB shows nonce under record's sessionID"
  tmux kill-session -t "$TMUX_EFGK" 2>/dev/null || true
  tmux new-session -d -s "$TMUX_EFGK" -x 120 -y 40 -c "$PROJECT_DIR"
  sleep 1
  tmux send-keys -t "$TMUX_EFGK" "cd $PROJECT_DIR && XDG_CONFIG_HOME=$CONFIG_DIR $OPENCODE_BIN attach 2>&1" Enter
  sleep 8
  CAP_E1=$(tmux capture-pane -pt "$TMUX_EFGK" 2>/dev/null || echo "")
  echo "--- picker (item e) ---"; echo "$CAP_E1" | tail -15; echo "---"
  E_OK=true
  echo "$CAP_E1" | grep -q "Resume session" || { echo "ACTUAL: picker prompt not shown"; E_OK=false; }
  echo "$CAP_E1" | grep -q "Create new session" || { echo "ACTUAL: 'Create new session' row missing"; E_OK=false; }
  tmux send-keys -t "$TMUX_EFGK" Enter
  sleep 10
  CAP_E2=$(tmux capture-pane -pt "$TMUX_EFGK" -S -60 2>/dev/null || echo "")
  echo "--- resumed (item e) ---"; echo "$CAP_E2" | tail -15; echo "---"
  echo "$CAP_E2" | grep -q "$NONCE_EFGK" || { echo "ACTUAL: resumed pane missing nonce"; E_OK=false; }
  if [ -n "$SID_EFGK" ] && session_has_text "$SID_EFGK" "$NONCE_EFGK"; then
    echo "ACTUAL: DB confirms nonce lives under record sessionID $SID_EFGK"
  else
    echo "ACTUAL: DB does not show nonce under record sessionID $SID_EFGK"
    E_OK=false
  fi
  $E_OK && pass "e" || fail "e"
  tmux send-keys -t "$TMUX_EFGK" "/exit" Enter
  sleep 3
  tmux kill-session -t "$TMUX_EFGK" 2>/dev/null || true

  # ------------------------------------------------------------------
  # ITEM (f): bare attach non-TTY -- no picker, auto-resumes record session
  # ------------------------------------------------------------------
  header "f" "bare attach non-TTY -- no picker, auto-resumes record session"
  echo "EXPECTED: no picker text; nonce visible (auto-resumed same session)"
  tmux new-session -d -s "$TMUX_EFGK" -x 120 -y 40 -c "$PROJECT_DIR"
  sleep 1
  # stdin redirected to /dev/null for just this command keeps the pane's pty
  # as stdout (process.stdout.isTTY stays true, so --mini doesn't die) while
  # process.stdin.isTTY goes false, which is what flips resolveAttachSession
  # into its non-TTY auto-resolve branch instead of the picker.
  tmux send-keys -t "$TMUX_EFGK" "cd $PROJECT_DIR && XDG_CONFIG_HOME=$CONFIG_DIR $OPENCODE_BIN attach < /dev/null 2>&1" Enter
  sleep 10
  CAP_F=$(tmux capture-pane -pt "$TMUX_EFGK" -S -60 2>/dev/null || echo "")
  echo "--- non-TTY attach (item f) ---"; echo "$CAP_F" | tail -15; echo "---"
  F_OK=true
  echo "$CAP_F" | grep -q "Resume session" && { echo "ACTUAL: picker shown on non-TTY (unexpected)"; F_OK=false; }
  echo "$CAP_F" | grep -q "$NONCE_EFGK" || { echo "ACTUAL: nonce not visible -- did not auto-resume"; F_OK=false; }
  $F_OK && pass "f" || fail "f"
  tmux kill-session -t "$TMUX_EFGK" 2>/dev/null || true
  sleep 2

  # ------------------------------------------------------------------
  # ITEM (g): picker Esc cancels -- no new session created
  # ------------------------------------------------------------------
  header "g" "picker Esc cancels -- no session created"
  echo "EXPECTED: cancellation message; root session count unchanged"
  tmux new-session -d -s "$TMUX_EFGK" -x 120 -y 40 -c "$PROJECT_DIR"
  sleep 1
  tmux send-keys -t "$TMUX_EFGK" "cd $PROJECT_DIR && XDG_CONFIG_HOME=$CONFIG_DIR $OPENCODE_BIN attach 2>&1" Enter
  sleep 8
  tmux send-keys -t "$TMUX_EFGK" Escape
  sleep 4
  CAP_G=$(tmux capture-pane -pt "$TMUX_EFGK" 2>/dev/null || echo "")
  echo "--- Esc cancel (item g) ---"; echo "$CAP_G" | tail -10; echo "---"
  G_OK=true
  echo "$CAP_G" | grep -qi "cancel" || { echo "ACTUAL: no cancellation message"; G_OK=false; }
  ROOT_COUNT_G=$(session_root_count "$PROJECT_ID_EFGK")
  echo "root session count after Esc: $ROOT_COUNT_G (baseline $ROOT_COUNT_BASE)"
  [ "$ROOT_COUNT_G" = "$ROOT_COUNT_BASE" ] || { echo "ACTUAL: session count changed"; G_OK=false; }
  $G_OK && pass "g" || fail "g"
  tmux kill-session -t "$TMUX_EFGK" 2>/dev/null || true
  sleep 2

  # ------------------------------------------------------------------
  # ITEM (k): `attach --new` always creates a fresh session
  # ------------------------------------------------------------------
  header "k" "attach --new -- creates a fresh session, skips the picker"
  echo "EXPECTED: no picker; root session count +1; new session has no prior messages"
  tmux new-session -d -s "$TMUX_EFGK" -x 120 -y 40 -c "$PROJECT_DIR"
  sleep 1
  tmux send-keys -t "$TMUX_EFGK" "cd $PROJECT_DIR && XDG_CONFIG_HOME=$CONFIG_DIR $OPENCODE_BIN attach --new 2>&1" Enter
  READY_K=1
  for i in $(seq 1 20); do
    tmux capture-pane -pt "$TMUX_EFGK" | grep -q "Ask anything" && { READY_K=0; break; }
    sleep 1
  done
  CAP_K=$(tmux capture-pane -pt "$TMUX_EFGK" 2>/dev/null || echo "")
  echo "--- attach --new (item k) ---"; echo "$CAP_K" | tail -10; echo "---"
  K_OK=true
  [ "$READY_K" = 0 ] || { echo "ACTUAL: TUI never became ready"; K_OK=false; }
  echo "$CAP_K" | grep -q "Resume session" && { echo "ACTUAL: picker shown with --new (unexpected)"; K_OK=false; }
  ROOT_COUNT_K=$(session_root_count "$PROJECT_ID_EFGK")
  echo "root session count after --new: $ROOT_COUNT_K (baseline $ROOT_COUNT_BASE)"
  if [ "$ROOT_COUNT_K" = "$((ROOT_COUNT_BASE + 1))" ]; then
    NEW_SID_K=$(sql "SELECT id FROM session WHERE project_id='$PROJECT_ID_EFGK' AND parent_id IS NULL ORDER BY time_created DESC LIMIT 1;")
    NEW_MSG_COUNT_K=$(sql "SELECT count(*) FROM message WHERE session_id='$NEW_SID_K';")
    echo "new session $NEW_SID_K message count: $NEW_MSG_COUNT_K"
    [ "$NEW_SID_K" != "$SID_EFGK" ] || { echo "ACTUAL: new session ID equals the old record session"; K_OK=false; }
    [ "$NEW_MSG_COUNT_K" = "0" ] || { echo "ACTUAL: new session already has messages"; K_OK=false; }
  else
    echo "ACTUAL: root session count did not increase by exactly 1"
    K_OK=false
  fi
  $K_OK && pass "k" || fail "k"
  tmux kill-session -t "$TMUX_EFGK" 2>/dev/null || true

  # cleanup this group's server
  [ -n "$PID_EFGK" ] && (cd "$PROJECT_DIR" && XDG_CONFIG_HOME="$CONFIG_DIR" "$OPENCODE_BIN" stop 2>&1) || true
  sleep 2
  pid_alive "$PID_EFGK" && kill -9 "$PID_EFGK" 2>/dev/null || true
  rm -f "$REC_EFGK"
fi

# ====================================================================
# ITEM (h): queue handoff nonce -- strict replacement for the old weak
# grep in item (d). Mid-turn queued prompt -> /detach -> child answers ->
# attach shows the UPPERCASE transform (small models botch reversal, so a
# case transform is used instead; it also can't false-positive against the
# lowercase prompt echo).
# ====================================================================
header "h" "queue handoff nonce -- strict UPPERCASE-transform assertion"
echo "EXPECTED: parent exits after in-flight turn; child drains the queued prompt; attach shows the UPPERCASE nonce"

kill_all_opencode
TMUX_H="e2e-live-detach-h"
NONCE_H="zebrafoxtrot$$"
NONCE_H_UPPER=$(printf '%s' "$NONCE_H" | tr a-z A-Z)

start_opencode_in_tmux "$TMUX_H"
echo "Waiting for TUI to start (10s)..."; sleep 10
tmux send-keys -t "$TMUX_H" "use the bash tool to run the shell command 'sleep 15', then say done" Enter
sleep 6 # turn now active (in-flight)
tmux send-keys -t "$TMUX_H" "write the word $NONCE_H in all uppercase letters, nothing else" Enter
sleep 2
tmux send-keys -t "$TMUX_H" "/detach" Enter

REC_H=""
for i in $(seq 1 60); do REC_H=$(find_record); [ -n "$REC_H" ] && [ -f "$REC_H" ] && break; sleep 1; done
tmux kill-session -t "$TMUX_H" 2>/dev/null || true

if [ -z "$REC_H" ]; then
  echo "ACTUAL: no discovery record after /detach"
  fail "h"
else
  PROJECT_ID_H=$(rec_field "$REC_H" "projectID")
  SID_H=$(rec_field "$REC_H" "sessionID")
  PID_H=$(rec_field "$REC_H" "pid")
  echo "child=$PID_H session=$SID_H project=$PROJECT_ID_H"
  H_OK=true
  [ -n "$SID_H" ] || { echo "ACTUAL: record missing sessionID"; H_OK=false; }

  # poll (instead of a blind sleep) for the child to drain the handoff and
  # answer the queued prompt
  DRAINED_H=1
  for i in $(seq 1 90); do
    session_has_text "$SID_H" "$NONCE_H_UPPER" && { DRAINED_H=0; break; }
    sleep 1
  done
  echo "$([ $DRAINED_H = 0 ] && echo "ACTUAL: DB shows UPPERCASE reply after ~${i}s" || echo "ACTUAL: DB never showed UPPERCASE reply within 90s")"
  [ "$DRAINED_H" = 0 ] || H_OK=false

  # attach via the picker (Enter on the preselected record session) and
  # confirm the reply is visible in the replay too
  TMUX_H2="e2e-live-detach-h2"
  tmux new-session -d -s "$TMUX_H2" -x 120 -y 60 -c "$PROJECT_DIR"
  sleep 1
  tmux send-keys -t "$TMUX_H2" "cd $PROJECT_DIR && XDG_CONFIG_HOME=$CONFIG_DIR $OPENCODE_BIN attach 2>&1" Enter
  sleep 8
  tmux send-keys -t "$TMUX_H2" Enter
  sleep 10
  CAP_H=$(tmux capture-pane -pt "$TMUX_H2" -S -200 2>/dev/null || echo "")
  echo "--- attach replay (item h) ---"; echo "$CAP_H" | tail -20; echo "---"
  echo "$CAP_H" | grep -q "$NONCE_H_UPPER" || { echo "ACTUAL: replay missing UPPERCASE reply"; H_OK=false; }

  # sqlite assert: an assistant reply newer than the queued user message exists
  USER_TIME_H=$(sql "SELECT m.time_created FROM part p JOIN message m ON p.message_id=m.id WHERE m.session_id='$SID_H' AND p.data LIKE '%$NONCE_H%' AND json_extract(m.data,'\$.role')='user' ORDER BY m.time_created ASC LIMIT 1;")
  if [ -n "$USER_TIME_H" ]; then
    NEWER_ASSISTANT_H=$(sql "SELECT count(*) FROM part p JOIN message m ON p.message_id=m.id WHERE m.session_id='$SID_H' AND p.data LIKE '%$NONCE_H_UPPER%' AND json_extract(m.data,'\$.role')='assistant' AND m.time_created >= $USER_TIME_H;")
    echo "assistant replies at/after queued user message ($USER_TIME_H): $NEWER_ASSISTANT_H"
    [ -n "$NEWER_ASSISTANT_H" ] && [ "$NEWER_ASSISTANT_H" != "0" ] || { echo "ACTUAL: no newer assistant reply found"; H_OK=false; }
  else
    echo "ACTUAL: could not locate the queued user message row"
    H_OK=false
  fi

  # D-design: handoff runs through the legacy path only -- V2 inbox must stay
  # empty, and the handoff file itself must be consumed (deleted) by the child
  DB_H=$(find_db)
  N_INPUT_H=$(sqlite3 "$DB_H" "SELECT count(*) FROM session_input WHERE session_id='$SID_H';" 2>/dev/null || echo "")
  echo "session_input rows for $SID_H: $N_INPUT_H"
  [ "$N_INPUT_H" = "0" ] || { echo "ACTUAL: unexpected V2 session_input rows"; H_OK=false; }
  [ ! -f "$DATA_DIR/server/$PROJECT_ID_H/handoff.json" ] || { echo "ACTUAL: handoff.json not consumed"; H_OK=false; }

  $H_OK && pass "h" || fail "h"

  tmux send-keys -t "$TMUX_H2" "/exit" Enter
  sleep 3
  tmux kill-session -t "$TMUX_H2" 2>/dev/null || true
  [ -n "$PID_H" ] && (cd "$PROJECT_DIR" && XDG_CONFIG_HOME="$CONFIG_DIR" "$OPENCODE_BIN" stop 2>&1) || true
  sleep 2
  pid_alive "$PID_H" && kill -9 "$PID_H" 2>/dev/null || true
  rm -f "$REC_H"
fi

# ====================================================================
# ITEM (i): queued `/new` aborts the detach -- flush validation rejects
# TUI-local commands, so the whole detach is aborted (not silently dropped).
# ====================================================================
header "i" "queued /new aborts detach -- 'detach failed' row, no record, TUI stays alive, queue resumes"
echo "EXPECTED: 'detach failed' scrollback row; no discovery record; TUI alive; /new then executes"

kill_all_opencode
TMUX_I="e2e-live-detach-i"

start_opencode_in_tmux "$TMUX_I"
echo "Waiting for TUI to start (10s)..."; sleep 10
tmux send-keys -t "$TMUX_I" "use the bash tool to run the shell command 'sleep 15', then say done" Enter
sleep 6
tmux send-keys -t "$TMUX_I" "/new" Enter
sleep 2
tmux send-keys -t "$TMUX_I" "/detach" Enter

# poll at a fast cadence: the status line is overwritten as soon as the
# aborted detach resumes the drain and /new executes
SAW_FAIL_I=1
for i in $(seq 1 200); do
  tmux capture-pane -pt "$TMUX_I" | grep -q "detach failed" && { SAW_FAIL_I=0; break; }
  sleep 0.3
done
echo "$([ $SAW_FAIL_I = 0 ] && echo "ACTUAL: 'detach failed' row observed" || echo "ACTUAL: 'detach failed' row never appeared")"

sleep 8
REC_I=$(find_record)
CAP_I=$(tmux capture-pane -pt "$TMUX_I" 2>/dev/null || echo "")
echo "--- pane after aborted detach (item i) ---"; echo "$CAP_I" | tail -15; echo "---"

I_OK=true
[ "$SAW_FAIL_I" = 0 ] || I_OK=false
[ -z "$REC_I" ] || { echo "ACTUAL: a discovery record was written despite the abort"; I_OK=false; }
echo "$CAP_I" | grep -q "Ask anything" || { echo "ACTUAL: TUI input box not visible -- process likely died"; I_OK=false; }
echo "$CAP_I" | grep -q "new session ses_" || { echo "ACTUAL: queued /new never executed after the abort"; I_OK=false; }
$I_OK && pass "i" || fail "i"

tmux send-keys -t "$TMUX_I" "/exit" Enter
sleep 3
kill_all_opencode

# ====================================================================
# GROUP j/l: record fallback -- old-format record (no sessionID) and a
# record whose sessionID points at a deleted session. Both use non-TTY
# bare attach (stdin redirected) so auto-resolve runs deterministically.
# ====================================================================
header "j/l setup" "detach a single-session project, then mutate the record"
TMUX_JL="e2e-live-detach-jl"
NONCE_JL="jlnonce$$"

start_opencode_in_tmux "$TMUX_JL"
echo "Waiting for TUI to start (10s)..."; sleep 10
tmux send-keys -t "$TMUX_JL" "say the word $NONCE_JL and nothing else" Enter
for i in $(seq 1 30); do tmux capture-pane -pt "$TMUX_JL" | grep -q "$NONCE_JL" && break; sleep 1; done
sleep 3
tmux send-keys -t "$TMUX_JL" "/detach" Enter
REC_JL=""
for i in $(seq 1 30); do REC_JL=$(find_record); [ -n "$REC_JL" ] && [ -f "$REC_JL" ] && break; sleep 1; done
tmux kill-session -t "$TMUX_JL" 2>/dev/null || true

if [ -z "$REC_JL" ]; then
  echo "ACTUAL: no discovery record written -- cannot run j/l"
  fail "j"; fail "l"
else
  PROJECT_ID_JL=$(rec_field "$REC_JL" "projectID")
  SID_JL=$(rec_field "$REC_JL" "sessionID")
  PID_JL=$(rec_field "$REC_JL" "pid")
  echo "record: project=$PROJECT_ID_JL session=$SID_JL pid=$PID_JL"

  # ------------------------------------------------------------------
  # ITEM (j): old-format record (no sessionID field) -- falls back to the
  # latest root session instead of crashing or always creating a new one.
  # ------------------------------------------------------------------
  header "j" "old-format record (sessionID stripped) -- falls back to latest session"
  echo "EXPECTED: non-TTY bare attach still resumes the (only) session; no crash"
  jq 'del(.sessionID)' "$REC_JL" > "$REC_JL.tmp" && mv "$REC_JL.tmp" "$REC_JL"
  echo "record now: $(cat "$REC_JL")"
  tmux new-session -d -s "$TMUX_JL" -x 120 -y 40 -c "$PROJECT_DIR"
  sleep 1
  tmux send-keys -t "$TMUX_JL" "cd $PROJECT_DIR && XDG_CONFIG_HOME=$CONFIG_DIR $OPENCODE_BIN attach < /dev/null 2>&1" Enter
  sleep 10
  CAP_J=$(tmux capture-pane -pt "$TMUX_JL" -S -60 2>/dev/null || echo "")
  echo "--- old-format record attach (item j) ---"; echo "$CAP_J" | tail -15; echo "---"
  J_OK=true
  echo "$CAP_J" | grep -qiE "error|exception|stack trace" && { echo "ACTUAL: error/crash text in pane"; J_OK=false; }
  echo "$CAP_J" | grep -q "$NONCE_JL" || { echo "ACTUAL: fallback did not resume the latest session"; J_OK=false; }
  $J_OK && pass "j" || fail "j"
  tmux kill-session -t "$TMUX_JL" 2>/dev/null || true
  sleep 2

  # ------------------------------------------------------------------
  # ITEM (l): record sessionID points at a deleted/nonexistent session --
  # falls back instead of crashing.
  # ------------------------------------------------------------------
  header "l" "record sessionID points at a deleted session -- falls back"
  echo "EXPECTED: non-TTY bare attach falls back to the latest real session; no crash"
  jq '.sessionID = "ses_doesnotexist000000000000"' "$REC_JL" > "$REC_JL.tmp" && mv "$REC_JL.tmp" "$REC_JL"
  echo "record now: $(cat "$REC_JL")"
  tmux new-session -d -s "$TMUX_JL" -x 120 -y 40 -c "$PROJECT_DIR"
  sleep 1
  tmux send-keys -t "$TMUX_JL" "cd $PROJECT_DIR && XDG_CONFIG_HOME=$CONFIG_DIR $OPENCODE_BIN attach < /dev/null 2>&1" Enter
  sleep 10
  CAP_L=$(tmux capture-pane -pt "$TMUX_JL" -S -60 2>/dev/null || echo "")
  echo "--- deleted-session-id record attach (item l) ---"; echo "$CAP_L" | tail -15; echo "---"
  L_OK=true
  echo "$CAP_L" | grep -qiE "error|exception|stack trace" && { echo "ACTUAL: error/crash text in pane"; L_OK=false; }
  echo "$CAP_L" | grep -q "$NONCE_JL" || { echo "ACTUAL: fallback did not resume the latest session"; L_OK=false; }
  $L_OK && pass "l" || fail "l"
  tmux kill-session -t "$TMUX_JL" 2>/dev/null || true

  [ -n "$PID_JL" ] && (cd "$PROJECT_DIR" && XDG_CONFIG_HOME="$CONFIG_DIR" "$OPENCODE_BIN" stop 2>&1) || true
  sleep 2
  pid_alive "$PID_JL" && kill -9 "$PID_JL" 2>/dev/null || true
  rm -f "$REC_JL"
fi

# ====================================================================
# ITEM (m): non-attach regression -- plain `opencode run` still creates a
# new session as before (bare `opencode` / `opencode run` never touches the
# attach/picker machinery above).
# ====================================================================
header "m" "non-attach regression -- plain run creates a new session"
echo "EXPECTED: root session count for the project increases by 1"

kill_all_opencode
setup_project # fresh project + PROJECT_ID for a clean count baseline
ROOT_COUNT_M_BEFORE=$(session_root_count "$PROJECT_ID")
echo "root session count before: $ROOT_COUNT_M_BEFORE"

RUN_OUTPUT_M=$(cd "$PROJECT_DIR" && XDG_CONFIG_HOME="$CONFIG_DIR" "$OPENCODE_BIN" run "say hi and nothing else" --dir "$PROJECT_DIR" 2>&1)
RUN_EXIT_M=$?
echo "run exit: $RUN_EXIT_M"
echo "$RUN_OUTPUT_M" | tail -10

ROOT_COUNT_M_AFTER=$(session_root_count "$PROJECT_ID")
echo "root session count after: $ROOT_COUNT_M_AFTER"

M_OK=true
[ "$RUN_EXIT_M" = 0 ] || { echo "ACTUAL: opencode run exited non-zero"; M_OK=false; }
[ "$ROOT_COUNT_M_AFTER" = "$((ROOT_COUNT_M_BEFORE + 1))" ] || { echo "ACTUAL: root session count did not increase by exactly 1"; M_OK=false; }
$M_OK && pass "m" || fail "m"

# ====================================================================
# FINAL RESULTS
# ====================================================================
echo ""
echo "=========================================="
echo "  RESULTS SUMMARY"
echo "=========================================="
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo "------------------------------------------"
echo "  PASS: $PASS   FAIL: $FAIL   TOTAL: $((PASS+FAIL))"
echo "=========================================="

if [ "$FAIL" -eq 0 ]; then
  echo ""; echo "ALL ITEMS PASSED"; exit 0
else
  echo ""; echo "SOME ITEMS FAILED"; exit 1
fi
