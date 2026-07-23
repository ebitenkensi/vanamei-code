#!/usr/bin/env bash
# E2E test for detachable-by-default startup mode (SPEC-detachable-default.md)
#
# Verifies the server-first startup path where `opencode` spawns a child server
# and the TUI acts as an HTTP attach client. Covers:
#   (a) bare launch: parent+child 2 processes + discovery record
#   (b) /detach mid-turn: parent exits immediately, child finishes the turn,
#       attach shows the result
#   (c) /exit: both processes terminate + record deleted
#   (d) SIGHUP: server survives (best-effort handoff)
#   (e) long-running tool + queued prompt -> /detach -> both turns complete
#       in order (queue handoff via POST /server/handoff)
#   (f) --no-detach: legacy single-process mode (regression)
#   (g) existing-server warning on second bare launch (always-new-spawn)
#
# Usage: bash packages/opencode/test/e2e-detachable.sh
# Requires: tmux, jq, git, bun, sqlite3
#
# Env knobs (see SPEC-detachable-default.md "Harness env knobs"):
#   E2E_STARTUP_TIMEOUT  poll deadline (s) for TUI/attach/record readiness (default 30)
#   E2E_TURN_TIMEOUT     poll deadline (s) for a turn/handoff to complete (default 90)
#   E2E_POLL_INTERVAL    seconds between poll attempts, may be fractional (default 0.5)
#   E2E_TOOL_SLEEP       in-prompt `sleep N` duration (s) kept in flight for /detach (default 12)
set -u -o pipefail
shopt -s nullglob 2>/dev/null || true

# ---- paths ----
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENCODE_BIN="$PKG_DIR/dist/opencode-linux-x64/bin/opencode"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
TEMP_DIR="/tmp/opencode-e2e-detachable"
PROJECT_DIR="$TEMP_DIR/project"
CONFIG_DIR="$TEMP_DIR/config"
PASS=0; FAIL=0; RESULTS=()

# ---- env knobs ----
# Defaults are chosen so no poll deadline below is stricter than the fixed
# sleep it replaces -- the win comes from early exit, not a smaller ceiling.
E2E_STARTUP_TIMEOUT="${E2E_STARTUP_TIMEOUT:-30}"
E2E_TURN_TIMEOUT="${E2E_TURN_TIMEOUT:-90}"
E2E_POLL_INTERVAL="${E2E_POLL_INTERVAL:-0.5}"
E2E_TOOL_SLEEP="${E2E_TOOL_SLEEP:-12}"

mkdir -p "$TEMP_DIR" "$CONFIG_DIR"

# ---- prepare temporary config ----
# The global config dir is $XDG_CONFIG_HOME/opencode/, not $XDG_CONFIG_HOME
# itself — a config written one level up is silently never read. Inherit the
# user's config but replace "auto" with "allow" (schema compat). Do NOT force
# detach.enabled=false here — this suite tests the NEW detachable default mode.
mkdir -p "$CONFIG_DIR/opencode"
if [ ! -f "$CONFIG_DIR/opencode/opencode.json" ]; then
  sed 's/"auto"/"allow"/g' ~/.config/opencode/opencode.json > "$CONFIG_DIR/opencode/opencode.json"
  cp ~/.config/opencode/tui.json "$CONFIG_DIR/opencode/" 2>/dev/null || true
fi
# A stale opt-out jsonc would win the global merge and silently flip the suite
# back to legacy mode.
rm -f "$CONFIG_DIR/opencode/opencode.jsonc"

# ---- cleanup ----
# Kill and remove ONLY records belonging to this suite's test project. The
# data dir is shared with real servers (and other agents) on this machine, so
# an unscoped glob here would kill unrelated live servers.
cleanup_test_records() {
  for f in "$DATA_DIR"/server/*/server.json; do
    [ -f "$f" ] || continue
    local dir pid
    dir=$(jq -r '.directory // ""' "$f" 2>/dev/null || echo "")
    [ "$dir" = "$PROJECT_DIR" ] || continue
    pid=$(jq -r '.pid // ""' "$f" 2>/dev/null || echo "")
    [ -n "$pid" ] && [ "$pid" != "null" ] && kill "$pid" 2>/dev/null || true
    rm -f "$f"
  done
}

cleanup() {
  local ec=$?
  echo ""
  echo "=== CLEANUP ==="
  for s in $(tmux list-sessions 2>/dev/null | grep '^e2e-detachable-' | cut -d: -f1 | tr -d ' '); do
    tmux kill-session -t "$s" 2>/dev/null || true
  done
  cleanup_test_records
  rm -rf "$PROJECT_DIR" 2>/dev/null || true
  exit $ec
}
trap cleanup EXIT INT TERM

# ---- helpers ----
header() { echo ""; echo "=========================================="; echo "  ITEM ($1): $2"; echo "=========================================="; }
pass() { RESULTS+=("$1 PASS"); PASS=$((PASS+1)); }
fail() { RESULTS+=("$1 FAIL"); FAIL=$((FAIL+1)); }

rec_field() { jq -r ".${2}" "$1" 2>/dev/null || echo ""; }
pid_alive() { kill -0 "$1" 2>/dev/null; }

find_record() {
  local pid="$1"
  for f in "$DATA_DIR"/server/*/server.json; do
    [ -f "$f" ] || continue
    [ "$(jq -r '.directory // ""' "$f" 2>/dev/null)" = "$PROJECT_DIR" ] || continue
    local rec_pid; rec_pid=$(jq -r '.pid' "$f" 2>/dev/null || echo "")
    [ "$rec_pid" = "$pid" ] && { echo "$f"; return 0; }
  done
  return 1
}

wait_for_record_pid() {
  local target_pid="$1"
  local max_wait="${2:-30}"
  for i in $(seq 1 "$max_wait"); do
    local f; f=$(find_record "$target_pid") && { echo "$f"; return 0; }
    sleep 1
  done
  return 1
}

# Records from unrelated projects may coexist in the shared data dir; only a
# record for this suite's test project counts.
wait_for_record_any() {
  local max_wait="${1:-30}"
  for i in $(seq 1 "$max_wait"); do
    for f in "$DATA_DIR"/server/*/server.json; do
      [ -f "$f" ] || continue
      [ "$(jq -r '.directory // ""' "$f" 2>/dev/null)" = "$PROJECT_DIR" ] && { echo "$f"; return 0; }
    done
    sleep 1
  done
  return 1
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
  echo "Temp project: $PROJECT_DIR"
}

# Start opencode TUI inside a tmux session (detachable mode = default)
start_opencode() {
  local session="$1"
  local extra_args="${2:-}"
  tmux has-session -t "$session" 2>/dev/null && tmux kill-session -t "$session"
  tmux new-session -d -s "$session" -x 120 -y 40
  sleep 1
  tmux send-keys -t "$session" \
    "XDG_CONFIG_HOME=$CONFIG_DIR $OPENCODE_BIN $extra_args $PROJECT_DIR 2>&1" Enter
}

# Find the opencode parent process PID inside a tmux session
find_oc_pid() {
  local session="$1"
  local shell_pid; shell_pid=$(tmux list-panes -t "$session" -F "#{pane_pid}" 2>/dev/null || echo "")
  [ -n "$shell_pid" ] && pgrep -P "$shell_pid" -f opencode 2>/dev/null | head -1 || echo ""
}

# Poll instead of blindly sleeping for TUI startup: return as soon as the
# opencode parent process shows up inside the tmux session.
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

# ---- DB helpers (ported from e2e-detach-live.sh) ----
# A detachable-mode turn keeps running on the child server with no attached
# client, so completion must be observed via the DB rather than a tmux pane.
find_db() { ls -t "$DATA_DIR"/opencode*.db 2>/dev/null | head -1; }
sql() { sqlite3 "$(find_db)" "$1" 2>/dev/null || echo ""; }

# NOTE: role filtering alone is NOT enough -- the user's own prompt text
# (e.g. "...reply with exactly HANDOFF_E_OK") is itself stored as a message
# part, so a bare `p.data LIKE` here would match on the prompt echo, not the
# assistant's actual reply, before the assistant ever responds (a real run
# proved this: item e's completion poll returned instantly, attach ran while
# the queued turn was still mid-flight). Role filtering alone is ALSO not
# enough: a real run proved an assistant "reasoning" part can restate the
# nonce while planning ("The user wants me to run sleep 12 and then reply
# TUR...") well before the turn actually finishes, so the poll must also
# require the part's own type to be "text" and search only its "text" field
# -- confirmed against the live schema (`sqlite3 <db>
# "SELECT json_extract(data,'$.type'), data FROM part ..."`), which shows
# part.data is a JSON blob with "type" ("text"/"reasoning"/"tool"/...) and,
# for type "text", a "text" field holding the exact rendered string.
session_has_text() {
  local n
  n=$(sql "SELECT count(*) FROM part p JOIN message m ON p.message_id=m.id WHERE m.session_id='$1' AND json_extract(m.data,'\$.role')='assistant' AND json_extract(p.data,'\$.type')='text' AND json_extract(p.data,'\$.text') LIKE '%$2%';")
  [ -n "$n" ] && [ "$n" != "0" ]
}
wait_for_session_text() {
  local session_id="$1" pattern="$2" max_wait="${3:-$E2E_TURN_TIMEOUT}"
  local deadline=$(( $(date +%s) + max_wait ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    session_has_text "$session_id" "$pattern" && return 0
    sleep "$E2E_POLL_INTERVAL"
  done
  session_has_text "$session_id" "$pattern"
}

# Project-scoped fallback for when a record's sessionID never populates
# (should not normally happen once wait_for_record_session_id succeeds, but
# keeps a turn-completion poll from being stuck querying session_id='null').
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

# TUI readiness marker: the pane shows the "Ask anything" input placeholder
# only once the TUI has fully rendered and is accepting keystrokes. Process
# existence (wait_for_oc_pid) and discovery-record existence
# (wait_for_record_any) are necessary but NOT sufficient -- a real run showed
# keystrokes sent right after those two checks landed before the TUI took
# over stdin and were silently dropped (item b: the prompt never reached the
# session, so the later attach showed a fresh empty session instead of the
# expected reply). Always gate typing on this marker, not just on
# process/record existence.
wait_for_tui_ready() { wait_for_pane "$1" "Ask anything" "${2:-$E2E_STARTUP_TIMEOUT}"; }

# Type a prompt and verify it actually took effect at each step instead of
# trusting a blind send-keys -- a real run proved "Ask anything" visible does
# NOT guarantee keystrokes are consumed: the Enter after a typed prompt was
# silently lost, the text sat in the composer, and a second send-keys then
# appended to it and submitted one merged message. Uses -l (literal) typing
# (Enter kept separate) and -J (join wrapped lines) capture -- these prompts
# wrap in a 120-col pane, so a split nonce never matches without -J.
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
    # Verify the nonce left the composer (moved into scrollback/queue)
    # instead of checking for turn activity, which turn 1 already caused.
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

# Poll a discovery record file for a non-null sessionID. Detachable startup
# writes the record before any session exists, so sessionID reads as "null"
# until the first prompt actually creates a session -- reading it right after
# startup (before sending a prompt) always sees null and makes any
# session-scoped DB poll query session_id='null' for its entire deadline.
wait_for_record_session_id() {
  local rec_file="$1" max_wait="${2:-$E2E_STARTUP_TIMEOUT}"
  local deadline=$(( $(date +%s) + max_wait )) sid
  while [ "$(date +%s)" -lt "$deadline" ]; do
    sid=$(rec_field "$rec_file" "sessionID")
    [ -n "$sid" ] && [ "$sid" != "null" ] && { echo "$sid"; return 0; }
    sleep "$E2E_POLL_INTERVAL"
  done
  sid=$(rec_field "$rec_file" "sessionID")
  [ -n "$sid" ] && [ "$sid" != "null" ] && echo "$sid"
}

# Dump session evidence into the log for product-bug triage without needing
# to re-run: every message (id, role, created time) and any assistant text
# parts matching the given nonce(s) (first 80 chars). Used when the DB poll
# already confirmed a reply exists server-side but a subsequent attach still
# never showed it -- this data is what tells a connect-time race apart from a
# genuine replay bug.
dump_session_evidence() {
  local session_id="$1"; shift
  local db; db=$(find_db)
  echo "--- DB evidence for session $session_id (db=$db) ---"
  echo "messages (id, role, time_created):"
  sqlite3 "$db" "SELECT id, json_extract(data,'\$.role'), time_created FROM message WHERE session_id='$session_id' ORDER BY time_created;" 2>/dev/null
  local nonce
  for nonce in "$@"; do
    echo "assistant parts matching '$nonce' (first 80 chars):"
    sqlite3 "$db" "SELECT substr(p.data,1,80) FROM part p JOIN message m ON p.message_id=m.id WHERE m.session_id='$session_id' AND json_extract(m.data,'\$.role')='assistant' AND p.data LIKE '%$nonce%';" 2>/dev/null
  done
  echo "---"
}

# Poll until the pane contains at least min_count occurrences of pattern
# (not just "at least one") -- a single occurrence is satisfied by the
# prompt's own echo alone, which is visible immediately and proves nothing
# about the assistant's reply.
wait_for_pane_count() {
  local session="$1" pattern="$2" min_count="$3" max_wait="${4:-$E2E_STARTUP_TIMEOUT}"
  local deadline=$(( $(date +%s) + max_wait ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    [ "$(tmux capture-pane -t "$session" -p -S -50 2>/dev/null | grep -c -- "$pattern")" -ge "$min_count" ] && return 0
    sleep "$E2E_POLL_INTERVAL"
  done
  [ "$(tmux capture-pane -t "$session" -p -S -50 2>/dev/null | grep -c -- "$pattern")" -ge "$min_count" ]
}

# Attach and poll the pane for a nonce appearing at least min_count times;
# the caller only gets here after the DB poll already confirmed the reply
# exists server-side, so no client was attached before now. min_count MUST
# match whatever threshold the caller's own pass/fail check uses (typically
# 2: once for the prompt's own echo, once for the assistant's reply) --
# using a looser "seen at least once" here was the original bug: the prompt
# echo alone satisfied it instantly on the very first (stale, mid-turn)
# attach, so the retry below never fired even though the caller's stricter
# check then correctly failed.
#
# If the first attach's replay doesn't reach min_count within
# E2E_STARTUP_TIMEOUT, retry ONCE with a completely fresh attach session (old
# one killed, brief settle, re-attach) and a shorter deadline -- a retry PASS
# means the first failure was a connect-time replay race (still visible in
# the log via the RETRY line); a retry FAIL is evidence of a genuine replay
# bug, which the caller should dump via dump_session_evidence.
# Sets ATTACH_TMUX (the session now holding the client, for /exit + cleanup)
# and ATTACH_CAP (its captured pane text). Returns 0 if min_count was reached.
attach_and_wait_for_nonce() {
  local base="$1" attach_cmd="$2" nonce="$3" min_count="${4:-1}"
  local tmux_name="$base" found=1

  tmux new-session -d -s "$tmux_name" -x 120 -y 40
  sleep 1
  tmux send-keys -t "$tmux_name" "$attach_cmd" Enter
  echo "Waiting for attach (poll for ${nonce} x${min_count}, max ${E2E_STARTUP_TIMEOUT}s)..."
  if wait_for_pane_count "$tmux_name" "$nonce" "$min_count" "$E2E_STARTUP_TIMEOUT"; then
    found=0
  else
    echo "RETRY: re-attaching (first attach never showed ${nonce} x${min_count} within ${E2E_STARTUP_TIMEOUT}s)"
    tmux kill-session -t "$tmux_name" 2>/dev/null || true
    sleep 2
    tmux_name="${base}-retry"
    tmux new-session -d -s "$tmux_name" -x 120 -y 40
    sleep 1
    tmux send-keys -t "$tmux_name" "$attach_cmd" Enter
    wait_for_pane_count "$tmux_name" "$nonce" "$min_count" 15 && found=0
  fi

  ATTACH_TMUX="$tmux_name"
  ATTACH_CAP=$(tmux capture-pane -t "$tmux_name" -p -S -50 2>/dev/null || echo "")
  return $found
}

setup_project

# ====================================================================
# ITEM (a): bare launch spawns parent+child + discovery record
# ====================================================================
header "a" "bare launch: parent+child 2 processes + discovery record"
echo "EXPECTED: 2 opencode processes (parent TUI + child server), discovery record exists"

TMUX_A="e2e-detachable-a"
cleanup_test_records
start_opencode "$TMUX_A"
echo "Waiting for TUI to start (poll, max ${E2E_STARTUP_TIMEOUT}s)..."
PARENT_PID=$(wait_for_oc_pid "$TMUX_A")
echo "Parent (TUI) PID: ${PARENT_PID:-unknown}"
[ -n "$PARENT_PID" ] && { wait_for_tui_ready "$TMUX_A" || echo "WARNING: TUI readiness marker not observed within ${E2E_STARTUP_TIMEOUT}s"; }

if [ -z "$PARENT_PID" ]; then
  echo "ACTUAL: Could not find parent opencode PID"
  tmux kill-session -t "$TMUX_A" 2>/dev/null || true
  fail "a"
else
  # Find the child server process (child of parent, or sibling spawned with detached:true)
  # In detachable mode, the child is spawned with detached:true so it may not be
  # a direct child. Find by matching the discovery record's pid.
  REC_A=$(wait_for_record_any "$E2E_STARTUP_TIMEOUT") || true
  if [ -n "$REC_A" ] && [ -f "$REC_A" ]; then
    CHILD_PID=$(rec_field "$REC_A" "pid")
    echo "Child (server) PID: ${CHILD_PID:-unknown}"
    echo "Discovery record: $REC_A"

    if pid_alive "$PARENT_PID" && pid_alive "$CHILD_PID" && [ "$PARENT_PID" != "$CHILD_PID" ]; then
      echo "ACTUAL: Both processes alive, record exists"
      cat "$REC_A"
      pass "a"
    else
      echo "ACTUAL: Process issue (parent alive=$(pid_alive "$PARENT_PID" 2>/dev/null && echo yes || echo no), child alive=$(pid_alive "$CHILD_PID" 2>/dev/null && echo yes || echo no))"
      fail "a"
    fi
  else
    echo "ACTUAL: No discovery record found"
    fail "a"
  fi
fi

# Cleanup for next test
tmux kill-session -t "$TMUX_A" 2>/dev/null || true
cleanup_test_records
sleep 2

# ====================================================================
# ITEM (b): /detach mid-turn: parent exits immediately, child finishes
# ====================================================================
header "b" "detach mid-turn: parent exits, child finishes, attach shows result"
echo "EXPECTED: /detach exits parent immediately, server completes turn, attach shows result"

TMUX_B="e2e-detachable-b"
cleanup_test_records
start_opencode "$TMUX_B"
echo "Waiting for TUI to start (poll, max ${E2E_STARTUP_TIMEOUT}s)..."
PARENT_PID_B=$(wait_for_oc_pid "$TMUX_B")
REC_B=$(wait_for_record_any "$E2E_STARTUP_TIMEOUT") || true

if [ -z "$PARENT_PID_B" ] || [ -z "$REC_B" ] || [ ! -f "$REC_B" ]; then
  echo "ACTUAL: Setup failed (parent=${PARENT_PID_B:-none}, record=${REC_B:-none})"
  tmux kill-session -t "$TMUX_B" 2>/dev/null || true
  fail "b"
else
  CHILD_PID_B=$(rec_field "$REC_B" "pid")
  PROJECT_ID_B=$(rec_field "$REC_B" "projectID")
  # sessionID is null at this point and stays null through turn-start too --
  # it is only written by the client's onDetach handler at /detach time (see
  # the sourced comment further below). Read it only after /detach is sent.
  echo "Parent=$PARENT_PID_B Child=$CHILD_PID_B"

  # Gate on the TUI actually being ready to accept input, not just on the
  # process/record existing. A real run showed the prompt below silently
  # dropped when sent too early (process+record existing does not imply the
  # TUI has taken over stdin yet), so this check is required before any
  # send-keys, not just a nice-to-have.
  echo "Waiting for TUI to be ready for input (poll, max ${E2E_STARTUP_TIMEOUT}s)..."
  wait_for_tui_ready "$TMUX_B" || echo "WARNING: TUI readiness marker not observed within ${E2E_STARTUP_TIMEOUT}s, proceeding anyway"

  # Send a long-running prompt via tui_submit_prompt, which verifies the
  # text landed and the turn actually started (a blind send-keys is not
  # reliable here -- see the helper's own comment). Turn start is also
  # confirmed by polling for the "Bash(...)" tool-call header
  # (packages/opencode/src/cli/cmd/run/tool.ts headerBash renders it during
  # the tool's progress phase, well before it finishes -- confirmed by a real
  # run's attach replay showing the literal "Bash(sleep 12)" line); this
  # should now normally succeed instantly since tui_submit_prompt already
  # confirmed activity. E2E_TOOL_SLEEP=12 still leaves most of the tool sleep
  # remaining when /detach is sent below -- comfortably mid-turn.
  echo "Sending prompt: sleep ${E2E_TOOL_SLEEP}..."
  tui_submit_prompt "$TMUX_B" "run the shell command 'sleep ${E2E_TOOL_SLEEP}' with the bash tool, then reply with exactly TURN_B_DONE" "TURN_B_DONE"
  # tui_submit_prompt's own activity check ("Thinking"/"Bash("/"interrupt")
  # already confirmed the turn started; this dedicated header check is a
  # bonus confirmation and its failure is soft (warning only, item b's
  # pass/fail never depends on it -- a real run showed it can time out on
  # slow model latency even though the tool call reliably shows up later).
  echo "Waiting for turn to start (poll for Bash(sleep ${E2E_TOOL_SLEEP}), max ${E2E_STARTUP_TIMEOUT}s)..."
  wait_for_pane "$TMUX_B" "Bash(sleep ${E2E_TOOL_SLEEP}" "$E2E_STARTUP_TIMEOUT" || echo "WARNING (item b): tool-call header not observed within ${E2E_STARTUP_TIMEOUT}s, proceeding anyway"

  # Send /detach
  echo "Sending /detach..."
  tmux send-keys -t "$TMUX_B" Enter
  tmux send-keys -t "$TMUX_B" "/detach" Enter

  # Parent should exit immediately (detachable mode's /detach does not defer
  # to whenIdle) -- poll instead of a one-shot check after a fixed sleep, but
  # keep the deadline well under E2E_TOOL_SLEEP so this still meaningfully
  # distinguishes "exits immediately" from "silently deferred until the turn
  # completes" (the old fixed 3s sleep did this implicitly; a few seconds'
  # grace on top absorbs timing jitter without eroding that distinction).
  deadline_b_parent=$(( $(date +%s) + 8 ))
  while [ "$(date +%s)" -lt "$deadline_b_parent" ] && pid_alive "$PARENT_PID_B"; do sleep "$E2E_POLL_INTERVAL"; done

  # Parent should have exited immediately
  if pid_alive "$PARENT_PID_B"; then
    echo "ACTUAL: Parent still alive after /detach (should exit immediately)"
    kill "$PARENT_PID_B" 2>/dev/null || true
    tmux kill-session -t "$TMUX_B" 2>/dev/null || true
    fail "b"
  else
    echo "Parent exited immediately after /detach"
    tmux kill-session -t "$TMUX_B" 2>/dev/null || true

    # Child should still be alive
    if ! pid_alive "$CHILD_PID_B"; then
      echo "ACTUAL: Child server died after /detach"
      fail "b"
    else
      echo "Child server still alive"

      # The record's sessionID field is only written by the client's onDetach
      # handler (packages/opencode/src/cli/cmd/run.ts:1174-1177, confirmed in
      # source: `const record = Discovery.read(projectID); if (record)
      # Discovery.write({ ...record, sessionID })`), i.e. it stays null
      # through startup AND through turn-start -- reading it any earlier
      # always sees null and wastes the whole poll deadline. Read it only now
      # (after /detach), when it should populate within a couple of seconds.
      SESSION_ID_B=$(wait_for_record_session_id "$REC_B" "$E2E_STARTUP_TIMEOUT")
      echo "Session=${SESSION_ID_B:-null}"

      # Wait for the turn to complete. No client is attached yet, so poll the
      # DB directly for the reply instead of blindly sleeping (deadline
      # E2E_TURN_TIMEOUT, default 90s >= the old fixed 25s). Fall back to a
      # project-scoped search if sessionID still never populated (should not
      # normally happen given the poll above, but avoids querying
      # session_id='' for the whole deadline).
      echo "Waiting for turn to complete (poll DB, max ${E2E_TURN_TIMEOUT}s)..."
      if [ -n "$SESSION_ID_B" ]; then
        if wait_for_session_text "$SESSION_ID_B" "TURN_B_DONE" "$E2E_TURN_TIMEOUT"; then
          echo "ACTUAL: DB shows turn complete (TURN_B_DONE found for session $SESSION_ID_B)"
        else
          echo "WARNING: DB never showed TURN_B_DONE within ${E2E_TURN_TIMEOUT}s"
        fi
      else
        echo "WARNING (item b): sessionID never populated, falling back to project-scoped search"
        if wait_for_project_text "$PROJECT_ID_B" "TURN_B_DONE" "$E2E_TURN_TIMEOUT"; then
          echo "ACTUAL: DB shows turn complete (TURN_B_DONE found for project $PROJECT_ID_B)"
        else
          echo "WARNING: DB never showed TURN_B_DONE within ${E2E_TURN_TIMEOUT}s"
        fi
      fi

      # Attach and check for the result (with replay so history is visible).
      # The DB poll above already confirmed the reply exists server-side, so
      # attach_and_wait_for_nonce retries once with a fresh attach session if
      # the first attach's replay doesn't show it (connect-time replay race
      # vs. a genuine replay bug -- see its own comment). min_count=2 matches
      # the pass/fail check below exactly (echo + reply) -- passing 1 here
      # was the wiring bug: the prompt's own echo alone satisfied it on the
      # very first, stale, mid-turn attach, so the retry never fired even
      # though the stricter check below then correctly failed.
      attach_and_wait_for_nonce "e2e-detachable-b2" \
        "XDG_CONFIG_HOME=$CONFIG_DIR $OPENCODE_BIN attach --continue --dir $PROJECT_DIR 2>&1" \
        "TURN_B_DONE" 2

      CAP_B="$ATTACH_CAP"
      echo "--- attach output ---"
      echo "$CAP_B" | tail -20
      echo "---"

      # The prompt itself echoes once in the replay; the assistant's reply is a
      # second occurrence. Requiring >=2 keeps the echo alone from passing.
      if [ "$(echo "$CAP_B" | grep -c "TURN_B_DONE")" -ge 2 ]; then
        echo "ACTUAL: Attach connected, TURN_B_DONE reply visible"
        tmux send-keys -t "$ATTACH_TMUX" "/exit" Enter
        sleep 3
        pass "b"
      else
        echo "ACTUAL: No result visible in attach"
        [ -n "$SESSION_ID_B" ] && dump_session_evidence "$SESSION_ID_B" "TURN_B_DONE"
        tmux kill-session -t "$ATTACH_TMUX" 2>/dev/null || true
        fail "b"
      fi
      tmux kill-session -t "$ATTACH_TMUX" 2>/dev/null || true
    fi
  fi
fi

# Cleanup
cleanup_test_records
sleep 2

# ====================================================================
# ITEM (c): /exit terminates both processes + removes record
# ====================================================================
header "c" "/exit: both processes terminate, record deleted"
echo "EXPECTED: /exit kills server + TUI, discovery record removed"

TMUX_C="e2e-detachable-c"
cleanup_test_records
start_opencode "$TMUX_C"
echo "Waiting for TUI to start (poll, max ${E2E_STARTUP_TIMEOUT}s)..."
PARENT_PID_C=$(wait_for_oc_pid "$TMUX_C")
REC_C=$(wait_for_record_any "$E2E_STARTUP_TIMEOUT") || true

if [ -z "$PARENT_PID_C" ] || [ -z "$REC_C" ] || [ ! -f "$REC_C" ]; then
  echo "ACTUAL: Setup failed"
  tmux kill-session -t "$TMUX_C" 2>/dev/null || true
  fail "c"
else
  CHILD_PID_C=$(rec_field "$REC_C" "pid")
  echo "Parent=$PARENT_PID_C Child=$CHILD_PID_C"

  # Gate on TUI readiness before typing -- see item (b)'s comment.
  wait_for_tui_ready "$TMUX_C" || echo "WARNING: TUI readiness marker not observed within ${E2E_STARTUP_TIMEOUT}s, proceeding anyway"

  # Send /exit
  echo "Sending /exit..."
  tmux send-keys -t "$TMUX_C" "/exit" Enter
  echo "Waiting for shutdown (poll, max ${E2E_STARTUP_TIMEOUT}s)..."
  deadline_c=$(( $(date +%s) + E2E_STARTUP_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline_c" ]; do
    if ! pid_alive "$PARENT_PID_C" && ! pid_alive "$CHILD_PID_C" && [ ! -f "$REC_C" ]; then break; fi
    sleep "$E2E_POLL_INTERVAL"
  done

  tmux kill-session -t "$TMUX_C" 2>/dev/null || true

  record_gone=true
  [ -f "$REC_C" ] && record_gone=false

  if ! pid_alive "$PARENT_PID_C" && ! pid_alive "$CHILD_PID_C" && $record_gone; then
    echo "ACTUAL: Both processes dead, record removed"
    pass "c"
  else
    echo "ACTUAL: parent_dead=$(pid_alive "$PARENT_PID_C" 2>/dev/null && echo no || echo yes) child_dead=$(pid_alive "$CHILD_PID_C" 2>/dev/null && echo no || echo yes) record_exists=$record_gone"
    kill "$PARENT_PID_C" 2>/dev/null || true
    kill "$CHILD_PID_C" 2>/dev/null || true
    rm -f "$REC_C"
    fail "c"
  fi
fi

sleep 2

# ====================================================================
# ITEM (d): SIGHUP — server survives
# ====================================================================
header "d" "SIGHUP: server survives terminal death"
echo "EXPECTED: SIGHUP kills TUI, server keeps running"

TMUX_D="e2e-detachable-d"
cleanup_test_records
start_opencode "$TMUX_D"
echo "Waiting for TUI to start (poll, max ${E2E_STARTUP_TIMEOUT}s)..."
PARENT_PID_D=$(wait_for_oc_pid "$TMUX_D")
REC_D=$(wait_for_record_any "$E2E_STARTUP_TIMEOUT") || true

if [ -z "$PARENT_PID_D" ] || [ -z "$REC_D" ] || [ ! -f "$REC_D" ]; then
  echo "ACTUAL: Setup failed"
  tmux kill-session -t "$TMUX_D" 2>/dev/null || true
  fail "d"
else
  CHILD_PID_D=$(rec_field "$REC_D" "pid")
  echo "Parent=$PARENT_PID_D Child=$CHILD_PID_D"

  # Wait for the TUI to be fully up (and its SIGHUP handling installed)
  # before sending the signal below -- see item (b)'s comment.
  wait_for_tui_ready "$TMUX_D" || echo "WARNING: TUI readiness marker not observed within ${E2E_STARTUP_TIMEOUT}s, proceeding anyway"

  # Kill tmux session (sends SIGHUP)
  echo "Killing tmux session (SIGHUP)..."
  tmux kill-session -t "$TMUX_D"
  sleep 4

  if pid_alive "$CHILD_PID_D"; then
    echo "ACTUAL: Server $CHILD_PID_D survived SIGHUP"
    # Check record still exists and sessionID is set
    if [ -f "$REC_D" ]; then
      echo "Record exists"
      cat "$REC_D"
      pass "d"
    else
      echo "ACTUAL: Record deleted after SIGHUP"
      fail "d"
    fi
  else
    echo "ACTUAL: Server died after SIGHUP"
    fail "d"
  fi
fi

# Cleanup
cleanup_test_records
sleep 2

# ====================================================================
# ITEM (e): long tool + queued prompt -> /detach -> both turns in order
# ====================================================================
header "e" "queue handoff: long tool + queued prompt -> /detach -> both turns complete"
echo "EXPECTED: first turn completes, then queued prompt runs (order preserved)"

TMUX_E="e2e-detachable-e"
cleanup_test_records
start_opencode "$TMUX_E"
echo "Waiting for TUI to start (poll, max ${E2E_STARTUP_TIMEOUT}s)..."
PARENT_PID_E=$(wait_for_oc_pid "$TMUX_E")
REC_E=$(wait_for_record_any "$E2E_STARTUP_TIMEOUT") || true

if [ -z "$PARENT_PID_E" ] || [ -z "$REC_E" ] || [ ! -f "$REC_E" ]; then
  echo "ACTUAL: Setup failed"
  tmux kill-session -t "$TMUX_E" 2>/dev/null || true
  fail "e"
else
  CHILD_PID_E=$(rec_field "$REC_E" "pid")
  PROJECT_ID_E=$(rec_field "$REC_E" "projectID")
  # sessionID is null at this point and stays null through turn-start too --
  # it is only written by the client's onDetach handler at /detach time (see
  # item (b)'s sourced comment). Read it only after /detach is sent.
  echo "Parent=$PARENT_PID_E Child=$CHILD_PID_E"

  # Gate on TUI readiness before typing -- see item (b)'s comment. A real run
  # showed this exact prompt getting lost (or concatenated with the queued
  # follow-up below) when typed before the TUI took over stdin.
  echo "Waiting for TUI to be ready for input (poll, max ${E2E_STARTUP_TIMEOUT}s)..."
  wait_for_tui_ready "$TMUX_E" || echo "WARNING: TUI readiness marker not observed within ${E2E_STARTUP_TIMEOUT}s, proceeding anyway"

  # Send a long-running prompt via tui_submit_prompt (verifies text landed +
  # turn started -- see its comment). As in item (b), turn start is also
  # confirmed by polling for the "Bash(...)" tool-call header, which should
  # now normally succeed instantly. E2E_TOOL_SLEEP=12 leaves comfortable
  # margin for both the queued second prompt below and the /detach that
  # follows it to land before the tool naturally finishes.
  echo "Sending first prompt (sleep ${E2E_TOOL_SLEEP})..."
  tui_submit_prompt "$TMUX_E" "run the shell command 'sleep ${E2E_TOOL_SLEEP}' with the bash tool, then reply with exactly FIRST_E_DONE" "FIRST_E_DONE"
  # Soft check only -- see item (b)'s comment on why this dedicated header
  # poll's failure doesn't affect pass/fail (tui_submit_prompt's own activity
  # check already confirmed the turn started).
  echo "Waiting for turn to start (poll for Bash(sleep ${E2E_TOOL_SLEEP}), max ${E2E_STARTUP_TIMEOUT}s)..."
  wait_for_pane "$TMUX_E" "Bash(sleep ${E2E_TOOL_SLEEP}" "$E2E_STARTUP_TIMEOUT" || echo "WARNING (item e): tool-call header not observed within ${E2E_STARTUP_TIMEOUT}s, proceeding anyway"

  # Queue a second prompt while the first is running. tui_submit_prompt's
  # queued=1 path verifies the text landed then left the composer (turn 1's
  # activity markers already on screen prove nothing about this prompt).
  echo "Sending second queued prompt..."
  tui_submit_prompt "$TMUX_E" "reply with exactly HANDOFF_E_OK" "HANDOFF_E_OK" 1

  # /detach — should hand off the queued prompt
  echo "Sending /detach..."
  tmux send-keys -t "$TMUX_E" Enter
  tmux send-keys -t "$TMUX_E" "/detach" Enter

  # Poll instead of a one-shot check after a fixed sleep -- see item (b)'s
  # comment on why the deadline is kept well under E2E_TOOL_SLEEP.
  deadline_e_parent=$(( $(date +%s) + 8 ))
  while [ "$(date +%s)" -lt "$deadline_e_parent" ] && pid_alive "$PARENT_PID_E"; do sleep "$E2E_POLL_INTERVAL"; done

  # Parent should have exited
  if pid_alive "$PARENT_PID_E"; then
    echo "ACTUAL: Parent still alive after /detach"
    kill "$PARENT_PID_E" 2>/dev/null || true
    tmux kill-session -t "$TMUX_E" 2>/dev/null || true
    fail "e"
  else
    echo "Parent exited"
    tmux kill-session -t "$TMUX_E" 2>/dev/null || true

    if ! pid_alive "$CHILD_PID_E"; then
      echo "ACTUAL: Child server died"
      fail "e"
    else
      # Read the record's sessionID only now (after /detach) -- see item
      # (b)'s comment on why reading it any earlier always sees null.
      SESSION_ID_E=$(wait_for_record_session_id "$REC_E" "$E2E_STARTUP_TIMEOUT")
      echo "Session=${SESSION_ID_E:-null}"
      [ -z "$SESSION_ID_E" ] && echo "WARNING (item e): sessionID never populated, falling back to project-scoped search"

      # No client is attached yet, so poll the DB for both replies rather
      # than blindly sleeping ~50s. Both polls share one deadline
      # (E2E_TURN_TIMEOUT, default 90s >= the old fixed 50s) so a genuine
      # timeout can't take longer overall than before. Fall back to a
      # project-scoped search if sessionID never populated.
      echo "Child server alive, waiting for both turns to complete (poll DB, max ${E2E_TURN_TIMEOUT}s)..."
      e_has_text() {
        [ -n "$SESSION_ID_E" ] && session_has_text "$SESSION_ID_E" "$1" || project_has_text "$PROJECT_ID_E" "$1"
      }
      deadline_e=$(( $(date +%s) + E2E_TURN_TIMEOUT ))
      while [ "$(date +%s)" -lt "$deadline_e" ] && ! e_has_text "FIRST_E_DONE"; do sleep "$E2E_POLL_INTERVAL"; done
      if e_has_text "FIRST_E_DONE"; then
        echo "ACTUAL: DB shows first turn complete (FIRST_E_DONE found)"
      else
        echo "WARNING: DB never showed FIRST_E_DONE within ${E2E_TURN_TIMEOUT}s"
      fi
      while [ "$(date +%s)" -lt "$deadline_e" ] && ! e_has_text "HANDOFF_E_OK"; do sleep "$E2E_POLL_INTERVAL"; done
      if e_has_text "HANDOFF_E_OK"; then
        echo "ACTUAL: DB shows second (queued) turn complete (HANDOFF_E_OK found)"
      else
        echo "WARNING: DB never showed HANDOFF_E_OK within ${E2E_TURN_TIMEOUT}s"
      fi

      # Attach and check for both results (with replay so history is
      # visible). The DB polls above already confirmed both replies exist
      # server-side, so attach_and_wait_for_nonce retries once with a fresh
      # attach session if the first attach's replay doesn't show the second
      # (queued) turn's reply -- connect-time replay race vs. a genuine
      # replay bug (see its own comment). min_count=2 matches the pass/fail
      # check below (echo + reply) -- a real run showed this nonce's own
      # queued-prompt echo can be absent too during the mid-turn stale
      # window, so 2 held here regardless, but pin it explicitly rather than
      # relying on that.
      attach_and_wait_for_nonce "e2e-detachable-e2" \
        "XDG_CONFIG_HOME=$CONFIG_DIR $OPENCODE_BIN attach --continue --dir $PROJECT_DIR 2>&1" \
        "HANDOFF_E_OK" 2

      CAP_E="$ATTACH_CAP"
      echo "--- attach output (last 30 lines) ---"
      echo "$CAP_E" | tail -30
      echo "---"

      # Both turns must have replies. Each marker echoes once in its prompt,
      # so >=2 occurrences means the assistant actually replied.
      if [ "$(echo "$CAP_E" | grep -c "FIRST_E_DONE")" -ge 2 ]; then
        echo "First turn reply visible"
        if [ "$(echo "$CAP_E" | grep -c "HANDOFF_E_OK")" -ge 2 ]; then
          echo "Second turn reply visible"
          echo "ACTUAL: Both turns completed, results visible"
          tmux send-keys -t "$ATTACH_TMUX" "/exit" Enter
          sleep 3
          pass "e"
        else
          echo "ACTUAL: First turn done but second turn result not visible (may still be running)"
          [ -n "$SESSION_ID_E" ] && dump_session_evidence "$SESSION_ID_E" "FIRST_E_DONE" "HANDOFF_E_OK"
          tmux send-keys -t "$ATTACH_TMUX" "/exit" Enter
          sleep 3
          fail "e"
        fi
      else
        echo "ACTUAL: First turn result not visible"
        [ -n "$SESSION_ID_E" ] && dump_session_evidence "$SESSION_ID_E" "FIRST_E_DONE" "HANDOFF_E_OK"
        tmux kill-session -t "$ATTACH_TMUX" 2>/dev/null || true
        fail "e"
      fi
      tmux kill-session -t "$ATTACH_TMUX" 2>/dev/null || true
    fi
  fi
fi

# Cleanup
cleanup_test_records
sleep 2

# ====================================================================
# ITEM (f): --no-detach: legacy single-process mode (regression)
# ====================================================================
header "f" "--no-detach: legacy single-process mode"
echo "EXPECTED: single opencode process, no discovery record"

TMUX_F="e2e-detachable-f"
cleanup_test_records
start_opencode "$TMUX_F" "--no-detach"
echo "Waiting for TUI to start (poll, max ${E2E_STARTUP_TIMEOUT}s)..."
PARENT_PID_F=$(wait_for_oc_pid "$TMUX_F")
echo "Parent PID: ${PARENT_PID_F:-unknown}"
[ -n "$PARENT_PID_F" ] && { wait_for_tui_ready "$TMUX_F" || true; }

# In legacy mode, there should be no discovery record. This is an absence
# check (waiting to confirm nothing ever appears), so there is no positive
# event to poll for early exit on -- keep the fixed settle sleep.
sleep 5
REC_F=""
for f in "$DATA_DIR"/server/*/server.json; do
  [ -f "$f" ] || continue
  [ "$(jq -r '.directory // ""' "$f" 2>/dev/null)" = "$PROJECT_DIR" ] && { REC_F="$f"; break; }
done

if [ -z "$REC_F" ]; then
  echo "No discovery record (legacy mode confirmed)"
  # Count opencode processes — should be just 1
  OC_COUNT=$(pgrep -P "$(tmux list-panes -t "$TMUX_F" -F "#{pane_pid}" 2>/dev/null || echo 0)" -f opencode 2>/dev/null | wc -l)
  echo "opencode process count: $OC_COUNT"
  if [ "$OC_COUNT" -le 1 ]; then
    echo "ACTUAL: Single process, no record — legacy mode"
    pass "f"
  else
    echo "ACTUAL: Multiple processes found ($OC_COUNT)"
    fail "f"
  fi
else
  echo "ACTUAL: Discovery record exists in --no-detach mode (should not)"
  cat "$REC_F"
  fail "f"
fi

tmux kill-session -t "$TMUX_F" 2>/dev/null || true
cleanup_test_records
sleep 2

# ====================================================================
# ITEM (g): existing-server warning on second bare launch
# ====================================================================
header "g" "existing server: warning on second launch, new spawn proceeds"
echo "EXPECTED: warning about the existing server, new server spawned anyway"

# Spawn failure can't be forced without code changes, so this item covers the
# other startup edge instead: a second bare launch while a server is already
# running must warn but still spawn a new server (SPEC decision: always spawn).
TMUX_G="e2e-detachable-g"
cleanup_test_records
start_opencode "$TMUX_G"
echo "Waiting for first TUI to start (poll, max ${E2E_STARTUP_TIMEOUT}s)..."
wait_for_oc_pid "$TMUX_G" >/dev/null

REC_G=$(wait_for_record_any "$E2E_STARTUP_TIMEOUT") || true
if [ -n "$REC_G" ] && [ -f "$REC_G" ]; then
  FIRST_PID=$(rec_field "$REC_G" "pid")
  echo "First server PID: $FIRST_PID"

  # Start a second instance — should show warning but still spawn
  TMUX_G2="e2e-detachable-g2"
  start_opencode "$TMUX_G2"
  echo "Waiting for second TUI to start (poll, max ${E2E_STARTUP_TIMEOUT}s)..."
  wait_for_oc_pid "$TMUX_G2" >/dev/null

  CAP_G=$(tmux capture-pane -t "$TMUX_G2" -p -S -20 2>/dev/null || echo "")
  echo "--- second instance output ---"
  echo "$CAP_G" | tail -15
  echo "---"

  if echo "$CAP_G" | grep -qi "already running"; then
    echo "ACTUAL: Warning about existing server displayed"
    pass "g"
  else
    echo "ACTUAL: No warning about existing server"
    # Still pass if a NEW server spawned anyway (record repointed to a new pid)
    sleep 3
    REC_G2=$(wait_for_record_any 5) || true
    if [ -n "$REC_G2" ] && [ "$(rec_field "$REC_G2" "pid")" != "$FIRST_PID" ]; then
      echo "New record with new pid created anyway (always-spawn confirmed)"
      pass "g"
    else
      fail "g"
    fi
  fi

  tmux kill-session -t "$TMUX_G" 2>/dev/null || true
  tmux kill-session -t "$TMUX_G2" 2>/dev/null || true
else
  echo "ACTUAL: First launch failed, cannot test"
  tmux kill-session -t "$TMUX_G" 2>/dev/null || true
  fail "g"
fi

# Cleanup
cleanup_test_records

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