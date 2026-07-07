import { describe, expect, test } from "bun:test"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { modeCycle, modeDecision, modeIndicator, modeLabel } from "@/cli/cmd/run/mode.shared"

function request(input: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "perm-1",
    sessionID: "session-1",
    permission: "edit",
    patterns: [],
    metadata: {},
    always: [],
    ...input,
  }
}

describe("run mode shared", () => {
  test("cycles between the two p1 modes", () => {
    expect(modeCycle("normal")).toBe("accept-edits")
    expect(modeCycle("accept-edits")).toBe("normal")
  })

  test("normal mode always asks", () => {
    expect(modeDecision("normal", request())).toBe("ask")
    expect(modeDecision("normal", request({ permission: "bash" }))).toBe("ask")
  })

  test("accept-edits mode auto-allows only edit permissions", () => {
    expect(modeDecision("accept-edits", request({ permission: "edit" }))).toBe("allow")
    expect(modeDecision("accept-edits", request({ permission: "bash" }))).toBe("ask")
    expect(modeDecision("accept-edits", request({ permission: "read" }))).toBe("ask")
  })

  test("labels normal mode as empty and accept-edits as visible", () => {
    expect(modeLabel("normal")).toBe("")
    expect(modeLabel("accept-edits").length).toBeGreaterThan(0)
  })

  test("indicator is hidden in normal mode and visible in accept-edits", () => {
    expect(modeIndicator("normal")).toEqual({ visible: false, label: "" })
    expect(modeIndicator("accept-edits").visible).toBe(true)
    expect(modeIndicator("accept-edits").label).toBe(modeLabel("accept-edits"))
  })
})
