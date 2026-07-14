#!/usr/bin/env bash
# opencode delivery plug — markdown rule-file with mode marker.
#
# Fully overrides the built-in opencode _delivery.sh to support monitor/both
# modes in addition to turn/off. The rule file carries a machine-readable first
# line (<!-- agmsg mode: <mode> -->) so subsequent status queries can
# distinguish all four modes. For turn/both the PostToolUse check-inbox section
# is included; for monitor the file is just the marker line. The on_enable hook
# emits an AGMSG-DIRECTIVE that tells the running opencode session to invoke its
# Monitor tool with the watch.sh command. Sourced into delivery.sh's context, so
# resolve_hooks_file, SKILL_DIR, RUN_DIR, compat_uuidgen,
# agmsg_normalize_instance_id are in scope.

agmsg_delivery_apply() {
  local type="$1"
  local project="$2"
  local mode="$3"
  local rule_file
  rule_file=$(resolve_hooks_file "$type" "$project")

  rm -f "$rule_file"

  if [ "$mode" != "off" ]; then
    mkdir -p "$(dirname "$rule_file")"
    printf '<!-- agmsg mode: %s -->\n' "$mode" > "$rule_file"
    case "$mode" in
      turn|both)
        cat >> "$rule_file" <<EOF

## PostToolUse
After each tool call, automatically check the agmsg inbox for unread messages.
- Command: '$SKILL_DIR/scripts/check-inbox.sh' '$type' '$project'
EOF
        ;;
      monitor)
        : # just the marker line
        ;;
    esac
  fi
}

agmsg_delivery_on_enable() {
  local mode="$1"
  local type="$2"
  local project="$3"
  echo "Future sessions: SessionStart hook will auto-launch the watcher."
  emit_opencode_monitor_directive "$type" "$project"
}

emit_opencode_monitor_directive() {
  local type="$1"
  local project="$2"
  local watch="$SKILL_DIR/scripts/watch.sh"

  # opencode exports OPENCODE_SESSION_ID for every subprocess. Bake it into
  # the command so the agent never has to invent a value. Fall back to a
  # generated id when the env var is not present.
  local session_id="${OPENCODE_SESSION_ID:-}"
  if [ -z "$session_id" ]; then
    session_id="agmsg-$(compat_uuidgen | tr 'A-Z' 'a-z')"
  fi

  # Key the watcher on the per-process instance id so parallel --continue
  # / --resume sessions sharing a session_id stay isolated.
  session_id="$(agmsg_normalize_instance_id "$session_id" "$type")"

  # Skip when this session already has a live watcher — invoking Monitor
  # again would just spawn a duplicate and orphan the previous watcher.
  local pidfile="$RUN_DIR/watch.$session_id.pid"
  if [ -f "$pidfile" ]; then
    local existing
    existing=$(cat "$pidfile" 2>/dev/null || true)
    if [ -n "$existing" ] && kill -0 "$existing" 2>/dev/null; then
      cat <<EOF

A watch.sh is already streaming into this session (pid $existing). No
action needed — the existing watcher is the active one.
EOF
      return 0
    fi
  fi

  local watch_command
  watch_command="$(printf '%q %q %q %q' "$watch" "$session_id" "$project" "$type")"
  cat <<EOF

AGMSG-DIRECTIVE: For this running session, invoke the Monitor tool now with:
  command: $watch_command
  description: agmsg inbox stream
  persistent: true

Pass the command above verbatim — the session_id is already filled in.
EOF
}

agmsg_delivery_stop_directive() {
  cat <<'EOF'

AGMSG-DIRECTIVE: If an agmsg watch Monitor task is running in this session,
find it with Monitor tool action: list (description starts with "agmsg inbox
stream") and stop it with Monitor tool action: stop using the matching
monitor_id. Existing watch.sh processes have already been killed by this
command.
EOF
}

agmsg_delivery_status() {
  local type="$1" project="$2"
  local rule_file
  rule_file=$(resolve_hooks_file "$type" "$project")
  if [ -f "$rule_file" ]; then
    local first_line
    first_line=$(head -1 "$rule_file" 2>/dev/null || true)
    case "$first_line" in
      '<!-- agmsg mode: monitor -->') echo "mode: monitor" ;;
      '<!-- agmsg mode: both -->')    echo "mode: both" ;;
      '<!-- agmsg mode: turn -->')    echo "mode: turn" ;;
      *)                              echo "mode: turn" ;;
    esac
  else
    echo "mode: off"
  fi
}
