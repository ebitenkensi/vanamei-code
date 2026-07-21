#!/usr/bin/env bash
set -euo pipefail

# Verify the agmsg opencode plugin is correctly installed and functional.
# Runs against the INSTALLED skill at ~/.agents/skills/agmsg/scripts/.
# Creates a temporary project directory for mode tests.
# Idempotent — cleans up after itself.

SKILL_DIR="$HOME/.agents/skills/agmsg"
SCRIPTS_DIR="$SKILL_DIR/scripts"
PLUGIN_DIR="$SKILL_DIR/plugins/types/opencode"

pass=0
fail=0
skip=0

pass() { pass=$((pass+1)); echo "PASS: $1"; }
fail_msg() { fail=$((fail+1)); echo "FAIL: $1"; }
skip_msg() { skip=$((skip+1)); echo "SKIP: $1"; }

# Helper: run a test that expects a substring in output.
expect_in() {
  local label="$1" needle="$2"; shift 2
  local output
  output="$("$@" 2>&1 || true)"
  if echo "$output" | grep -qF "$needle"; then
    pass "$label"
  else
    echo "  expected to contain: $needle"
    echo "  got: $output"
    fail_msg "$label"
  fi
}

# Get opencode.local.json path for a test project
local_config_path() {
  echo "$1/.opencode/opencode.local.json"
}

# --- Setup: create temp project dir ---
TMPDIR="${TMPDIR:-/tmp}"
TEST_PROJECT="$(mktemp -d "$TMPDIR/agmsg-verify.XXXXXX")"
cleanup() { rm -rf "$TEST_PROJECT"; }
trap cleanup EXIT

echo "=== agmsg opencode plugin verify ==="
echo ""

# --- 1. plugin.sh list shows types/opencode as trusted ---
echo "--- Item 1: plugin list shows trusted ---"
output="$("$SCRIPTS_DIR/plugin.sh" list 2>&1 || true)"
if echo "$output" | grep -qE "types/opencode[[:space:]]+trusted"; then
  pass "plugin list shows types/opencode as trusted"
else
  echo "  plugin list output:"
  echo "$output"
  fail_msg "plugin list does not show types/opencode as trusted"
fi

# --- 2. Type resolution points to plugin (delivery_modes includes monitor) ---
echo "--- Item 2: type_resolution includes monitor ---"
# delivery.sh set monitor would fail before plugin; if it accepts monitor it means
# the type_registry resolved the plugin's delivery_modes.
output="$("$SCRIPTS_DIR/delivery.sh" set monitor opencode "$TEST_PROJECT" 2>&1 || true)"
if echo "$output" | grep -q "Delivery mode set to 'monitor'"; then
  pass "type resolution accepted monitor mode (plugin delivery_modes active)"
else
  echo "  delivery.sh set monitor output:"
  echo "$output"
  fail_msg "delivery.sh set monitor was rejected — plugin type.conf not resolving"
fi

# --- 3. delivery.sh set for all 4 modes — check rule file ---
echo "--- Item 3: delivery mode apply results ---"

# 3a. turn mode
"$SCRIPTS_DIR/delivery.sh" set turn opencode "$TEST_PROJECT" >/dev/null 2>&1 || true
if [ -f "$TEST_PROJECT/.opencode/rules/agmsg.md" ]; then
  first_line=$(head -1 "$TEST_PROJECT/.opencode/rules/agmsg.md" 2>/dev/null || true)
  if [ "$first_line" = "<!-- agmsg mode: turn -->" ]; then
    # Check PostToolUse section is present for turn
    if grep -q "PostToolUse" "$TEST_PROJECT/.opencode/rules/agmsg.md" 2>/dev/null; then
      pass "turn mode: rule file has correct marker and PostToolUse section"
    else
      fail_msg "turn mode: rule file missing PostToolUse section"
    fi
  else
    fail_msg "turn mode: rule file marker is '$first_line'"
  fi
else
  fail_msg "turn mode: rule file not created"
fi

# 3b. monitor mode — rule file must have NO self-arm block and NO PostToolUse
"$SCRIPTS_DIR/delivery.sh" set monitor opencode "$TEST_PROJECT" >/dev/null 2>&1 || true
if [ -f "$TEST_PROJECT/.opencode/rules/agmsg.md" ]; then
  first_line=$(head -1 "$TEST_PROJECT/.opencode/rules/agmsg.md" 2>/dev/null || true)
  if [ "$first_line" = "<!-- agmsg mode: monitor -->" ]; then
    # PostToolUse should be absent for monitor mode (just the marker)
    if ! grep -q "PostToolUse" "$TEST_PROJECT/.opencode/rules/agmsg.md" 2>/dev/null; then
      # Self-arm block (session start section) must also be absent
      if ! grep -q "agmsg monitor (session start)" "$TEST_PROJECT/.opencode/rules/agmsg.md" 2>/dev/null; then
        pass "monitor mode: rule file has correct marker, no PostToolUse, no self-arm block"
      else
        fail_msg "monitor mode: rule file should not have self-arm block"
      fi
    else
      fail_msg "monitor mode: rule file should not have PostToolUse section"
    fi
  else
    fail_msg "monitor mode: rule file marker is '$first_line'"
  fi
else
  fail_msg "monitor mode: rule file not created"
fi

# 3c. both mode
"$SCRIPTS_DIR/delivery.sh" set both opencode "$TEST_PROJECT" >/dev/null 2>&1 || true
if [ -f "$TEST_PROJECT/.opencode/rules/agmsg.md" ]; then
  first_line=$(head -1 "$TEST_PROJECT/.opencode/rules/agmsg.md" 2>/dev/null || true)
  if [ "$first_line" = "<!-- agmsg mode: both -->" ]; then
    if grep -q "PostToolUse" "$TEST_PROJECT/.opencode/rules/agmsg.md" 2>/dev/null; then
      # Self-arm block must be absent (both uses autostart entry now)
      if ! grep -q "agmsg monitor (session start)" "$TEST_PROJECT/.opencode/rules/agmsg.md" 2>/dev/null; then
        pass "both mode: rule file has correct marker, PostToolUse, no self-arm block"
      else
        fail_msg "both mode: rule file should not have self-arm block"
      fi
    else
      fail_msg "both mode: rule file missing PostToolUse section"
    fi
  else
    fail_msg "both mode: rule file marker is '$first_line'"
  fi
else
  fail_msg "both mode: rule file not created"
fi

# 3d. off mode — rule file must be removed
"$SCRIPTS_DIR/delivery.sh" set off opencode "$TEST_PROJECT" >/dev/null 2>&1 || true
if [ ! -f "$TEST_PROJECT/.opencode/rules/agmsg.md" ]; then
  pass "off mode: rule file removed"
else
  fail_msg "off mode: rule file still exists"
fi

# --- 4. monitor mode directive contains compound instance id and watch.sh opencode ---
echo "--- Item 4: monitor directive content ---"
output="$("$SCRIPTS_DIR/delivery.sh" set monitor opencode "$TEST_PROJECT" 2>&1 || true)"
# The directive should contain the AGMSG-DIRECTIVE header and watch.sh invocation.
if echo "$output" | grep -q "AGMSG-DIRECTIVE"; then
  if echo "$output" | grep -q "watch.sh.*opencode"; then
    pass "monitor directive contains watch.sh ... opencode"
  else
    echo "  directive: $(echo "$output" | grep -o 'AGMSG-DIRECTIVE.*' || true)"
    fail_msg "monitor directive missing watch.sh ... opencode"
  fi
else
  echo "  output: $output"
  fail_msg "monitor directive missing AGMSG-DIRECTIVE header"
fi

# --- 5. set off triggers directive and removes rule file ---
echo "--- Item 5: off mode teardown ---"
# First ensure a rule file exists
"$SCRIPTS_DIR/delivery.sh" set turn opencode "$TEST_PROJECT" >/dev/null 2>&1 || true
output="$("$SCRIPTS_DIR/delivery.sh" set off opencode "$TEST_PROJECT" 2>&1 || true)"
if [ ! -f "$TEST_PROJECT/.opencode/rules/agmsg.md" ]; then
  if echo "$output" | grep -q "AGMSG-DIRECTIVE"; then
    if echo "$output" | grep -qi "stop"; then
      pass "off mode removes rule file and emits stop directive"
    else
      fail_msg "off mode directive does not mention stop"
    fi
  else
    fail_msg "off mode does not emit AGMSG-DIRECTIVE"
  fi
else
  fail_msg "off mode did not remove rule file"
fi

# --- 6. monitor mode writes autostart entry to opencode.local.json ---
echo "--- Item 6: monitor mode writes opencode.local.json autostart entry ---"
if command -v jq >/dev/null 2>&1; then
  "$SCRIPTS_DIR/delivery.sh" set monitor opencode "$TEST_PROJECT" >/dev/null 2>&1 || true
  local_config="$(local_config_path "$TEST_PROJECT")"
  if [ -f "$local_config" ]; then
    desc=$(jq -r '.monitor.autostart[] | select(.description == "agmsg inbox stream") | .description' "$local_config" 2>/dev/null || true)
    pers=$(jq -r '.monitor.autostart[] | select(.description == "agmsg inbox stream") | .persistent' "$local_config" 2>/dev/null || true)
    cmd=$(jq -r '.monitor.autostart[] | select(.description == "agmsg inbox stream") | .command' "$local_config" 2>/dev/null || true)
    if [ "$desc" = "agmsg inbox stream" ] && [ "$pers" = "true" ] && [ -n "$cmd" ]; then
      pass "monitor mode: opencode.local.json has agmsg autostart entry with persistent=true"
    else
      echo "  desc=$desc pers=$pers cmd=$cmd"
      fail_msg "monitor mode: autostart entry missing or incomplete"
    fi
  else
    fail_msg "monitor mode: opencode.local.json not created"
  fi
else
  skip_msg "Item 6: jq not installed — cannot verify opencode.local.json"
fi

# --- 7. off mode removes autostart entry from opencode.local.json ---
echo "--- Item 7: off mode removes autostart entry ---"
if command -v jq >/dev/null 2>&1; then
  "$SCRIPTS_DIR/delivery.sh" set off opencode "$TEST_PROJECT" >/dev/null 2>&1 || true
  local_config="$(local_config_path "$TEST_PROJECT")"
  has_entry=0
  if [ -f "$local_config" ]; then
    has_entry=$(jq '[.monitor.autostart[]? | select(.description == "agmsg inbox stream")] | length' "$local_config" 2>/dev/null || echo 0)
  fi
  if [ "$has_entry" -eq 0 ]; then
    pass "off mode: agmsg autostart entry removed from opencode.local.json"
  else
    echo "  opencode.local.json content:"
    cat "$local_config"
    fail_msg "off mode: agmsg autostart entry still present"
  fi
else
  skip_msg "Item 7: jq not installed — cannot verify opencode.local.json"
fi

# --- 8. turn mode does NOT write autostart entry ---
echo "--- Item 8: turn mode does not modify opencode.local.json autostart ---"
if command -v jq >/dev/null 2>&1; then
  # Ensure clean state first
  "$SCRIPTS_DIR/delivery.sh" set off opencode "$TEST_PROJECT" >/dev/null 2>&1 || true
  "$SCRIPTS_DIR/delivery.sh" set turn opencode "$TEST_PROJECT" >/dev/null 2>&1 || true
  local_config="$(local_config_path "$TEST_PROJECT")"
  has_entry=0
  if [ -f "$local_config" ]; then
    has_entry=$(jq '[.monitor.autostart[]? | select(.description == "agmsg inbox stream")] | length' "$local_config" 2>/dev/null || echo 0)
  fi
  if [ "$has_entry" -eq 0 ]; then
    pass "turn mode: no agmsg autostart entry in opencode.local.json"
  else
    echo "  opencode.local.json content:"
    cat "$local_config"
    fail_msg "turn mode: unexpected agmsg autostart entry"
  fi
else
  skip_msg "Item 8: jq not installed — cannot verify opencode.local.json"
fi

# --- Summary ---
echo ""
echo "=== Results: $pass passed, $fail failed, $skip skipped ==="
if [ "$fail" -gt 0 ]; then exit 1; fi
