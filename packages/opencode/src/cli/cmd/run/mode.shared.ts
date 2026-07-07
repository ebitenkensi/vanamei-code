// Pure state machine for permission modes in direct interactive mode.
//
// Lives outside the JSX component so it can be tested independently. P1 only
// supports the two-state cycle `normal ⇄ accept-edits`. P3 will add `auto` to
// the cycle array and `judge` to the decision result; both are documented with
// comments so the diff stays small.
import type { PermissionRequest } from "@opencode-ai/sdk/v2"

// P1: "normal" | "accept-edits". P3 adds "auto" to the cycle below.
export type PermissionMode = "normal" | "accept-edits"

// Cycle order used by modeCycle(). Adding "auto" in P3 is a single-line change.
const MODE_CYCLE: readonly PermissionMode[] = ["normal", "accept-edits"]

// P1: returns "ask" | "allow". P3 will add "judge" to the union.
type ModeDecision = "ask" | "allow"

export function modeCycle(mode: PermissionMode): PermissionMode {
  const index = MODE_CYCLE.indexOf(mode)
  return MODE_CYCLE[(index + 1) % MODE_CYCLE.length] ?? "normal"
}

export function modeDecision(mode: PermissionMode, request: PermissionRequest): ModeDecision {
  if (mode === "accept-edits" && request.permission === "edit") {
    return "allow"
  }

  return "ask"
}

export function modeLabel(mode: PermissionMode): string {
  if (mode === "accept-edits") {
    return "⏵⏵ accept edits on"
  }

  return ""
}

export function modeIndicator(mode: PermissionMode): { visible: boolean; label: string } {
  if (mode === "accept-edits") {
    return { visible: true, label: modeLabel(mode) }
  }

  return { visible: false, label: "" }
}
