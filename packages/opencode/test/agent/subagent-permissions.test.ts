import { describe, test, expect } from "bun:test"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "@/permission"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import type { Agent } from "@/agent/agent"

const WORKTREE = "/repo"

function agentStub(permission: PermissionV1.Rule[]): Agent.Info {
  return {
    name: "reviewer",
    mode: "subagent",
    permission,
    options: {},
  }
}

describe("deriveSubagentSessionPermission", () => {
  test("files undefined leaves the ruleset byte-identical to before", () => {
    const parentSessionPermission: PermissionV1.Ruleset = [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: "/tmp/**", action: "allow" },
    ]
    const subagent = agentStub([])

    const explicit = deriveSubagentSessionPermission({
      parentSessionPermission,
      subagent,
      files: undefined,
      worktree: WORKTREE,
    })
    const omitted = deriveSubagentSessionPermission({ parentSessionPermission, subagent })

    const expected: PermissionV1.Ruleset = [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: "/tmp/**", action: "allow" },
      { permission: "todowrite", pattern: "*", action: "deny" },
      { permission: "task", pattern: "*", action: "deny" },
    ]
    expect(explicit).toEqual(expected)
    expect(omitted).toEqual(expected)
  })

  test("files: [] appends only a catch-all edit deny and hides edit tools", () => {
    const subagent = agentStub([
      { permission: "edit", pattern: "*", action: "allow" },
      { permission: "task", pattern: "*", action: "allow" },
    ])
    const ruleset = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      subagent,
      files: [],
      worktree: WORKTREE,
    })

    expect(ruleset.at(-1)).toEqual({ permission: "edit", pattern: "*", action: "deny" })
    expect(ruleset.filter((rule) => rule.permission === "edit")).toHaveLength(1)

    const merged = Permission.merge(subagent.permission, ruleset)
    const disabled = Permission.disabled(["edit", "write", "apply_patch", "bash"], merged)
    expect(disabled.has("edit")).toBe(true)
    expect(disabled.has("write")).toBe(true)
    expect(disabled.has("apply_patch")).toBe(true)
    expect(disabled.has("bash")).toBe(false)
  })

  test("files does not re-enable a subagent whose agent config wholesale-denies edit", () => {
    const subagent = agentStub([{ permission: "edit", pattern: "*", action: "deny" }])
    const ruleset = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      subagent,
      files: ["src/foo.ts", "test/foo.test.ts"],
      worktree: WORKTREE,
    })

    // The role lock wins: only the catch-all deny is appended, no allows.
    expect(ruleset.at(-1)).toEqual({ permission: "edit", pattern: "*", action: "deny" })
    expect(ruleset.filter((rule) => rule.permission === "edit" && rule.action === "allow")).toHaveLength(0)

    const merged = Permission.merge(subagent.permission, ruleset)
    expect(Permission.evaluate("edit", "src/foo.ts", merged).action).toBe("deny")
    expect(Permission.evaluate("edit", "test/foo.test.ts", merged).action).toBe("deny")
    expect(Permission.evaluate("edit", "src/other.ts", merged).action).toBe("deny")

    const disabled = Permission.disabled(["edit", "write", "apply_patch"], merged)
    expect(disabled.has("edit")).toBe(true)
    expect(disabled.has("write")).toBe(true)
    expect(disabled.has("apply_patch")).toBe(true)
  })

  test("files overrides a partial agent ruleset whose last edit rule is not a bare * deny", () => {
    const subagent = agentStub([
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "docs/**", action: "allow" },
    ])
    const ruleset = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      subagent,
      files: ["src/foo.ts"],
      worktree: WORKTREE,
    })
    const merged = Permission.merge(subagent.permission, ruleset)

    // Not edit-locked (last edit match is docs/** allow), so the explicit
    // grant applies: in-scope allowed, everything else — including the
    // agent's own docs/** allow — denied by the appended catch-all.
    expect(Permission.evaluate("edit", "src/foo.ts", merged).action).toBe("allow")
    expect(Permission.evaluate("edit", "docs/readme.md", merged).action).toBe("deny")
    expect(Permission.evaluate("edit", "src/bar.ts", merged).action).toBe("deny")
  })

  test("out-of-scope file is denied even though the child's own agent config allows edit", () => {
    const subagent = agentStub([{ permission: "edit", pattern: "*", action: "allow" }])
    const ruleset = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      subagent,
      files: ["src/foo.ts"],
      worktree: WORKTREE,
    })
    const merged = Permission.merge(subagent.permission, ruleset)

    expect(Permission.evaluate("edit", "src/foo.ts", merged).action).toBe("allow")
    expect(Permission.evaluate("edit", "src/bar.ts", merged).action).toBe("deny")
    expect(Permission.evaluate("edit", "test/other.ts", merged).action).toBe("deny")
  })

  test("an in-scope path that the child's own config already allowed evaluates the same as without files", () => {
    const subagent = agentStub([{ permission: "edit", pattern: "*", action: "allow" }])
    const withoutFiles = Permission.merge(
      subagent.permission,
      deriveSubagentSessionPermission({ parentSessionPermission: [], subagent }),
    )
    const withFiles = Permission.merge(
      subagent.permission,
      deriveSubagentSessionPermission({
        parentSessionPermission: [],
        subagent,
        files: ["src/foo.ts"],
        worktree: WORKTREE,
      }),
    )

    expect(Permission.evaluate("edit", "src/foo.ts", withoutFiles).action).toBe("allow")
    expect(Permission.evaluate("edit", "src/foo.ts", withFiles).action).toBe("allow")
  })

  test("a glob entry scopes an entire directory tree", () => {
    const subagent = agentStub([])
    const ruleset = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      subagent,
      files: ["src/**"],
      worktree: WORKTREE,
    })
    const merged = Permission.merge(subagent.permission, ruleset)

    expect(Permission.evaluate("edit", "src/nested/deep/file.ts", merged).action).toBe("allow")
    expect(Permission.evaluate("edit", "test/file.ts", merged).action).toBe("deny")
  })

  test("a plain path entry also allows the directory form for nested files", () => {
    const subagent = agentStub([])
    const ruleset = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      subagent,
      files: ["src/foo"],
      worktree: WORKTREE,
    })

    expect(ruleset.filter((rule) => rule.action === "allow")).toEqual([
      { permission: "edit", pattern: "src/foo", action: "allow" },
      { permission: "edit", pattern: "src/foo/**", action: "allow" },
    ])

    const merged = Permission.merge(subagent.permission, ruleset)
    expect(Permission.evaluate("edit", "src/foo", merged).action).toBe("allow")
    expect(Permission.evaluate("edit", "src/foo/nested.ts", merged).action).toBe("allow")
    expect(Permission.evaluate("edit", "src/foobar", merged).action).toBe("deny")
  })

  test("an absolute file path is resolved against the worktree", () => {
    const subagent = agentStub([])
    const ruleset = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      subagent,
      files: [`${WORKTREE}/src/foo.ts`],
      worktree: WORKTREE,
    })
    const merged = Permission.merge(subagent.permission, ruleset)

    expect(Permission.evaluate("edit", "src/foo.ts", merged).action).toBe("allow")
  })
})
