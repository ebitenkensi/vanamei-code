import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "@/permission"
import type { Agent } from "./agent"
import path from "path"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent session's deny rules and external_directory rules.
 *    Parent agent restrictions only govern that agent; the subagent's own
 *    permissions determine its capabilities.
 * 2. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 * 3. When `files` is set, a trailing file-scope block (see `fileScopeRules`).
 *
 * Session permission is merged after agent permission at ask time
 * (session/tools.ts), and evaluation is last-match-wins (permission/index.ts
 * `evaluate()`), so everything this function returns outranks both the
 * parent's own rules copied in above and the subagent's agent-level config.
 * `files` scopes DOWN an editing delegate: as an explicit grant from the
 * caller of task(), its per-file allows may override partial agent rules
 * (e.g. a deny for one directory). It never re-enables a subagent whose edit
 * tools are wholesale-denied at agent level (the `Permission.disabled`
 * criterion) — that deny is a role-identity lock, not a scoping rule, so
 * such a child stays read-only regardless of the files list.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
  files?: readonly string[]
  worktree?: string
}): PermissionV1.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  const base: PermissionV1.Ruleset = [
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
  if (input.files === undefined) return base
  if (Permission.disabled(["edit"], input.subagent.permission).has("edit"))
    return [...base, { permission: "edit", pattern: "*", action: "deny" }]
  return [...base, ...fileScopeRules(input.files, input.worktree ?? "")]
}

/**
 * `files: []` yields just the catch-all deny, which is also what
 * `Permission.disabled()` looks for to hide edit/write/apply_patch from the
 * child entirely (read-only delegate). A non-empty list appends per-file
 * allows after the deny, so the tools stay visible and only paths outside
 * the list are denied.
 */
function fileScopeRules(files: readonly string[], worktree: string): PermissionV1.Ruleset {
  return [
    { permission: "edit", pattern: "*", action: "deny" },
    ...files.flatMap((file) => allowRulesFor(resolveFilePattern(worktree, file))),
  ]
}

// edit/write/apply_patch pass `ctx.ask` a pattern relative to the project's
// worktree, never absolute (see tool/edit.ts, tool/write.ts,
// tool/apply_patch.ts, all doing `path.relative(instance.worktree, ...)`).
// A `files` entry is normalized the same way so patterns compare equal:
// resolved against worktree if relative, then re-relativized (this also
// handles a caller passing an absolute path by mistake).
function resolveFilePattern(worktree: string, file: string): string {
  const trimmed = file.endsWith("/") ? file.slice(0, -1) : file
  const absolute = path.isAbsolute(trimmed) ? trimmed : path.join(worktree, trimmed)
  return path.relative(worktree, absolute).replaceAll("\\", "/")
}

// A plain (non-glob) entry might name a directory rather than a single file,
// so it also gets a `<pattern>/**` allow for anything nested under it. An
// entry that already contains a glob is trusted as-is.
function allowRulesFor(pattern: string): PermissionV1.Rule[] {
  const patterns = pattern.includes("*") ? [pattern] : [pattern, `${pattern}/**`]
  return patterns.map((pattern) => ({ permission: "edit" as const, pattern, action: "allow" as const }))
}
