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

pass() { pass=$((pass+1)); echo "PASS: $1"; }
fail_msg() { fail=$((fail+1)); echo "FAIL: $1"; }

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

# 3b. monitor mode
"$SCRIPTS_DIR/delivery.sh" set monitor opencode "$TEST_PROJECT" >/dev/null 2>&1 || true
if [ -f "$TEST_PROJECT/.opencode/rules/agmsg.md" ]; then
  first_line=$(head -1 "$TEST_PROJECT/.opencode/rules/agmsg.md" 2>/dev/null || true)
  if [ "$first_line" = "<!-- agmsg mode: monitor -->" ]; then
    # PostToolUse should be absent for monitor mode (just the marker)
    if ! grep -q "PostToolUse" "$TEST_PROJECT/.opencode/rules/agmsg.md" 2>/dev/null; then
      pass "monitor mode: rule file has correct marker and no PostToolUse section"
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
      pass "both mode: rule file has correct marker and PostToolUse section"
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

# --- Summary ---
echo ""
echo "=== Results: $pass passed, $fail failed ==="
if [ "$fail" -gt 0 ]; then exit 1; fi
