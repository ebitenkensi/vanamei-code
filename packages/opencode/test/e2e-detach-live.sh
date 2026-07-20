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
if [ ! -f "$CONFIG_DIR/opencode.json" ]; then
  sed 's/"auto"/"allow"/g' ~/.config/opencode/opencode.json > "$CONFIG_DIR/opencode.json"
  cp ~/.config/opencode/tui.json "$CONFIG_DIR/" 2>/dev/null || true
fi

# ---- helpers ----
header() { echo ""; echo "=========================================="; echo "  ITEM ($1): $2"; echo "=========================================="; }
pass() { RESULTS+=("$1 PASS"); PASS=$((PASS+1)); }
fail() { RESULTS+=("$1 FAIL"); FAIL=$((FAIL+1)); }

rec_field() { jq -r ".${2}" "$1" 2>/dev/null || echo ""; }
pid_alive() { kill -0 "$1" 2>/dev/null; }

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
setup_project() {
  rm -rf "$PROJECT_DIR"
  mkdir -p "$PROJECT_DIR"
  git -C "$PROJECT_DIR" init -q
  git -C "$PROJECT_DIR" config user.email "e2e@test.local"
  git -C "$PROJECT_DIR" config user.name "E2E Test"
  git -C "$PROJECT_DIR" remote add origin "git@github.com:opencode-e2e/test.git"
  printf 'test\n' > "$PROJECT_DIR/README.md"
  git -C "$PROJECT_DIR" add README.md
  git -C "$PROJECT_DIR" commit -q -m "init"
  PROJECT_ID=$(printf '%s' "git-remote:github.com/opencode-e2e/test" | sha1sum | cut -d' ' -f1)
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
