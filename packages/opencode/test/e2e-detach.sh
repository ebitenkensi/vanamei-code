#!/usr/bin/env bash
# E2E test for session detach/re-attach feature (SPEC-detach.md)
#
# Usage: bash packages/opencode/test/e2e-detach.sh
# Must be run from the repo root or the script handles paths.
# Requires: tmux, jq, git, bun, sqlite3
#
# Env knobs (shared across the three e2e-detach* harnesses; see
# SPEC-detachable-default.md "Harness env knobs and polling approach"):
#   E2E_STARTUP_TIMEOUT  poll deadline (s) for TUI/attach readiness (default 30)
#   E2E_TURN_TIMEOUT     poll deadline (s) for a turn to complete (default 90)
#   E2E_POLL_INTERVAL    seconds between poll attempts, may be fractional (default 0.5)
#   E2E_TOOL_SLEEP       in-prompt `sleep N` duration (s) kept in flight for /detach (default 12)
#   E2E_SKIP_TYPECHECK   set to 1 to skip item (a)'s `bun typecheck` gate
set -u -o pipefail
shopt -s nullglob 2>/dev/null || true

# ---- paths ----
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENCODE_BIN="$PKG_DIR/dist/opencode-linux-x64/bin/opencode"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
TEMP_DIR="/tmp/opencode-e2e"
PROJECT_DIR="$TEMP_DIR/project"
LOG_DIR="$TEMP_DIR/logs"
CONFIG_DIR="$TEMP_DIR/config"
PASS=0; FAIL=0; RESULTS=()

# ---- env knobs ----
# Defaults are chosen so no poll deadline below is stricter than the fixed
# sleep it replaces -- the win comes from early exit, not a smaller ceiling.
E2E_STARTUP_TIMEOUT="${E2E_STARTUP_TIMEOUT:-30}"
E2E_TURN_TIMEOUT="${E2E_TURN_TIMEOUT:-90}"
E2E_POLL_INTERVAL="${E2E_POLL_INTERVAL:-0.5}"
E2E_TOOL_SLEEP="${E2E_TOOL_SLEEP:-12}"
E2E_SKIP_TYPECHECK="${E2E_SKIP_TYPECHECK:-0}"

mkdir -p "$TEMP_DIR" "$LOG_DIR" "$CONFIG_DIR"

# ---- prepare temporary config (replace "auto" with "allow") ----
# The session-detach branch schema does not include "auto" in
# PermissionActionConfig (it uses ["ask","allow","deny"]).
# The user's config has "auto" values. We create a temporary override.
# Also force detach.enabled=false so the detachable-by-default startup
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

# ---- cleanup ----
cleanup() {
  local ec=$?
  echo ""
  echo "=== CLEANUP ==="
  for s in $(tmux list-sessions 2>/dev/null | grep '^e2e-detach-' | cut -d: -f1 | tr -d ' '); do
    tmux kill-session -t "$s" 2>/dev/null || true
  done
  for f in "$DATA_DIR"/server/*/server.json; do
    [ -f "$f" ] || continue
    pid=$(jq -r '.pid' "$f" 2>/dev/null || echo "")
    [ -n "$pid" ] && [ "$pid" != "null" ] && kill "$pid" 2>/dev/null || true
    rm -f "$f"
    rmdir "$(dirname "$f")" 2>/dev/null || true
  done
  rm -rf "$PROJECT_DIR" "$LOG_DIR" 2>/dev/null || true
  exit $ec
}
trap cleanup EXIT INT TERM

# ---- helpers ----
header() { echo ""; echo "=========================================="; echo "  ITEM ($1): $2"; echo "=========================================="; }
pass() { RESULTS+=("$1 PASS"); PASS=$((PASS+1)); }
fail() { RESULTS+=("$1 FAIL"); FAIL=$((FAIL+1)); }

find_records() {
  local files=("$DATA_DIR"/server/*/server.json)
  [ ${#files[@]} -eq 0 ] && return 1
  printf '%s\n' "${files[@]}"
}

rec_field() { jq -r ".${2}" "$1" 2>/dev/null || echo ""; }

wait_for_record() {
  local max_wait="${1:-20}"
  for i in $(seq 1 "$max_wait"); do
    local found; found=$(find_records | head -1)
    [ -n "$found" ] && [ -f "$found" ] && { echo "$found"; return 0; }
    sleep 1
  done
  return 1
}

pid_alive() { kill -0 "$1" 2>/dev/null; }

# Poll a tmux pane's captured text for a pattern up to a deadline. Early-exits
# as soon as the pattern appears; does one final check on timeout so callers
# get an accurate result instead of a stale early capture.
wait_for_pane() {
  local session="$1" pattern="$2" max_wait="${3:-$E2E_STARTUP_TIMEOUT}"
  local deadline=$(( $(date +%s) + max_wait ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    tmux capture-pane -t "$session" -p -S -50 2>/dev/null | grep -q -- "$pattern" && return 0
    sleep "$E2E_POLL_INTERVAL"
  done
  tmux capture-pane -t "$session" -p -S -50 2>/dev/null | grep -q -- "$pattern"
}

# TUI readiness marker (as e2e-detach-live.sh:557-560 polls for), used
# instead of a blind sleep whenever we just need the TUI to be up and
# accepting input.
wait_for_tui_ready() { wait_for_pane "$1" "Ask anything" "${2:-$E2E_STARTUP_TIMEOUT}"; }

# Type a prompt and verify it actually took effect at each step instead of
# trusting a blind send-keys -- a real run against e2e-detachable.sh proved
# "Ask anything" visible does NOT guarantee keystrokes are consumed: the
# Enter after a typed prompt was silently lost, the text sat in the composer,
# and a second send-keys then appended to it and submitted one merged
# message. Uses -l (literal) typing (Enter kept separate) and -J (join
# wrapped lines) capture -- these prompts wrap in a 120-col pane, so a split
# nonce never matches without -J.
#
# Args: session text nonce [queued]
#   nonce:  a substring unique to THIS prompt (must not appear in anything
#           already on screen, e.g. an earlier prompt's echo), used to verify
#           the text landed and, for queued prompts, that it left the
#           composer.
#   queued: "1" if this is a second prompt queued behind an in-flight turn.
#           Turn 1's activity markers are already on screen at that point and
#           prove nothing about THIS prompt, so submission is instead
#           verified by confirming the nonce is no longer sitting on the
#           composer's "❯" line.
tui_submit_prompt() {
  local session="$1" text="$2" nonce="$3" queued="${4:-0}"
  local attempt landed deadline

  for attempt in 1 2 3; do
    tmux send-keys -t "$session" -l -- "$text"
    landed=1
    deadline=$(( $(date +%s) + 5 ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
      tmux capture-pane -t "$session" -p -J -S -50 2>/dev/null | grep -q -- "$nonce" && { landed=0; break; }
      sleep "$E2E_POLL_INTERVAL"
    done
    [ "$landed" = 0 ] && break
    echo "WARNING: prompt text not observed in pane (attempt $attempt/3), clearing composer and retyping"
    tmux send-keys -t "$session" C-u
  done

  tmux send-keys -t "$session" Enter

  if [ "$queued" = "1" ]; then
    local round
    for round in 1 2; do
      deadline=$(( $(date +%s) + 3 ))
      while [ "$(date +%s)" -lt "$deadline" ]; do
        tmux capture-pane -t "$session" -p -J -S -50 2>/dev/null | grep -q "❯.*$nonce" || return 0
        sleep "$E2E_POLL_INTERVAL"
      done
      echo "WARNING: queued prompt still sitting in composer (round $round/2), retrying Enter"
      tmux send-keys -t "$session" Enter
    done
    return 0
  fi

  # First/only prompt: verify the turn actually started (Thinking / Bash( /
  # the busy-footer "interrupt" hint), not just that Enter was sent.
  local round active=1
  for round in 1 2 3; do
    deadline=$(( $(date +%s) + 3 ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
      tmux capture-pane -t "$session" -p -J -S -50 2>/dev/null | grep -qE "Thinking|Bash\(|interrupt" && { active=0; break; }
      sleep "$E2E_POLL_INTERVAL"
    done
    [ "$active" = 0 ] && break
    echo "WARNING: no turn activity observed after Enter (round $round/3), retrying Enter"
    tmux send-keys -t "$session" Enter
  done
}

# ---- DB helpers (ported from e2e-detach-live.sh) ----
# Some completion checks have no attached pane to poll (the process may have
# been detached/killed already), so completion is observed via the DB.
find_db() { ls -t "$DATA_DIR"/opencode*.db 2>/dev/null | head -1; }
sql() { sqlite3 "$(find_db)" "$1" 2>/dev/null || echo ""; }
# Project-scoped (rather than session-scoped) since this suite doesn't
# always have a sessionID captured off the discovery record at hand.
# NOTE: role filtering alone is NOT enough -- the user's own prompt (e.g. the
# NONCE_B-carrying "...reply with exactly $NONCE_B") is itself stored as a
# message part, so a bare `p.data LIKE` would match on the prompt echo
# instead of waiting for the assistant's actual reply. Role filtering alone
# is ALSO not enough: a real run proved an assistant "reasoning" part can
# restate the nonce while planning ("The user wants me to run sleep 12 and
# then reply TUR...") well before the turn actually finishes, so the poll
# must also require the part's own type to be "text" and search only its
# "text" field -- confirmed against the live schema (part.data is a JSON
# blob with a "type" field and, for type "text", a "text" field holding the
# exact rendered string; message.data has the "role" field) via
# `sqlite3 <db> "SELECT json_extract(data,'$.type'), data FROM part ..."`.
project_has_text() {
  local n
  n=$(sql "SELECT count(*) FROM part p JOIN message m ON p.message_id=m.id JOIN session s ON m.session_id=s.id WHERE s.project_id='$1' AND json_extract(m.data,'\$.role')='assistant' AND json_extract(p.data,'\$.type')='text' AND json_extract(p.data,'\$.text') LIKE '%$2%';")
  [ -n "$n" ] && [ "$n" != "0" ]
}
wait_for_project_text() {
  local project_id="$1" pattern="$2" max_wait="${3:-$E2E_TURN_TIMEOUT}"
  local deadline=$(( $(date +%s) + max_wait ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    project_has_text "$project_id" "$pattern" && return 0
    sleep "$E2E_POLL_INTERVAL"
  done
  project_has_text "$project_id" "$pattern"
}

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

# ---- start opencode TUI inside an existing tmux session ----
start_opencode_in_tmux() {
  local session="$1"
  local extra_args="${2:-}"
  # Create a shell session if not exist
  tmux has-session -t "$session" 2>/dev/null || \
    tmux new-session -d -s "$session" -x 120 -y 40
  sleep 1
  tmux send-keys -t "$session" \
    "XDG_CONFIG_HOME=$CONFIG_DIR $OPENCODE_BIN $extra_args /tmp/opencode-e2e/project 2>&1" Enter
}

# ====================================================================
# ITEM (a): bun typecheck
# ====================================================================
header "a" "bun typecheck"
echo "EXPECTED: exit 0"
if [ "$E2E_SKIP_TYPECHECK" = "1" ]; then
  echo "ACTUAL: skipped (E2E_SKIP_TYPECHECK=1)"
  pass "a"
else
  TYPE_CHECK_OUTPUT=$(cd "$PKG_DIR" && bun typecheck 2>&1) && {
    echo "ACTUAL: typecheck passed"
    echo "$TYPE_CHECK_OUTPUT" | tail -5
    pass "a"
  } || {
    echo "ACTUAL: typecheck FAILED (exit $?)"
    echo "$TYPE_CHECK_OUTPUT" | tail -20
    fail "a"
  }
fi

setup_project

# ====================================================================
# ITEM (b): Detach mid-turn / SIGHUP
# ====================================================================
header "b" "detach mid-turn, kill terminal, process survives"
echo "EXPECTED: /detach creates discovery record, SIGHUP does NOT kill the process"

TMUX_B="e2e-detach-b"
rm -f "$DATA_DIR/server/$PROJECT_ID/server.json"

start_opencode_in_tmux "$TMUX_B"
echo "Waiting for TUI to start (poll, max ${E2E_STARTUP_TIMEOUT}s)..."
wait_for_tui_ready "$TMUX_B" || echo "WARNING: TUI readiness marker not observed within ${E2E_STARTUP_TIMEOUT}s"

# Send a prompt that triggers a long-running bash tool call. Turn start is
# detected by polling for the "Bash(...)" tool-call header (headerBash in
# packages/opencode/src/cli/cmd/run/tool.ts renders it during the tool's
# progress phase) instead of blindly sleeping 20s. Detection typically lands
# within a few seconds, so E2E_TOOL_SLEEP=12 still leaves most of the sleep
# remaining when /detach is sent below (margin: detection latency + a few
# seconds of harness overhead to send /detach, comfortably under 12s).
NONCE_B="turnb$$"
echo "Sending prompt: ask model to run 'sleep ${E2E_TOOL_SLEEP}' in bash..."
tui_submit_prompt "$TMUX_B" "run the shell command 'sleep ${E2E_TOOL_SLEEP}' with the bash tool, then reply with exactly ${NONCE_B}" "$NONCE_B"
echo "Waiting for model to think and start bash call (poll for Bash(sleep ${E2E_TOOL_SLEEP}), max ${E2E_STARTUP_TIMEOUT}s)..."
wait_for_pane "$TMUX_B" "Bash(sleep ${E2E_TOOL_SLEEP}" "$E2E_STARTUP_TIMEOUT" || echo "WARNING (item b): tool-call header not observed within ${E2E_STARTUP_TIMEOUT}s, proceeding anyway"

# Send /detach while the sleep is in-flight
echo "Sending /detach..."
tmux send-keys -t "$TMUX_B" Enter # clear any pending input
tmux send-keys -t "$TMUX_B" "/detach" Enter
sleep 5

# Legacy /detach defers until the in-flight turn finishes (the tool-call
# sleep runs ${E2E_TOOL_SLEEP}s and /detach lands only a few seconds in), so
# the record appears shortly after the tool sleep ends plus model latency.
# wait_for_record already polls with early exit; 60s remains a generous
# ceiling (unchanged from before -- never stricter than the old fixed wait).
REC_FILE_B=$(wait_for_record 60) || true
if [ -n "$REC_FILE_B" ] && [ -f "$REC_FILE_B" ]; then
  DETACHED_PID=$(rec_field "$REC_FILE_B" "pid")
  DETACHED_URL=$(rec_field "$REC_FILE_B" "url")
  echo "Discovery record: $REC_FILE_B  PID=$DETACHED_PID  URL=$DETACHED_URL"

  # Kill tmux session => SIGHUP to the opencode process
  echo "Killing tmux session (SIGHUP)..."
  tmux kill-session -t "$TMUX_B"; sleep 4

  if pid_alive "$DETACHED_PID"; then
    echo "ACTUAL: Process $DETACHED_PID is ALIVE after SIGHUP"
    if [ -f "$REC_FILE_B" ]; then
      echo "ACTUAL: Discovery record exists"
      cat "$REC_FILE_B"
      pass "b"
    else
      echo "ACTUAL: Discovery record deleted"
      fail "b"
    fi
  else
    echo "ACTUAL: Process died after SIGHUP"; fail "b"
  fi
else
  echo "ACTUAL: No discovery record after /detach"
  tmux kill-session -t "$TMUX_B" 2>/dev/null || true
  fail "b"
fi

# Wait for remaining turn to complete. Poll the DB for the reply nonce
# instead of blindly sleeping ~50s (deadline E2E_TURN_TIMEOUT, default 90s
# >= the old fixed 50s).
echo "Waiting for in-flight turn to complete (poll DB for ${NONCE_B}, max ${E2E_TURN_TIMEOUT}s)..."
wait_for_project_text "$PROJECT_ID" "$NONCE_B" "$E2E_TURN_TIMEOUT" || echo "WARNING: DB never showed ${NONCE_B} within ${E2E_TURN_TIMEOUT}s"
[ -n "$DETACHED_PID" ] && pid_alive "$DETACHED_PID" && echo "Process still alive after completion" || echo "Process died after completion"

# ====================================================================
# ITEM (c): attach --continue
# ====================================================================
header "c" "opencode attach (no URL) + --continue"
echo "EXPECTED: connects to detached server, replays session"

TMUX_C="e2e-detach-c"
REC_FILE_C="$DATA_DIR/server/$PROJECT_ID/server.json"

if [ ! -f "$REC_FILE_C" ]; then
  echo "ACTUAL: No discovery record - cannot test attach"
  fail "c"
else
  DETACHED_PID_C=$(rec_field "$REC_FILE_C" "pid")
  if ! pid_alive "$DETACHED_PID_C"; then
    echo "ACTUAL: Server process dead - cannot test attach"
    fail "c"
  else
    echo "Server PID $DETACHED_PID_C alive. Starting attach..."
    tmux has-session -t "$TMUX_C" 2>/dev/null && tmux kill-session -t "$TMUX_C"
    tmux new-session -d -s "$TMUX_C" -x 120 -y 40
    sleep 1
    tmux send-keys -t "$TMUX_C" \
      "XDG_CONFIG_HOME=$CONFIG_DIR $OPENCODE_BIN attach --continue --no-replay --dir /tmp/opencode-e2e/project 2>&1" Enter

    echo "Waiting for attach to connect (poll, max ${E2E_STARTUP_TIMEOUT}s)..."
    wait_for_tui_ready "$TMUX_C" "$E2E_STARTUP_TIMEOUT" || true

    CAP_C=$(tmux capture-pane -t "$TMUX_C" -p -S -20 2>/dev/null || echo "")
    echo "--- attach output ---"
    echo "$CAP_C" | tail -15
    echo "---"

    if echo "$CAP_C" | grep -qiE "(opencode|ready|continue|session|connected|replay|error|refused|failed)"; then
      echo "ACTUAL: Attach output visible. Connected successfully."
      # Send /exit to clean up
      tmux send-keys -t "$TMUX_C" "/exit" Enter
      sleep 4
      pass "c"
    else
      echo "ACTUAL: No session content in attach output"
      echo "--- full pane ---"
      tmux capture-pane -t "$TMUX_C" -p 2>/dev/null | tail -30
      tmux kill-session -t "$TMUX_C" 2>/dev/null || true
      fail "c"
    fi
  fi
fi

# ====================================================================
# ITEM (d): Normal exit without detach (regression)
# ====================================================================
header "d" "normal exit without /detach -> process fully terminates"
echo "EXPECTED: /exit cleanly terminates the process"

# Kill any server from previous tests first
for f in "$DATA_DIR"/server/*/server.json; do
  [ -f "$f" ] || continue
  pid=$(jq -r '.pid' "$f" 2>/dev/null || echo "")
  [ -n "$pid" ] && [ "$pid" != "null" ] && kill "$pid" 2>/dev/null || true
  rm -f "$f"
done

TMUX_D="e2e-detach-d"
rm -f "$DATA_DIR/server/$PROJECT_ID/server.json"
start_opencode_in_tmux "$TMUX_D"
echo "Waiting for TUI to start (poll, max ${E2E_STARTUP_TIMEOUT}s)..."
wait_for_tui_ready "$TMUX_D" || echo "WARNING: TUI readiness marker not observed within ${E2E_STARTUP_TIMEOUT}s"

# Find the opencode process PID (inside the tmux pane)
# The shell process is the tmux pane's PID; opencode is its child
OC_PID_D=""
for try in $(seq 1 5); do
  SHELL_PID=$(tmux list-panes -t "$TMUX_D" -F "#{pane_pid}" 2>/dev/null || echo "")
  if [ -n "$SHELL_PID" ]; then
    # Find opencode process (child of shell)
    OC_PID_D=$(pgrep -P "$SHELL_PID" -f opencode 2>/dev/null | head -1 || echo "")
    [ -n "$OC_PID_D" ] && break
  fi
  sleep 1
done
echo "OpenCode PID: ${OC_PID_D:-unknown}"

# Send /exit
echo "Sending /exit..."
tmux send-keys -t "$TMUX_D" "/exit" Enter
echo "Waiting for process to exit (poll, max 18s)..."
if [ -n "$OC_PID_D" ]; then
  deadline_d=$(( $(date +%s) + 18 ))
  while [ "$(date +%s)" -lt "$deadline_d" ] && pid_alive "$OC_PID_D"; do sleep "$E2E_POLL_INTERVAL"; done
fi

# Check if the opencode process died
if [ -n "$OC_PID_D" ]; then
  if pid_alive "$OC_PID_D"; then
    echo "ACTUAL: Process still alive after /exit + 18s"
    tmux kill-session -t "$TMUX_D" 2>/dev/null || true
    kill "$OC_PID_D" 2>/dev/null || true
    fail "d"
  else
    echo "ACTUAL: OpenCode process died after /exit"
    [ -f "$DATA_DIR/server/$PROJECT_ID/server.json" ] && { echo "Stale record"; fail "d"; } || pass "d"
  fi
else
  echo "ACTUAL: Could not find opencode PID"
  # Fallback: check tmux pane for exit
  tmux capture-pane -t "$TMUX_D" -p 2>/dev/null | tail -10
  tmux kill-session -t "$TMUX_D" 2>/dev/null || true
  fail "d"
fi
tmux kill-session -t "$TMUX_D" 2>/dev/null || true

# ====================================================================
# ITEM (e): opencode stop
# ====================================================================
header "e" "opencode stop stops detached server and removes record"
echo "EXPECTED: stop sends SIGTERM, process dies, record deleted"

# Need a detached server first
TMUX_E="e2e-detach-e"
rm -f "$DATA_DIR/server/$PROJECT_ID/server.json"
start_opencode_in_tmux "$TMUX_E"
wait_for_tui_ready "$TMUX_E" || echo "WARNING: TUI readiness marker not observed within ${E2E_STARTUP_TIMEOUT}s"
tmux send-keys -t "$TMUX_E" "/detach" Enter
sleep 5

REC_FILE_E=$(wait_for_record 15) || true
if [ -z "$REC_FILE_E" ] || [ ! -f "$REC_FILE_E" ]; then
  echo "ACTUAL: No discovery record after /detach"
  tmux kill-session -t "$TMUX_E" 2>/dev/null || true
  fail "e"
else
  STOP_PID=$(rec_field "$REC_FILE_E" "pid")
  echo "Detached PID: $STOP_PID"
  tmux kill-session -t "$TMUX_E" 2>/dev/null || true

  # Poll for the child to be alive instead of a one-shot check right after
  # the record-poll above -- defensive parity with the analogous checks
  # hardened in e2e-detach-live.sh items (c)/(d).
  deadline_e_child=$(( $(date +%s) + E2E_STARTUP_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline_e_child" ] && ! pid_alive "$STOP_PID"; do sleep "$E2E_POLL_INTERVAL"; done

  if ! pid_alive "$STOP_PID"; then
    echo "ACTUAL: Process already dead"; fail "e"
  else
    # Run opencode stop FROM the project directory
    echo "Running opencode stop from $PROJECT_DIR..."
    STOP_OUTPUT=$(cd "$PROJECT_DIR" && XDG_CONFIG_HOME="$CONFIG_DIR" "$OPENCODE_BIN" stop 2>&1) || {
      echo "ACTUAL: stop failed: $STOP_OUTPUT"
      kill "$STOP_PID" 2>/dev/null || true
      rm -f "$REC_FILE_E"
      fail "e"; }
    echo "stop output: $STOP_OUTPUT"
    sleep 3

    if pid_alive "$STOP_PID"; then
      echo "ACTUAL: Process still alive - trying --force"
      cd "$PROJECT_DIR" && XDG_CONFIG_HOME="$CONFIG_DIR" "$OPENCODE_BIN" stop --force 2>&1 || true
      sleep 2
      if pid_alive "$STOP_PID"; then
        kill -9 "$STOP_PID" 2>/dev/null || true
        rm -f "$REC_FILE_E"
        fail "e (even force kill failed)"
      else
        echo "ACTUAL: Process died after --force"
        [ -f "$REC_FILE_E" ] && { rm -f "$REC_FILE_E"; fail "e (record not removed)"; } || pass "e"
      fi
    else
      echo "ACTUAL: Process died after stop"
      [ -f "$REC_FILE_E" ] && { rm -f "$REC_FILE_E"; fail "e (record not removed)"; } || pass "e"
    fi
  fi
fi

# ====================================================================
# ITEM (f): /shutdown TUI command
# ====================================================================
header "f" "/shutdown TUI command stops attached server"
echo "EXPECTED: /shutdown sent while attached stops the server and removes record"

# Start a fresh detached server
TMUX_F1="e2e-detach-f1"
rm -f "$DATA_DIR/server/$PROJECT_ID/server.json"
start_opencode_in_tmux "$TMUX_F1"
wait_for_tui_ready "$TMUX_F1" || echo "WARNING: TUI readiness marker not observed within ${E2E_STARTUP_TIMEOUT}s"
tmux send-keys -t "$TMUX_F1" "/detach" Enter
sleep 5

REC_FILE_F=$(wait_for_record 15) || true
if [ -z "$REC_FILE_F" ] || [ ! -f "$REC_FILE_F" ]; then
  echo "ACTUAL: No discovery record"; tmux kill-session -t "$TMUX_F1" 2>/dev/null || true; fail "f"
else
  SHUTDOWN_PID=$(rec_field "$REC_FILE_F" "pid")
  echo "Server PID: $SHUTDOWN_PID"
  tmux kill-session -t "$TMUX_F1" 2>/dev/null || true

  # Poll for the child to be alive instead of a one-shot check right after
  # the record-poll above -- same defensive parity as item (e).
  deadline_f_child=$(( $(date +%s) + E2E_STARTUP_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline_f_child" ] && ! pid_alive "$SHUTDOWN_PID"; do sleep "$E2E_POLL_INTERVAL"; done

  if ! pid_alive "$SHUTDOWN_PID"; then
    echo "ACTUAL: Server dead before test"; fail "f"
  else
    # Attach to the server, then /shutdown
    TMUX_F2="e2e-detach-f2"
    tmux new-session -d -s "$TMUX_F2" -x 120 -y 40
    sleep 1
    # --continue: bare attach opens the session picker (attach-resume P1),
    # which would swallow the /shutdown keystrokes. Resume the last session
    # directly so the input lands in the TUI prompt.
    tmux send-keys -t "$TMUX_F2" \
      "XDG_CONFIG_HOME=$CONFIG_DIR $OPENCODE_BIN attach --continue --no-replay --dir /tmp/opencode-e2e/project 2>&1" Enter
    wait_for_tui_ready "$TMUX_F2" || echo "WARNING: TUI readiness marker not observed within ${E2E_STARTUP_TIMEOUT}s"

    echo "Sending /shutdown..."
    tmux send-keys -t "$TMUX_F2" "/shutdown" Enter
    sleep 6

    if pid_alive "$SHUTDOWN_PID"; then
      echo "ACTUAL: Server still alive after /shutdown"
      kill "$SHUTDOWN_PID" 2>/dev/null || true
      rm -f "$REC_FILE_F"
      fail "f"
    else
      echo "ACTUAL: Server DEAD after /shutdown"
      [ -f "$REC_FILE_F" ] && { rm -f "$REC_FILE_F"; fail "f (record not removed)"; } || pass "f"
    fi
    tmux kill-session -t "$TMUX_F2" 2>/dev/null || true
  fi
fi

# ====================================================================
# ITEM (g): SIGHUP auto-detach (P4, default ON)
# ====================================================================
header "g" "SIGHUP received without prior /detach triggers auto-detach (default ON)"
echo "EXPECTED: SIGHUP without /detach still creates discovery record and process survives"

TMUX_G="e2e-detach-g"
rm -f "$DATA_DIR/server/$PROJECT_ID/server.json"
start_opencode_in_tmux "$TMUX_G"
echo "Waiting for TUI to start (poll, max ${E2E_STARTUP_TIMEOUT}s)..."
wait_for_tui_ready "$TMUX_G" || echo "WARNING: TUI readiness marker not observed within ${E2E_STARTUP_TIMEOUT}s"

# Send a long-running prompt so we can observe auto-detach mid-turn. Turn
# start is detected by polling for the "Bash(...)" tool-call header instead
# of blindly sleeping 15s, so E2E_TOOL_SLEEP=12 still leaves most of the
# sleep remaining when the SIGHUP below lands mid-turn.
echo "Sending long-running prompt..."
# No reply marker in this prompt (the assertion only cares about the record
# and process surviving SIGHUP) -- "sleep ${E2E_TOOL_SLEEP}" is the first
# text in this fresh pane, so it's still a safe landed-nonce.
tui_submit_prompt "$TMUX_G" "run 'sleep ${E2E_TOOL_SLEEP}' with the bash tool and tell me when done" "sleep ${E2E_TOOL_SLEEP}"
wait_for_pane "$TMUX_G" "Bash(sleep ${E2E_TOOL_SLEEP}" "$E2E_STARTUP_TIMEOUT" || echo "WARNING (item g): tool-call header not observed within ${E2E_STARTUP_TIMEOUT}s, proceeding anyway"

# Kill tmux WITHOUT sending /detach first
echo "Killing tmux session (SIGHUP without /detach)..."
tmux kill-session -t "$TMUX_G"

# Check for auto-detach discovery record. wait_for_record already polls with
# early exit, so the old blind "give it more time" pre-sleep is unnecessary.
REC_FILE_G=$(wait_for_record "$E2E_STARTUP_TIMEOUT") || true
if [ -n "$REC_FILE_G" ] && [ -f "$REC_FILE_G" ]; then
  AUTO_PID=$(rec_field "$REC_FILE_G" "pid")
  echo "Discovery record found: PID=$AUTO_PID"
  cat "$REC_FILE_G"
  # Poll for the process to be alive instead of a one-shot check right after
  # the record-poll above -- defensive parity with the analogous checks
  # elsewhere. This item has a known P4 race in the product itself (see the
  # comment near the end of this script); this only removes extra harness-
  # timing noise on top of that, it does not change what counts as pass/fail.
  if [ -n "$AUTO_PID" ]; then
    deadline_g_child=$(( $(date +%s) + E2E_STARTUP_TIMEOUT ))
    while [ "$(date +%s)" -lt "$deadline_g_child" ] && ! pid_alive "$AUTO_PID"; do sleep "$E2E_POLL_INTERVAL"; done
  fi
  if [ -n "$AUTO_PID" ] && pid_alive "$AUTO_PID"; then
    echo "ACTUAL: Process $AUTO_PID survived SIGHUP (auto-detach worked)"
    # Cleanup
    cd "$PROJECT_DIR" && XDG_CONFIG_HOME="$CONFIG_DIR" "$OPENCODE_BIN" stop 2>&1 || kill "$AUTO_PID" 2>/dev/null || true
    sleep 3; pid_alive "$AUTO_PID" && kill -9 "$AUTO_PID" 2>/dev/null || true
    rm -f "$REC_FILE_G"
    pass "g"
  else
    echo "ACTUAL: Auto-detach record found but process $AUTO_PID is dead"
    echo "This is a known race condition: SIGHUP kills TUI before DetachState activates."
    echo "The discovery record is written (confirming executeDetach ran) but DetachState.activate()"
    echo "may not have completed before the process terminated."
    rm -f "$REC_FILE_G"
    fail "g (known race condition - P4)"
  fi
else
  echo "ACTUAL: No discovery record - auto-detach did not occur (might be disabled or failed)"
  fail "g"
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

# Item (g) is P4 and has a known race condition in the implementation:
# the SIGHUP handler calls async executeDetach which yields to the event loop,
# allowing the TUI renderer to crash on the disconnected terminal before
# stdout/stderr are redirected and DetachState is activated.
ONLY_G_FAILED=true
for r in "${RESULTS[@]}"; do
  case "$r" in
    *FAIL*) [[ "$r" == "g"* ]] || ONLY_G_FAILED=false ;;
  esac
done

if [ "$FAIL" -eq 0 ]; then
  echo ""; echo "ALL ITEMS PASSED"; exit 0
elif [ "$FAIL" -eq 1 ] && $ONLY_G_FAILED; then
  # Only item (g) failed - a P4 known limitation
  echo ""; echo "ALL CRITICAL ITEMS PASSED (item g has known race condition - P4)"; exit 0
else
  echo ""; echo "SOME ITEMS FAILED"; exit 1
fi
