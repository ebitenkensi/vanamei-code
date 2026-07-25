#!/usr/bin/env bash
# E2E test for repeatable detach/attach and the directory-independent
# attach picker.
#
# Verifies:
#   (a) bare `opencode attach`, run from a directory that belongs to NEITHER
#       detached project, lists both detached servers in a picker
#   (b) picking an entry attaches to that server and resumes its detach-time
#       session directly -- no second "Resume session" prompt
#   (c) /detach from an ATTACHED client exits the client, leaves the server
#       running, and stamps the record's sessionID (this is the cycle that
#       used to be a silent no-op)
#   (d) attaching again after that re-detach works -- detach/attach is
#       repeatable, not one-shot
#
# Usage: bash packages/opencode/test/e2e-attach-cycle.sh
# Requires: tmux, jq, git, bun
#
# Env knobs (shared with the other e2e-detach* harnesses):
#   E2E_STARTUP_TIMEOUT  poll deadline (s) for TUI/attach readiness (default 30)
#   E2E_POLL_INTERVAL    seconds between poll attempts (default 0.5)
set -u -o pipefail
shopt -s nullglob 2>/dev/null || true

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENCODE_BIN="$PKG_DIR/dist/opencode-linux-x64/bin/opencode"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
TEMP_DIR="/tmp/opencode-e2e-attach-cycle"
PROJECT_A="$TEMP_DIR/project-a"
PROJECT_B="$TEMP_DIR/project-b"
NEUTRAL_DIR="$TEMP_DIR/neutral"
CONFIG_DIR="$TEMP_DIR/config"
PASS=0; FAIL=0; RESULTS=()

E2E_STARTUP_TIMEOUT="${E2E_STARTUP_TIMEOUT:-30}"
E2E_POLL_INTERVAL="${E2E_POLL_INTERVAL:-0.5}"

mkdir -p "$TEMP_DIR" "$CONFIG_DIR/opencode"

# The global config dir is $XDG_CONFIG_HOME/opencode/. Inherit the user's
# config but replace "auto" with "allow" (schema compat). detach.enabled is
# left at its default -- this suite tests the server-first startup path.
if [ ! -f "$CONFIG_DIR/opencode/opencode.json" ]; then
  sed 's/"auto"/"allow"/g' ~/.config/opencode/opencode.json > "$CONFIG_DIR/opencode/opencode.json"
  cp ~/.config/opencode/tui.json "$CONFIG_DIR/opencode/" 2>/dev/null || true
fi
rm -f "$CONFIG_DIR/opencode/opencode.jsonc"

# Kill and remove ONLY records belonging to this suite's projects. The data
# dir is shared with real servers on this machine, so an unscoped glob would
# kill unrelated live servers.
cleanup_test_records() {
  for f in "$DATA_DIR"/server/*/server.json; do
    [ -f "$f" ] || continue
    local dir pid
    dir=$(jq -r '.directory // ""' "$f" 2>/dev/null || echo "")
    case "$dir" in
      "$PROJECT_A"|"$PROJECT_B") ;;
      *) continue ;;
    esac
    pid=$(jq -r '.pid // ""' "$f" 2>/dev/null || echo "")
    [ -n "$pid" ] && [ "$pid" != "null" ] && kill "$pid" 2>/dev/null || true
    rm -f "$f"
  done
}

cleanup() {
  local ec=$?
  echo ""
  echo "=== CLEANUP ==="
  for s in $(tmux list-sessions 2>/dev/null | grep '^e2e-attach-cycle-' | cut -d: -f1 | tr -d ' '); do
    tmux kill-session -t "$s" 2>/dev/null || true
  done
  cleanup_test_records
  rm -rf "$PROJECT_A" "$PROJECT_B" "$NEUTRAL_DIR" 2>/dev/null || true
  exit $ec
}
trap cleanup EXIT INT TERM

header() { echo ""; echo "=========================================="; echo "  ITEM ($1): $2"; echo "=========================================="; }
pass() { RESULTS+=("$1 PASS"); PASS=$((PASS+1)); }
fail() { RESULTS+=("$1 FAIL"); FAIL=$((FAIL+1)); }
pid_alive() { kill -0 "$1" 2>/dev/null; }

setup_project() {
  local dir="$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" config user.email "e2e@test.local"
  git -C "$dir" config user.name "E2E Test"
  git -C "$dir" remote add origin "git@github.com:opencode-e2e/$(basename "$dir").git"
  printf 'test\n' > "$dir/README.md"
  git -C "$dir" add README.md
  git -C "$dir" commit -q -m "init"
}

find_record_for() {
  local dir="$1"
  for f in "$DATA_DIR"/server/*/server.json; do
    [ -f "$f" ] || continue
    [ "$(jq -r '.directory // ""' "$f" 2>/dev/null)" = "$dir" ] && { echo "$f"; return 0; }
  done
  return 1
}

wait_for_record_for() {
  local dir="$1" max_wait="${2:-$E2E_STARTUP_TIMEOUT}"
  local deadline=$(( $(date +%s) + max_wait )) f
  while [ "$(date +%s)" -lt "$deadline" ]; do
    f=$(find_record_for "$dir") && { echo "$f"; return 0; }
    sleep "$E2E_POLL_INTERVAL"
  done
  return 1
}

start_in() {
  local session="$1" cwd="$2" cmd="$3"
  tmux has-session -t "$session" 2>/dev/null && tmux kill-session -t "$session"
  tmux new-session -d -s "$session" -x 120 -y 40 -c "$cwd"
  sleep 1
  tmux send-keys -t "$session" "XDG_CONFIG_HOME=$CONFIG_DIR $cmd 2>&1" Enter
}

find_oc_pid() {
  local session="$1"
  local shell_pid; shell_pid=$(tmux list-panes -t "$session" -F "#{pane_pid}" 2>/dev/null || echo "")
  [ -n "$shell_pid" ] && pgrep -P "$shell_pid" -f opencode 2>/dev/null | head -1 || echo ""
}

wait_for_oc_pid() {
  local session="$1" max_wait="${2:-$E2E_STARTUP_TIMEOUT}"
  local deadline=$(( $(date +%s) + max_wait )) pid
  while [ "$(date +%s)" -lt "$deadline" ]; do
    pid=$(find_oc_pid "$session")
    [ -n "$pid" ] && { echo "$pid"; return 0; }
    sleep "$E2E_POLL_INTERVAL"
  done
  find_oc_pid "$session"
}

wait_for_pane() {
  local session="$1" pattern="$2" max_wait="${3:-$E2E_STARTUP_TIMEOUT}"
  local deadline=$(( $(date +%s) + max_wait ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    tmux capture-pane -t "$session" -p -S -80 2>/dev/null | grep -q -- "$pattern" && return 0
    sleep "$E2E_POLL_INTERVAL"
  done
  tmux capture-pane -t "$session" -p -S -80 2>/dev/null | grep -q -- "$pattern"
}

if [ ! -x "$OPENCODE_BIN" ]; then
  echo "Missing binary: $OPENCODE_BIN"
  echo "Build it first: (cd $PKG_DIR && bun run build --single --skip-install)"
  exit 1
fi

cleanup_test_records
setup_project "$PROJECT_A"
setup_project "$PROJECT_B"
mkdir -p "$NEUTRAL_DIR"

# ====================================================================
# Setup: detach both projects so two servers are running
# ====================================================================
detach_project() {
  local name="$1" dir="$2"
  local session="e2e-attach-cycle-setup-$name"
  start_in "$session" "$dir" "$OPENCODE_BIN $dir"
  local pid; pid=$(wait_for_oc_pid "$session")
  local rec; rec=$(wait_for_record_for "$dir") || { echo "No record for $dir"; return 1; }
  [ -n "$pid" ] || { echo "No TUI pid for $dir"; return 1; }
  sleep 4
  tmux send-keys -t "$session" "/detach" Enter
  local deadline=$(( $(date +%s) + 15 ))
  while [ "$(date +%s)" -lt "$deadline" ] && pid_alive "$pid"; do sleep "$E2E_POLL_INTERVAL"; done
  pid_alive "$pid" && { echo "TUI for $dir did not exit after /detach"; return 1; }
  tmux kill-session -t "$session" 2>/dev/null || true
  echo "$rec"
}

echo "=== SETUP: detaching two projects ==="
REC_A=$(detach_project a "$PROJECT_A") || { echo "setup failed for A"; exit 1; }
REC_B=$(detach_project b "$PROJECT_B") || { echo "setup failed for B"; exit 1; }
CHILD_A=$(jq -r '.pid' "$REC_A"); CHILD_B=$(jq -r '.pid' "$REC_B")
echo "A: $REC_A (pid $CHILD_A)"
echo "B: $REC_B (pid $CHILD_B)"

# ====================================================================
# ITEM (a): the picker lists both servers from an unrelated directory
# ====================================================================
header "a" "bare attach from a neutral cwd lists both detached servers"
echo "EXPECTED: picker shows $PROJECT_A and $PROJECT_B"

TMUX_A="e2e-attach-cycle-a"
start_in "$TMUX_A" "$NEUTRAL_DIR" "$OPENCODE_BIN attach"

if wait_for_pane "$TMUX_A" "Attach to detached session" && \
   wait_for_pane "$TMUX_A" "project-a" 5 && \
   wait_for_pane "$TMUX_A" "project-b" 5; then
  echo "ACTUAL: picker listed both projects"
  pass "a"
else
  echo "ACTUAL: picker did not list both projects"
  tmux capture-pane -t "$TMUX_A" -p -S -80
  fail "a"
fi

# ====================================================================
# ITEM (b): selecting an entry attaches to that server
# ====================================================================
header "b" "selecting a picker entry attaches to that server"
echo "EXPECTED: TUI connects to project-a's server"

# The list is sorted newest-startedAt first, so project-b is the initial
# value; move to project-a explicitly instead of relying on ordering.
PICK_ROW=$(tmux capture-pane -t "$TMUX_A" -p -S -80 | grep -n "project-a" | head -1 | cut -d: -f1)
if [ -z "$PICK_ROW" ]; then
  echo "ACTUAL: project-a row not found; cannot select"
  fail "b"
else
  # Walk down until project-a is the highlighted row (clack marks it with
  # "●"), then confirm. The list is sorted newest-startedAt first, so the
  # initial value is project-b.
  for _ in 1 2 3; do
    tmux capture-pane -t "$TMUX_A" -p -S -80 | grep -E "●.*project-a" >/dev/null && break
    tmux send-keys -t "$TMUX_A" Down
    sleep 0.5
  done
  tmux send-keys -t "$TMUX_A" Enter

  ATTACH_PID=$(wait_for_oc_pid "$TMUX_A")
  # "Ask anything" is the input placeholder -- unlike "opencode", it cannot
  # match the shell command line still visible in the scrollback.
  if [ -n "$ATTACH_PID" ] && wait_for_pane "$TMUX_A" "Ask anything" "$E2E_STARTUP_TIMEOUT"; then
    # Picking the server already named its detach-time session, so the
    # startup resume picker must not appear on top of it.
    if tmux capture-pane -t "$TMUX_A" -p -S -80 | grep -q "Resume session"; then
      echo "ACTUAL: resume picker shown after the server picker"
      fail "b"
    else
      echo "ACTUAL: attached client running (pid $ATTACH_PID)"
      pass "b"
    fi
  else
    echo "ACTUAL: attach did not start"
    tmux capture-pane -t "$TMUX_A" -p -S -80
    fail "b"
  fi
fi

# ====================================================================
# ITEM (c): /detach from an attached client works
# ====================================================================
header "c" "/detach from an attached client exits the client, server survives"
echo "EXPECTED: client exits, 'Detached' summary printed, server pid still alive"

sleep 4
ATTACH_PID="${ATTACH_PID:-$(find_oc_pid "$TMUX_A")}"
tmux send-keys -t "$TMUX_A" "/detach" Enter

deadline_c=$(( $(date +%s) + 20 ))
while [ "$(date +%s)" -lt "$deadline_c" ] && [ -n "$ATTACH_PID" ] && pid_alive "$ATTACH_PID"; do
  sleep "$E2E_POLL_INTERVAL"
done

if [ -n "$ATTACH_PID" ] && pid_alive "$ATTACH_PID"; then
  echo "ACTUAL: attached client still alive after /detach (the old no-op bug)"
  kill "$ATTACH_PID" 2>/dev/null || true
  tmux capture-pane -t "$TMUX_A" -p -S -80
  fail "c"
elif ! pid_alive "$CHILD_A" && ! pid_alive "$CHILD_B"; then
  echo "ACTUAL: /detach killed the server instead of leaving it running"
  fail "c"
else
  SESSION_ID=""
  for rec in "$REC_A" "$REC_B"; do
    [ -f "$rec" ] || continue
    sid=$(jq -r '.sessionID // ""' "$rec" 2>/dev/null || echo "")
    [ -n "$sid" ] && [ "$sid" != "null" ] && SESSION_ID="$sid"
  done
  if [ -z "$SESSION_ID" ]; then
    echo "ACTUAL: no record carries a sessionID after re-detach"
    fail "c"
  elif ! wait_for_pane "$TMUX_A" "Detached" 5; then
    echo "ACTUAL: client exited without printing the detach summary"
    tmux capture-pane -t "$TMUX_A" -p -S -80
    fail "c"
  else
    echo "ACTUAL: client exited, server alive, record sessionID=$SESSION_ID"
    pass "c"
  fi
fi
tmux kill-session -t "$TMUX_A" 2>/dev/null || true

# ====================================================================
# ITEM (d): attaching again after the re-detach works
# ====================================================================
header "d" "attach again after a re-detach (cycle is repeatable)"
echo "EXPECTED: a second bare attach reaches a running TUI"

TMUX_D="e2e-attach-cycle-d"
start_in "$TMUX_D" "$NEUTRAL_DIR" "$OPENCODE_BIN attach"
if wait_for_pane "$TMUX_D" "Attach to detached session"; then
  # The data dir is shared with any other server on this machine, so walk to
  # project-a's row rather than trusting the initial (newest) value.
  for _ in 1 2 3 4 5; do
    tmux capture-pane -t "$TMUX_D" -p -S -80 | grep -E "●.*project-a" >/dev/null && break
    tmux send-keys -t "$TMUX_D" Down
    sleep 0.5
  done
  tmux send-keys -t "$TMUX_D" Enter
fi
D_PID=$(wait_for_oc_pid "$TMUX_D")
if [ -n "$D_PID" ] && wait_for_pane "$TMUX_D" "Ask anything" "$E2E_STARTUP_TIMEOUT"; then
  echo "ACTUAL: second attach connected (pid $D_PID)"
  pass "d"
else
  echo "ACTUAL: second attach failed"
  tmux capture-pane -t "$TMUX_D" -p -S -80
  fail "d"
fi
tmux kill-session -t "$TMUX_D" 2>/dev/null || true

echo ""
echo "=========================================="
echo "  RESULTS"
echo "=========================================="
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo "  PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
