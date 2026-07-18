// UI gallery for the direct-mode inline run UI.
//
// Headlessly renders every canonical footer/panel UI state (permission
// prompts, question prompts, panel bodies, the todo list, ...) with fixed,
// deterministic fixture data and writes the plain-text frame dumps to
// test/cli/run/__gallery__/. These text frames let humans and LLMs review UI
// changes as ordinary text diffs instead of screenshots.
//
// `--visual` additionally renders color-faithful HTML (and, if a headless
// Chrome binary is available, PNG screenshots) of every state to
// .artifacts/ui-gallery/, for reviewers who want to see actual colors instead
// of a plain-text frame dump.
//
// Usage (run from packages/opencode):
//   bun run ui-gallery              # regenerate the committed frame dumps
//   bun run ui-gallery -- --check   # verify the committed dumps match, exit 1 on drift
//   bun run ui-gallery -- --visual  # also render HTML/PNG previews to .artifacts/ui-gallery/
/** @jsxImportSource @opentui/solid */
import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createSignal, type JSX } from "solid-js"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { TextAttributes, getBaseAttributes, type CapturedFrame, type CapturedSpan } from "@opentui/core"
import type { PermissionRequest, QuestionRequest, ToolPart } from "@opencode-ai/sdk/v2"
import { resolve } from "@/cli/ui/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "@/cli/ui/keymap"
import { entryBody } from "@/cli/cmd/run/entry.body"
import {
  RUN_COMMAND_PANEL_ROWS,
  RUN_SUBAGENT_PANEL_ROWS,
  RunCommandMenuBody,
  RunModelSelectBody,
  RunQueuedPromptSelectBody,
  RunSkillSelectBody,
  RunSubagentSelectBody,
  RunVariantSelectBody,
} from "@/cli/cmd/run/footer.command"
import { RunSessionSelectBody } from "@/cli/cmd/run/footer.sessions"
import { RunFooterView } from "@/cli/cmd/run/footer.view"
import { RunEntryContent, toolResultBody } from "@/cli/cmd/run/scrollback.writer"
import { RUN_THEME_FALLBACK } from "@/cli/cmd/run/theme"
import type {
  FooterQueuedPrompt,
  FooterSessionTab,
  FooterState,
  FooterSubagentDetail,
  FooterSubagentState,
  FooterSubagentTab,
  FooterTodoItem,
  FooterView,
  RunAgent,
  RunCommand,
  RunEntryBody,
  RunProvider,
  StreamCommit,
} from "@/cli/cmd/run/types"

const OUT_DIR = path.join(import.meta.dir, "..", "test", "cli", "run", "__gallery__")
const VISUAL_DIR = path.join(import.meta.dir, "..", ".artifacts", "ui-gallery")
const WIDTHS = [80, 120] as const

const tuiConfig = resolve({}, { terminalSuspend: true })

// ---------------------------------------------------------------------------
// Fixture builders (fixed, deterministic -- no timestamps, no cwd/home paths)
// ---------------------------------------------------------------------------

const DEMO_ROOT = "/opt/opencode-demo"

function command(input: { name: string; description: string; source?: "command" | "mcp" | "skill" }): RunCommand {
  return {
    name: input.name,
    description: input.description,
    source: input.source,
    template: "",
    hints: [],
  } as RunCommand
}

function model(input: {
  id: string
  name: string
  status?: "active" | "deprecated"
  cost?: number
  variants?: Record<string, Record<string, never>>
}): RunProvider["models"][string] {
  return {
    id: input.id,
    providerID: "opencode",
    api: {
      id: "opencode",
      url: "https://opencode.ai",
      npm: "@ai-sdk/openai-compatible",
    },
    name: input.name,
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: input.cost ?? 1, output: 1, cache: { read: 0, write: 0 } },
    limit: { context: 128000, output: 8192 },
    status: input.status ?? "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    variants: input.variants,
  } as RunProvider["models"][string]
}

function provider(): RunProvider {
  return {
    id: "opencode",
    name: "opencode",
    source: "api",
    env: [],
    options: {},
    models: {
      "gpt-5": model({ id: "gpt-5", name: "GPT-5", variants: { high: {}, minimal: {} } }),
      "gpt-free": model({ id: "gpt-free", name: "GPT Free", cost: 0 }),
      old: model({ id: "old", name: "Old Model", status: "deprecated" }),
    },
  } as RunProvider
}

function agent(input: {
  name: string
  mode: RunAgent["mode"]
  description?: string
  budget?: { soft?: number; hard?: number }
}): RunAgent {
  return {
    name: input.name,
    description: input.description,
    mode: input.mode,
    permission: [],
    options: {},
    budget: input.budget,
  } as RunAgent
}

function subagentTab(input: {
  sessionID: string
  label: string
  description: string
  status?: FooterSubagentTab["status"]
  activity?: string
  cost?: number
}): FooterSubagentTab {
  return {
    sessionID: input.sessionID,
    partID: `part-${input.sessionID}`,
    callID: `call-${input.sessionID}`,
    label: input.label,
    description: input.description,
    status: input.status ?? "running",
    lastUpdatedAt: 1,
    activity: input.activity,
    cost: input.cost,
  }
}

function footerState(input: Partial<FooterState> = {}): FooterState {
  return {
    phase: "idle",
    status: "",
    queue: 0,
    model: "gpt-5",
    agent: "build",
    duration: "",
    contextTokens: 0,
    contextPercent: null,
    cost: 0,
    modified: 0,
    first: false,
    interrupt: 0,
    exit: 0,
    permissionMode: "normal",
    judging: false,
    automode: undefined,
    ...input,
  }
}

function emptySubagentState(): FooterSubagentState {
  return { tabs: [], details: {}, permissions: [], questions: [] }
}

const SAMPLE_COMMANDS: RunCommand[] = [
  command({ name: "review", description: "Review code" }),
  command({ name: "deploy", description: "Deploy the current branch", source: "mcp" }),
  command({ name: "formatter", description: "Apply formatter fixes", source: "skill" }),
  command({ name: "changelog", description: "Draft a changelog entry", source: "skill" }),
]

const SAMPLE_AGENTS: RunAgent[] = [
  agent({ name: "build", mode: "primary", description: "General coding agent" }),
  agent({ name: "plan", mode: "primary", description: "Planning without edits" }),
]

// Budget-carrying agent (P4): soft/hard denominators for the statusline
// budget pill gallery states below. Deliberately not in SAMPLE_AGENTS so
// unrelated footer states keep rendering the plain (non-budget) cost pill.
const BUDGET_AGENT: RunAgent = agent({
  name: "budget-build",
  mode: "primary",
  description: "Budget-tracked coding agent",
  budget: { soft: 1.5, hard: 2.5 },
})

const SAMPLE_TODOS: FooterTodoItem[] = [
  { status: "completed", content: "Set up project" },
  { status: "in_progress", content: "Implement feature" },
  { status: "pending", content: "Write tests" },
]

const SAMPLE_QUEUED: FooterQueuedPrompt[] = [
  { messageID: "m-1", partID: "p-1", prompt: { text: "fix the auth test", parts: [] } },
  { messageID: "m-2", partID: "p-2", prompt: { text: "add regression coverage for the parser", parts: [] } },
]

// RunSessionSelectBody formats "updated" as a relative time against
// Date.now() with no way to inject "now" through props, so the panel.sessions
// case has to freeze the clock (see withFixedClock) around its render. The
// session timestamps are offsets from that frozen instant, not real time.
const FIXED_NOW = 1_700_000_000_000
const SAMPLE_SESSIONS: FooterSessionTab[] = [
  { sessionID: "s-1", title: "Fix the auth bug", updated: FIXED_NOW - 45 * 60_000 },
  { sessionID: "s-2", title: "Refactor the parser", updated: FIXED_NOW - 5 * 60_000 },
  { sessionID: "s-3", title: undefined, updated: FIXED_NOW - 2 * 60 * 60_000 },
]

async function withFixedClock<T>(now: number, fn: () => Promise<T>): Promise<T> {
  const original = Date.now
  Date.now = () => now
  try {
    return await fn()
  } finally {
    Date.now = original
  }
}

const SAMPLE_SUBAGENT_TABS: FooterSubagentTab[] = [
  subagentTab({ sessionID: "sub-1", label: "Explore", description: "Inspect auth flow", status: "running" }),
  subagentTab({ sessionID: "sub-2", label: "General", description: "Migrate config schema", status: "completed" }),
]

// Footer tree fixture: a running tab carrying an `activity` line (as the
// footer tree derives from the child session's most recent tool commit) and a
// completed tab, so the gallery shows both the spinner/activity row and the
// static "Done" row.
const SAMPLE_SUBAGENT_TREE_TABS: FooterSubagentTab[] = [
  subagentTab({
    sessionID: "sub-1",
    label: "Explore",
    description: "Inspect auth flow",
    status: "running",
    activity: 'Grep("SessionExecution")',
  }),
  subagentTab({ sessionID: "sub-2", label: "General", description: "Migrate config schema", status: "completed" }),
]

// Same tree fixture as above, but each task row also carries an accumulated
// child-session cost (P4), muted at the row end.
const SAMPLE_SUBAGENT_TREE_COST_TABS: FooterSubagentTab[] = [
  subagentTab({
    sessionID: "sub-1",
    label: "Explore",
    description: "Inspect auth flow",
    status: "running",
    activity: 'Grep("SessionExecution")',
    cost: 0.03,
  }),
  subagentTab({
    sessionID: "sub-2",
    label: "General",
    description: "Migrate config schema",
    status: "completed",
    cost: 0.11,
  }),
]

// entryBody() (entry.body.ts) only renders "assistant"/"tool" commits for
// certain phase/status combinations -- "progress" is the simplest phase that
// always renders raw text for both kinds, so the sample uses that here.
const SAMPLE_SUBAGENT_COMMITS: StreamCommit[] = [
  { kind: "user", text: "Migrate config schema to v2", phase: "start", source: "system" },
  {
    kind: "tool",
    text: "",
    phase: "start",
    source: "tool",
    messageID: "sub-msg-1",
    partID: "sub-part-1",
    tool: "bash",
    shell: { callID: "sub-call-1", command: "bun test test/config/schema.test.ts" },
  },
  {
    kind: "assistant",
    text: "Schema migrated; tests passing.",
    phase: "progress",
    source: "assistant",
    messageID: "sub-msg-1",
    partID: "sub-part-2",
  },
]

const SAMPLE_SUBAGENT_DETAILS: Record<string, FooterSubagentDetail> = {
  "sub-2": { sessionID: "sub-2", commits: SAMPLE_SUBAGENT_COMMITS },
}

function permissionRequest(input: {
  id: string
  permission: string
  patterns: string[]
  always: string[]
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
}): PermissionRequest {
  return {
    id: input.id,
    sessionID: "session-demo",
    permission: input.permission,
    patterns: input.patterns,
    always: input.always,
    metadata: {
      ...(input.metadata ?? {}),
      ...(input.input ? { input: input.input } : {}),
    },
  }
}

const PERMISSION_REQUESTS: Record<string, PermissionRequest> = {
  edit: permissionRequest({
    id: "perm-edit",
    permission: "edit",
    patterns: [`${DEMO_ROOT}/src/format.ts`],
    always: [`${DEMO_ROOT}/src/format.ts`],
    input: {
      filePath: `${DEMO_ROOT}/src/format.ts`,
      filepath: `${DEMO_ROOT}/src/format.ts`,
      diff: "@@ -1,2 +1,2 @@\n-export const demo = 1\n+export const demo = 42\n context line\n",
    },
  }),
  bash: permissionRequest({
    id: "perm-bash",
    permission: "bash",
    patterns: ["git status --short"],
    always: ["*"],
    input: {
      command: "git status --short",
      workdir: DEMO_ROOT,
      description: "Inspect worktree changes",
    },
  }),
  read: permissionRequest({
    id: "perm-read",
    permission: "read",
    patterns: [`${DEMO_ROOT}/package.json`],
    always: [`${DEMO_ROOT}/package.json`],
    input: {
      filePath: `${DEMO_ROOT}/package.json`,
      offset: 1,
      limit: 80,
    },
  }),
  task: permissionRequest({
    id: "perm-task",
    permission: "task",
    patterns: ["explore"],
    always: ["*"],
    input: {
      description: "Inspect footer spacing across direct-mode prompts",
      subagent_type: "explore",
    },
  }),
  external: permissionRequest({
    id: "perm-external",
    permission: "external_directory",
    patterns: ["/opt/shared-demo/**"],
    always: ["/opt/shared-demo/**"],
    metadata: {
      parentDir: "/opt/shared-demo",
      filepath: "/opt/shared-demo/README.md",
    },
  }),
  doom: permissionRequest({
    id: "perm-doom",
    permission: "doom_loop",
    patterns: ["*"],
    always: ["*"],
  }),
}

function questionRequest(id: string, questions: QuestionRequest["questions"]): QuestionRequest {
  return { id, sessionID: "session-demo", questions }
}

const QUESTION_REQUESTS: Record<string, QuestionRequest> = {
  multi: questionRequest("question-multi", [
    {
      header: "Layout",
      question: "Which footer view should stay active while testing?",
      options: [
        { label: "Prompt", description: "Return to prompt" },
        { label: "Question", description: "Keep question open" },
      ],
      multiple: false,
    },
    {
      header: "Rows",
      question: "Pick formatting previews",
      options: [
        { label: "Diff", description: "Emit edit diff" },
        { label: "Task", description: "Emit task card" },
        { label: "Todo", description: "Emit todo card" },
      ],
      multiple: true,
      custom: true,
    },
  ]),
  single: questionRequest("question-single", [
    {
      header: "Mode",
      question: "Which footer should be the reference for spacing checks?",
      options: [
        { label: "Permission", description: "Inspect the permission footer" },
        { label: "Question", description: "Keep this question footer open" },
        { label: "Prompt", description: "Return to the normal composer" },
      ],
      multiple: false,
      custom: false,
    },
  ]),
  checklist: questionRequest("question-checklist", [
    {
      header: "Checks",
      question: "Select the direct-mode cases you want to inspect next",
      options: [
        { label: "Diff", description: "Show an edit diff in the footer" },
        { label: "Task", description: "Show a structured task summary" },
        { label: "Todo", description: "Show a todo snapshot" },
        { label: "Error", description: "Show an error transcript row" },
      ],
      multiple: true,
      custom: false,
    },
  ]),
  custom: questionRequest("question-custom", [
    {
      header: "Reply",
      question: "What custom answer should appear in the footer preview?",
      options: [
        { label: "Short note", description: "Keep the answer to one line" },
        { label: "Wrapped note", description: "Use a longer answer to test wrapping" },
      ],
      multiple: false,
      custom: true,
    },
  ]),
}

// ---------------------------------------------------------------------------
// Scrollback entry fixtures (phase 1.5)
//
// StreamCommit is the reducer's output shape (session-data.ts -> entryBody in
// entry.body.ts), so these fixtures are built directly as StreamCommit/ToolPart
// values rather than replayed through the demo-mode event pipeline in
// src/cli/cmd/run/demo.ts -- that file is a slash-command harness for a live
// session, not something this script imports from or mutates. Sample text
// content below is copied by hand from demo.ts's SAMPLE_MARKDOWN/SAMPLE_TABLE
// so the gallery's markdown/table states match what /fmt renders.
//
// entryBody() phase trap (see entry.body.ts): "assistant" and "reasoning"
// commits only render their text at phase "progress" -- phase "final" always
// collapses to RUN_ENTRY_NONE unless `interrupted` is set. So markdown/table/
// text/reasoning fixtures below all use phase "progress". Tool commits render
// in two steps like real scrollback: the phase "start" commit becomes the
// `● ToolName(args)` header, and the completion commit hangs the result under
// it -- write/edit/apply_patch/task/todowrite/question emit their structured
// snapshot at phase "final" with toolState "completed" (toolStructuredFinal()
// in tool.ts gates on exactly that combination), while a completed bash entry
// is conventionally modeled at phase "progress" with toolState "completed"
// (see entry.body.test.ts) and gets the "  ⎿  " hanging block. Tool cases
// below therefore feed [start, completion] commit sequences to the renderer.
// ---------------------------------------------------------------------------

function toolPart(input: {
  id: string
  messageID: string
  callID: string
  tool: string
  state: ToolPart["state"]
}): ToolPart {
  return {
    id: input.id,
    sessionID: "session-demo",
    messageID: input.messageID,
    type: "tool",
    callID: input.callID,
    tool: input.tool,
    state: input.state,
  }
}

// Derives the phase "start" commit that precedes a tool completion commit in
// real scrollback -- it renders the `● ToolName(args)` header line. Reuses the
// completion part's input (and metadata, which header functions like Patch's
// file count read) with a running status.
function toolStartOf(commit: StreamCommit): StreamCommit {
  const part = commit.part!
  return {
    kind: "tool",
    text: "",
    phase: "start",
    source: "tool",
    tool: commit.tool,
    toolState: "running",
    messageID: commit.messageID,
    partID: commit.partID,
    part: toolPart({
      id: part.id,
      messageID: part.messageID,
      callID: part.callID,
      tool: part.tool,
      state: {
        status: "running",
        input: "input" in part.state ? part.state.input : undefined,
        metadata: "metadata" in part.state ? part.state.metadata : undefined,
        time: { start: 1 },
      } as ToolPart["state"],
    }),
  }
}

// Copied from demo.ts's SAMPLE_MARKDOWN (not imported -- see note above).
const SCROLLBACK_MARKDOWN_TEXT = [
  "# Direct Mode Demo",
  "",
  "This is a realistic assistant response for direct-mode formatting checks.",
  "It mixes **bold**, _italic_, `inline code`, links, code fences, and tables in one streamed reply.",
  "",
  "## Summary",
  "",
  "- Restored the final markdown flush so the last block is committed on idle.",
  "- Switched markdown scrollback commits back to top-level block boundaries.",
  "- Added footer-level regression coverage for split-footer rendering.",
  "",
  "## Status",
  "",
  "| Area | Before | After | Notes |",
  "| --- | --- | --- | --- |",
  "| Direct mode | Missing final rows | Stable | Final markdown block now flushes on idle |",
  "| Tables | Dropped in streaming mode | Visible | Block-based commits match the working OpenTUI demo |",
  "| Tests | Partial coverage | Broader coverage | Includes a footer-level split render capture |",
  "",
  "> This sample intentionally includes a wide table so you can spot wrapping and commit bugs quickly.",
  "",
  "```ts",
  "const result = { markdown: true, tables: 2, stable: true }",
  "```",
  "",
  "## Files",
  "",
  "| File | Change |",
  "| --- | --- |",
  "| `scrollback.surface.ts` | Align markdown commit logic with the split-footer demo |",
  "| `footer.ts` | Keep active surfaces across footer-height-only resizes |",
  "| `footer.test.ts` | Capture real split-footer markdown payloads during idle completion |",
  "",
  "Next step: run `/fmt table` if you want a tighter table-only sample.",
].join("\n")

// Copied from demo.ts's SAMPLE_TABLE (not imported -- see note above).
const SCROLLBACK_TABLE_TEXT = [
  "# Table Sample",
  "",
  "| Kind | Example | Notes |",
  "| --- | --- | --- |",
  "| Pipe | `A\\|B` | Escaped pipes should stay in one cell |",
  "| Unicode | `漢字` | Wide characters should remain aligned |",
  "| Wrap | `LongTokenWithoutNaturalBreaks_1234567890` | Useful for width stress |",
  "| Status | done | Final row should still appear after idle |",
].join("\n")

const SCROLLBACK_TEXT_TEXT = [
  "Reworked the reducer to coalesce streaming deltas before they reach the footer queue.",
  "The footer now flushes once per animation frame instead of once per SDK event, which keeps",
  "direct mode responsive under heavy tool output. No public API changed -- only the internal",
  "scheduling loop moved.",
].join(" ")

const SCROLLBACK_REASONING_TEXT =
  "Thinking: check whether the footer coalescing change affects paste latency before landing it."

const SCROLLBACK_MARKDOWN_COMMIT: StreamCommit = {
  kind: "assistant",
  text: SCROLLBACK_MARKDOWN_TEXT,
  phase: "progress",
  source: "assistant",
  messageID: "msg-scrollback-markdown",
  partID: "part-scrollback-markdown",
}

const SCROLLBACK_TABLE_COMMIT: StreamCommit = {
  kind: "assistant",
  text: SCROLLBACK_TABLE_TEXT,
  phase: "progress",
  source: "assistant",
  messageID: "msg-scrollback-table",
  partID: "part-scrollback-table",
}

const SCROLLBACK_TEXT_COMMIT: StreamCommit = {
  kind: "assistant",
  text: SCROLLBACK_TEXT_TEXT,
  phase: "progress",
  source: "assistant",
  messageID: "msg-scrollback-text",
  partID: "part-scrollback-text",
}

const SCROLLBACK_REASONING_COMMIT: StreamCommit = {
  kind: "reasoning",
  text: SCROLLBACK_REASONING_TEXT,
  phase: "progress",
  source: "reasoning",
  messageID: "msg-scrollback-reasoning",
  partID: "part-scrollback-reasoning",
}

const SCROLLBACK_BASH_COMMAND = "git status --short"
const SCROLLBACK_BASH_OUTPUT_BODY = [" M src/format.ts", "?? src/demo-notes.md"].join("\n")
const SCROLLBACK_BASH_RAW = [DEMO_ROOT, SCROLLBACK_BASH_COMMAND, SCROLLBACK_BASH_OUTPUT_BODY, ""].join("\n")

const SCROLLBACK_BASH_COMMIT: StreamCommit = {
  kind: "tool",
  text: SCROLLBACK_BASH_RAW,
  phase: "progress",
  source: "tool",
  tool: "bash",
  toolState: "completed",
  messageID: "msg-scrollback-bash",
  partID: "part-scrollback-bash",
  part: toolPart({
    id: "part-scrollback-bash",
    messageID: "msg-scrollback-bash",
    callID: "call-scrollback-bash",
    tool: "bash",
    state: {
      status: "completed",
      input: { command: SCROLLBACK_BASH_COMMAND, workdir: DEMO_ROOT, description: "Inspect worktree changes" },
      output: SCROLLBACK_BASH_RAW,
      title: SCROLLBACK_BASH_COMMAND,
      metadata: { exitCode: 0 },
      time: { start: 1, end: 2 },
    },
  }),
}

// Exercises the committed-text truncation path: 8 output lines collapse to the
// first 5 plus a muted "… +3 lines" notice (see toolResultBody in
// scrollback.writer.tsx).
const SCROLLBACK_BASH_LONG_COMMAND = "git log --oneline -n 8"
const SCROLLBACK_BASH_LONG_BODY = Array.from(
  { length: 8 },
  (_, i) => `${(1000 + i).toString(16)} commit ${i + 1}`,
).join("\n")
const SCROLLBACK_BASH_LONG_RAW = [SCROLLBACK_BASH_LONG_COMMAND, SCROLLBACK_BASH_LONG_BODY, ""].join("\n")

const SCROLLBACK_BASH_LONG_COMMIT: StreamCommit = {
  kind: "tool",
  text: SCROLLBACK_BASH_LONG_RAW,
  phase: "progress",
  source: "tool",
  tool: "bash",
  toolState: "completed",
  messageID: "msg-scrollback-bash-long",
  partID: "part-scrollback-bash-long",
  part: toolPart({
    id: "part-scrollback-bash-long",
    messageID: "msg-scrollback-bash-long",
    callID: "call-scrollback-bash-long",
    tool: "bash",
    state: {
      status: "completed",
      input: { command: SCROLLBACK_BASH_LONG_COMMAND, description: "List recent commits" },
      output: SCROLLBACK_BASH_LONG_RAW,
      title: SCROLLBACK_BASH_LONG_COMMAND,
      metadata: { exitCode: 0 },
      time: { start: 1, end: 2 },
    },
  }),
}

const SCROLLBACK_WRITE_FILE = `${DEMO_ROOT}/src/demo-format.ts`

const SCROLLBACK_WRITE_COMMIT: StreamCommit = {
  kind: "tool",
  text: "",
  phase: "final",
  source: "tool",
  tool: "write",
  toolState: "completed",
  messageID: "msg-scrollback-write",
  partID: "part-scrollback-write",
  part: toolPart({
    id: "part-scrollback-write",
    messageID: "msg-scrollback-write",
    callID: "call-scrollback-write",
    tool: "write",
    state: {
      status: "completed",
      input: { filePath: SCROLLBACK_WRITE_FILE, content: "export const demo = 42\n" },
      output: "",
      title: "",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }),
}

const SCROLLBACK_EDIT_FILE = `${DEMO_ROOT}/src/demo-format.ts`
const SCROLLBACK_EDIT_DIFF = "@@ -1,2 +1,2 @@\n-export const demo = 1\n+export const demo = 42\n context line\n"

const SCROLLBACK_EDIT_COMMIT: StreamCommit = {
  kind: "tool",
  text: "",
  phase: "final",
  source: "tool",
  tool: "edit",
  toolState: "completed",
  messageID: "msg-scrollback-edit",
  partID: "part-scrollback-edit",
  part: toolPart({
    id: "part-scrollback-edit",
    messageID: "msg-scrollback-edit",
    callID: "call-scrollback-edit",
    tool: "edit",
    state: {
      status: "completed",
      input: { filePath: SCROLLBACK_EDIT_FILE },
      output: "",
      title: "",
      metadata: { diff: SCROLLBACK_EDIT_DIFF },
      time: { start: 1, end: 2 },
    },
  }),
}

// metadata.files[].patch (not .diff) is the field snapPatch() actually reads
// -- see tool.ts's snapPatch(). demo.ts's own /fmt patch fixture uses `diff`
// there, which snapPatch ignores, so it falls back to the one-line "~
// Patched ..." summary instead of a full diff. This fixture uses `patch` so
// the gallery shows the richer structured-diff rendering.
const SCROLLBACK_PATCH_FILES = [
  {
    type: "update",
    filePath: `${DEMO_ROOT}/src/demo-format.ts`,
    relativePath: "src/demo-format.ts",
    patch: "@@ -1 +1 @@\n-export const demo = 1\n+export const demo = 42\n",
    deletions: 1,
  },
  {
    type: "add",
    filePath: `${DEMO_ROOT}/README-demo.md`,
    relativePath: "README-demo.md",
    patch: "@@ -0,0 +1,2 @@\n+# Demo\n+This is a generated preview file.\n",
    deletions: 0,
  },
]

const SCROLLBACK_PATCH_COMMIT: StreamCommit = {
  kind: "tool",
  text: "",
  phase: "final",
  source: "tool",
  tool: "apply_patch",
  toolState: "completed",
  messageID: "msg-scrollback-patch",
  partID: "part-scrollback-patch",
  part: toolPart({
    id: "part-scrollback-patch",
    messageID: "msg-scrollback-patch",
    callID: "call-scrollback-patch",
    tool: "apply_patch",
    state: {
      status: "completed",
      input: { patchText: "*** Begin Patch\n*** End Patch" },
      output: "",
      title: "",
      metadata: { files: SCROLLBACK_PATCH_FILES },
      time: { start: 1, end: 2 },
    },
  }),
}

const SCROLLBACK_TASK_RESULT = [
  "Audited entry.body across all phase combinations for tool, text, and error commit kinds.",
  "Start phase always renders the header line via headerBody regardless of view.output.",
  "Progress phase is skipped entirely when view.output is false, matching todo and task tools.",
  "Final phase branches on status: error takes the raw scroll path unconditionally.",
  "Non-completed statuses print raw trimmed text without the structured snapshot.",
  "Completed statuses route through the structured snapshot when the tool registers one.",
  "Structured snapshots for code, diff, task, todo, and question each own their own truncation.",
  "No overlapping phase combinations were found to double-render content.",
  "Recommend adding a regression test for the completed-but-no-snapshot fallback path.",
].join("\n")

const SCROLLBACK_TASK_COMMIT: StreamCommit = {
  kind: "tool",
  text: "",
  phase: "final",
  source: "tool",
  tool: "task",
  toolState: "completed",
  messageID: "msg-scrollback-task",
  partID: "part-scrollback-task",
  part: toolPart({
    id: "part-scrollback-task",
    messageID: "msg-scrollback-task",
    callID: "call-scrollback-task",
    tool: "task",
    state: {
      status: "completed",
      input: {
        description: "Audit entry.body phase combinations for scrollback rendering",
        subagent_type: "explore",
      },
      output: `<task_result>\n${SCROLLBACK_TASK_RESULT}\n</task_result>`,
      title: "",
      metadata: { toolcalls: 4, sessionId: "sub-scrollback-task" },
      time: { start: 1, end: 2 },
    },
  }),
}

const SCROLLBACK_TODO_COMMIT: StreamCommit = {
  kind: "tool",
  text: "",
  phase: "final",
  source: "tool",
  tool: "todowrite",
  toolState: "completed",
  messageID: "msg-scrollback-todo",
  partID: "part-scrollback-todo",
  part: toolPart({
    id: "part-scrollback-todo",
    messageID: "msg-scrollback-todo",
    callID: "call-scrollback-todo",
    tool: "todowrite",
    state: {
      status: "completed",
      input: { todos: SAMPLE_TODOS },
      output: "",
      title: "",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }),
}

const SCROLLBACK_QUESTION_ANSWERS = [["Question"], ["Diff", "Todo"]]

const SCROLLBACK_QUESTION_COMMIT: StreamCommit = {
  kind: "tool",
  text: "",
  phase: "final",
  source: "tool",
  tool: "question",
  toolState: "completed",
  messageID: "msg-scrollback-question",
  partID: "part-scrollback-question",
  part: toolPart({
    id: "part-scrollback-question",
    messageID: "msg-scrollback-question",
    callID: "call-scrollback-question",
    tool: "question",
    state: {
      status: "completed",
      input: { questions: QUESTION_REQUESTS.multi.questions },
      output: "",
      title: "",
      metadata: { answers: SCROLLBACK_QUESTION_ANSWERS },
      time: { start: 1, end: 2 },
    },
  }),
}

const SCROLLBACK_ERROR_COMMIT: StreamCommit = {
  kind: "error",
  text: "demo error event",
  phase: "start",
  source: "system",
}

// Governance UI (P4): rule/hook permission denials and budget-threshold
// crossings both render as quiet, muted, one-line "system" notices --
// matching how existing system lines (e.g. "resume session ...") look,
// rather than an alarming error row.
const SCROLLBACK_PERMISSION_DENIED_COMMIT: StreamCommit = {
  kind: "system",
  text: '✗ permission denied: bash "git push origin main"',
  phase: "start",
  source: "system",
}

const SCROLLBACK_BUDGET_SOFT_COMMIT: StreamCommit = {
  kind: "system",
  text: "◈ budget: soft $1.50 crossed ($1.52)",
  phase: "start",
  source: "system",
}

const SCROLLBACK_BUDGET_HARD_COMMIT: StreamCommit = {
  kind: "system",
  text: "◈ budget: hard $2.50 crossed — tools disabled, report only",
  phase: "start",
  source: "system",
}

const SCROLLBACK_JUDGED_COMMIT: StreamCommit = {
  kind: "system",
  text: "⏺ Auto-allowed bash(ls) — safe operation",
  phase: "start",
  source: "system",
}

const SCROLLBACK_MONITOR_EVENT_COMMIT: StreamCommit = {
  kind: "system",
  text: "⏺ monitor(server health): OK (+2 more)",
  phase: "start",
  source: "system",
}

const SCROLLBACK_MONITOR_STOPPED_COMMIT: StreamCommit = {
  kind: "system",
  text: "⏺ monitor(server health) stopped — exit",
  phase: "start",
  source: "system",
}

const SCROLLBACK_CASES: { name: string; description: string; commits: StreamCommit[] }[] = [
  {
    name: "scrollback.markdown",
    description:
      "Assistant markdown reply with headings, bold/italic/code spans, a fence, and two tables, hanging under a 2-column ● gutter.",
    commits: [SCROLLBACK_MARKDOWN_COMMIT],
  },
  {
    name: "scrollback.table",
    description:
      "Assistant reply containing only a compact table, for table-only rendering checks, hanging under a 2-column ● gutter.",
    commits: [SCROLLBACK_TABLE_COMMIT],
  },
  {
    name: "scrollback.text",
    description: "Assistant reply with plain wrapped prose and no markdown syntax, hanging under a 2-column ● gutter.",
    commits: [SCROLLBACK_TEXT_COMMIT],
  },
  {
    name: "scrollback.reasoning",
    description: 'Reasoning entry rendered as a dimmed "_Thinking:_" markdown code block.',
    commits: [SCROLLBACK_REASONING_COMMIT],
  },
  {
    name: "scrollback.bash",
    description:
      'Completed bash tool entry: a "● Bash(cmd) in dir" header (green dot) with multi-line output hanging under a "⎿ " marker.',
    commits: [toolStartOf(SCROLLBACK_BASH_COMMIT), SCROLLBACK_BASH_COMMIT],
  },
  {
    name: "scrollback.bash.long",
    description:
      'Completed bash tool entry with 8 output lines truncated to the first 5 plus a muted "… +N lines" notice.',
    commits: [toolStartOf(SCROLLBACK_BASH_LONG_COMMIT), SCROLLBACK_BASH_LONG_COMMIT],
  },
  {
    name: "scrollback.write",
    description:
      'Completed write tool entry: a "● Write(path)" header, a "⎿ Wrote N lines" summary, and a gutter-indented code snapshot.',
    commits: [toolStartOf(SCROLLBACK_WRITE_COMMIT), SCROLLBACK_WRITE_COMMIT],
  },
  {
    name: "scrollback.edit",
    description:
      'Completed edit tool entry: a "● Edit(path)" header, a "⎿ +A / -D" summary, and a gutter-indented unified diff.',
    commits: [toolStartOf(SCROLLBACK_EDIT_COMMIT), SCROLLBACK_EDIT_COMMIT],
  },
  {
    name: "scrollback.patch",
    description:
      'Completed apply_patch tool entry: a "● Patch(N files)" header above two gutter-indented structured diff items (an update and a new file), each keeping its own per-file heading.',
    commits: [toolStartOf(SCROLLBACK_PATCH_COMMIT), SCROLLBACK_PATCH_COMMIT],
  },
  {
    name: "scrollback.task",
    description:
      'Completed task tool entry: a "● Task(description)" header with a dim agent type, a "⎿ Done (duration)" summary, and the subagent\'s final report truncated to 5 lines plus a muted "… +N lines" notice.',
    commits: [toolStartOf(SCROLLBACK_TASK_COMMIT), SCROLLBACK_TASK_COMMIT],
  },
  {
    name: "scrollback.todo",
    description:
      'Completed todowrite tool entry: a "● Update Todos" header above a ⎿ checklist block with ☒/☐ glyphs (completed/cancelled muted+strikethrough, in_progress highlight+bold, pending muted).',
    commits: [toolStartOf(SCROLLBACK_TODO_COMMIT), SCROLLBACK_TODO_COMMIT],
  },
  {
    name: "scrollback.question",
    description:
      'Completed question tool entry: a "● Question(N questions)" header above the gutter-indented question/answer card, no title line.',
    commits: [toolStartOf(SCROLLBACK_QUESTION_COMMIT), SCROLLBACK_QUESTION_COMMIT],
  },
  {
    name: "scrollback.error",
    description: "Session error entry rendered in the scrollback.",
    commits: [SCROLLBACK_ERROR_COMMIT],
  },
  {
    name: "scrollback.permission-denied",
    description: "Muted one-line notice for a rule/hook permission denial in the bound (main) session.",
    commits: [SCROLLBACK_PERMISSION_DENIED_COMMIT],
  },
  {
    name: "scrollback.budget-crossed",
    description:
      "Muted budget-crossing notices: soft threshold crossed (wind-down hint) followed by hard threshold crossed (tools disabled, report only).",
    commits: [SCROLLBACK_BUDGET_SOFT_COMMIT, SCROLLBACK_BUDGET_HARD_COMMIT],
  },
  {
    name: "scrollback.permission-judged",
    description: "Muted one-line notice for an auto-allowed permission by the LLM permission judge.",
    commits: [SCROLLBACK_JUDGED_COMMIT],
  },
  {
    name: "scrollback.monitor-event",
    description: "Muted one-line notice for a monitor event line batch with +N more indicator.",
    commits: [SCROLLBACK_MONITOR_EVENT_COMMIT],
  },
  {
    name: "scrollback.monitor-stopped",
    description: "Muted one-line notice for a monitor stopped event with the exit reason.",
    commits: [SCROLLBACK_MONITOR_STOPPED_COMMIT],
  },
]

// ---------------------------------------------------------------------------
// Render harnesses
// ---------------------------------------------------------------------------

function normalizeFrame(frame: string): string {
  const lines = frame.split("\n").map((line) => line.replace(/[ \t]+$/, ""))
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop()
  }
  return lines.join("\n") + "\n"
}

type TestRenderApp = Awaited<ReturnType<typeof testRender>>

// A rendered state, captured once and read out two ways: `text` is the
// normalized plain-text frame committed to test/cli/run/__gallery__/, and
// `spans` is the same frame's per-span color/attribute data used for the
// `--visual` HTML/PNG renderings. Capturing both from a single render pass
// keeps the two views guaranteed-consistent and avoids rendering twice.
type RenderResult = { text: string; spans: CapturedFrame }

async function capturePanel(width: number, height: number, node: () => JSX.Element): Promise<RenderResult> {
  const app = await testRender(
    () => (
      <box width={width} height={height}>
        {node()}
      </box>
    ),
    { width, height },
  )

  try {
    await app.renderOnce()
    return { text: normalizeFrame(app.captureCharFrame()), spans: app.captureSpans() }
  } finally {
    app.renderer.destroy()
  }
}

// Mirrors entryWriter()'s body handling (scrollback.writer.tsx) so a
// standalone RunEntryContent capture looks like a real scrollback row.
// RunEntryContent itself draws the hanging "● " gutter for dotted bodies
// (see needsDotPrefix), so this only needs the generic "⎿ " hanging-block
// layout (with truncation) for committed tool text results.
function scrollbackEntryBody(commit: StreamCommit): RunEntryBody {
  return toolResultBody(commit, entryBody(commit))
}

// A "code" body (reasoning) and the blockquote/fenced-code portions of a
// "markdown" body load their tree-sitter syntax grammar asynchronously
// (WASM), so a single renderOnce() right after mount can come back with that
// content still blank -- unrelated to any other gallery case, which is why
// this doesn't reuse capturePanel(). Re-render on a short interval until the
// frame stops changing and has real content.
//
// `minSettleMs` guards against a specific false-positive: the rest of a
// markdown body (headings, paragraphs, lists, tables) renders synchronously
// on the very first frame, so a naive "stop once two reads in a row are
// identical" check goes stable immediately -- while the still-blank
// blockquote/code region never gets a chance to load before the loop exits.
// Forcing a minimum wall-clock floor before that check is allowed to fire
// gives the async grammar load (observed at ~100-150ms in isolation, more
// under load from the many renders earlier in this script) room to finish.
async function captureSettledPanel(
  width: number,
  height: number,
  node: () => JSX.Element,
  minSettleMs = 0,
): Promise<RenderResult> {
  const app = await testRender(
    () => (
      <box width={width} height={height}>
        {node()}
      </box>
    ),
    { width, height },
  )

  try {
    await app.renderOnce()
    let previous = app.captureCharFrame()
    let stableStreak = 0
    let elapsed = 0
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 40))
      elapsed += 40
      await app.renderOnce()
      const next = app.captureCharFrame()
      stableStreak = next === previous && next.trim() !== "" ? stableStreak + 1 : 0
      previous = next
      if (elapsed >= minSettleMs && stableStreak >= 2) break
    }
    return { text: normalizeFrame(previous), spans: app.captureSpans() }
  } finally {
    app.renderer.destroy()
  }
}

// Renders a scrollback entry sequence standalone (stacked RunEntryContent
// rows, no scrollback list around it). Tool cases pass their [start,
// completion] commits so the frame shows the `● ToolName(args)` header with
// the result hanging under it, exactly like real scrollback -- both commits
// share one entry group, so no separator row appears between them.
// `probeHeight` is a generous upper bound: the entry is first rendered at
// that height to discover how many rows its content actually occupies, then
// re-rendered at that tight height so neither the .txt frame nor the
// --visual PNG has dead trailing space.
async function renderEntry(width: number, probeHeight: number, commits: StreamCommit[]): Promise<RenderResult> {
  const rows = commits.flatMap((commit) => {
    const body = scrollbackEntryBody(commit)
    if (body.type === "none") {
      return []
    }

    return [{ commit, body }]
  })
  const node = () => (
    <box width={width} flexDirection="column">
      {rows.map((row) => (
        <RunEntryContent commit={row.commit} body={row.body} theme={RUN_THEME_FALLBACK} width={width} />
      ))}
    </box>
  )
  const minSettleMs = rows.some((row) => row.body.type === "code" || row.body.type === "markdown") ? 800 : 0

  const probe = await captureSettledPanel(width, probeHeight, node, minSettleMs)
  const lines = probe.text.split("\n")
  let last = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") last = i
  }

  const height = Math.max(1, last + 1)
  if (height >= probeHeight) {
    return probe
  }

  return captureSettledPanel(width, height, node, minSettleMs)
}

async function renderFooterView(input: {
  width: number
  height: number
  view?: FooterView
  subagent?: FooterSubagentState
  todos?: FooterTodoItem[]
  state?: Partial<FooterState>
  commands?: RunCommand[]
  agents?: RunAgent[]
  providers?: RunProvider[]
  currentModel?: { providerID: string; modelID: string }
  currentVariant?: string
  backgroundSubagents?: boolean
  queuedPrompts?: FooterQueuedPrompt[]
  sessions?: FooterSessionTab[]
  interact?: (app: TestRenderApp) => Promise<void>
}): Promise<RenderResult> {
  const [view] = createSignal<FooterView>(input.view ?? { type: "prompt" })
  const [subagent] = createSignal<FooterSubagentState>(input.subagent ?? emptySubagentState())
  const [state] = createSignal<FooterState>(footerState(input.state))
  let offKeymap: (() => void) | undefined

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    offKeymap = registerOpencodeKeymap(keymap, renderer, tuiConfig)

    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <RunFooterView
          directory="/tmp"
          findFiles={async () => []}
          agents={() => input.agents ?? []}
          resources={() => []}
          commands={() => input.commands ?? []}
          providers={() => input.providers}
          currentModel={() => input.currentModel}
          variants={() => []}
          currentVariant={() => input.currentVariant}
          state={state}
          view={view}
          subagent={subagent}
          todos={() => input.todos ?? []}
          queuedPrompts={() => input.queuedPrompts ?? []}
          sessions={() => input.sessions ?? []}
          theme={() => RUN_THEME_FALLBACK}
          tuiConfig={tuiConfig}
          backgroundSubagents={input.backgroundSubagents ?? true}
          currentAgent={() => "build"}
          onSubmit={() => true}
          onPermissionReply={() => {}}
          onQuestionReply={() => {}}
          onQuestionReject={() => {}}
          onCycle={() => {}}
          onInterrupt={() => false}
          onEditorOpen={async () => undefined}
          onInputClear={() => {}}
          onExit={() => {}}
          onModelSelect={() => {}}
          onAgentSelect={() => {}}
          onVariantSelect={() => {}}
          onRows={() => {}}
          onLayout={() => {}}
          onStatus={() => {}}
          onQueuedRemove={async () => true}
        />
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(
    () => (
      <box width={input.width} height={input.height}>
        <Harness />
      </box>
    ),
    { width: input.width, height: input.height, kittyKeyboard: true },
  )

  try {
    await app.renderOnce()
    if (input.interact) {
      await input.interact(app)
      // Scrollbox-backed views (e.g. the subagent inspector) settle their
      // sticky-scroll position over a couple of extra frames after the
      // content they wrap first mounts, so render twice more here.
      await app.renderOnce()
      await app.renderOnce()
    }
    return { text: normalizeFrame(app.captureCharFrame()), spans: app.captureSpans() }
  } finally {
    app.renderer.currentFocusedRenderable?.blur()
    app.renderer.currentFocusedEditor?.blur()
    offKeymap?.()
    app.renderer.destroy()
  }
}

// Drives the footer through: open command palette -> "View subagents" ->
// select the second (completed) tab -> land on the subagent inspector route.
// This is the only way to reach the inspector short of exposing route state,
// so the interaction is pinned to an exact, deterministic key sequence.
async function openSubagentInspector(app: TestRenderApp): Promise<void> {
  app.mockInput.pressKey("p", { ctrl: true })
  await app.renderOnce()
  "view subagents".split("").forEach((key) => app.mockInput.pressKey(key))
  await app.renderOnce()
  app.mockInput.pressEnter()
  await app.renderOnce()
  app.mockInput.pressKey("ARROW_DOWN")
  await app.renderOnce()
  app.mockInput.pressEnter()
}

// Types a short prompt into the composer so the footer.subagent-tree case
// shows the tree sitting above a live-looking draft, not an empty composer.
async function typeShortPrompt(app: TestRenderApp): Promise<void> {
  "check on that".split("").forEach((key) => app.mockInput.pressKey(key))
  await app.renderOnce()
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

type GalleryCase = {
  name: string
  description: string
  height: number
  render: (width: number, height: number) => Promise<RenderResult>
}

const CASES: GalleryCase[] = [
  {
    name: "footer.prompt",
    description: "Default RunFooterView composer with an empty prompt.",
    height: 8,
    render: (width, height) => renderFooterView({ width, height }),
  },
  {
    name: "footer.todos",
    description: "Footer todo panel with completed/in_progress/pending sample todos, using ☒/☐ glyphs.",
    height: 12,
    render: (width, height) => renderFooterView({ width, height, todos: SAMPLE_TODOS }),
  },
  ...(["edit", "bash", "read", "task", "external", "doom"] as const).map(
    (kind): GalleryCase => ({
      name: `footer.permission.${kind}`,
      description: `Permission dialog for a "${kind}" request.`,
      height: 20,
      render: (width, height) =>
        renderFooterView({ width, height, view: { type: "permission", request: PERMISSION_REQUESTS[kind] } }),
    }),
  ),
  ...(["multi", "single", "checklist", "custom"] as const).map(
    (kind): GalleryCase => ({
      name: `footer.question.${kind}`,
      description: `Question dialog for a "${kind}" request.`,
      height: 20,
      render: (width, height) =>
        renderFooterView({ width, height, view: { type: "question", request: QUESTION_REQUESTS[kind] } }),
    }),
  ),
  {
    name: "footer.subagent",
    description: "RunFooterView with the subagent inspector open on a completed tab (2-tab state).",
    height: 16,
    render: (width, height) =>
      renderFooterView({
        width,
        height,
        subagent: { tabs: SAMPLE_SUBAGENT_TABS, details: SAMPLE_SUBAGENT_DETAILS, permissions: [], questions: [] },
        backgroundSubagents: false,
        interact: openSubagentInspector,
      }),
  },
  {
    name: "footer.subagent-tree",
    description:
      "RunFooterView composer with the subagent tree: a running task (braille spinner as the header glyph + plain activity text) and a completed task (✓ header, ⎿ Done), above a short prompt draft and the statusline.",
    height: 12,
    render: (width, height) =>
      renderFooterView({
        width,
        height,
        subagent: { tabs: SAMPLE_SUBAGENT_TREE_TABS, details: {}, permissions: [], questions: [] },
        interact: typeShortPrompt,
      }),
  },
  {
    name: "footer.subagent-tree.cost",
    description: "Subagent tree task rows with each child session's accumulated cost shown muted at the row end (P4).",
    height: 12,
    render: (width, height) =>
      renderFooterView({
        width,
        height,
        subagent: { tabs: SAMPLE_SUBAGENT_TREE_COST_TABS, details: {}, permissions: [], questions: [] },
        interact: typeShortPrompt,
      }),
  },
  {
    name: "footer.statusline.accept-edits",
    description: "Statusline with the accept-edits permission mode pill visible beside a prompt composer.",
    height: 8,
    render: (width, height) =>
      renderFooterView({
        width,
        height,
        state: { permissionMode: "accept-edits" },
      }),
  },
  {
    name: "footer.statusline.auto",
    description: "Statusline with the AUTO automode indicator beside the agent name.",
    height: 8,
    render: (width, height) =>
      renderFooterView({
        width,
        height,
        state: { automode: true },
      }),
  },
  {
    name: "footer.statusline.budget-ok",
    description:
      "Statusline budget-fraction pill ($cost/$soft) in muted color while the session's agent cost is under its soft budget.",
    height: 8,
    render: (width, height) =>
      renderFooterView({
        width,
        height,
        agents: [BUDGET_AGENT],
        state: { agent: BUDGET_AGENT.name, cost: 0.42 },
      }),
  },
  {
    name: "footer.statusline.budget-soft",
    description: "Statusline budget-fraction pill in warning color once session cost reaches the soft budget.",
    height: 8,
    render: (width, height) =>
      renderFooterView({
        width,
        height,
        agents: [BUDGET_AGENT],
        state: { agent: BUDGET_AGENT.name, cost: 1.52 },
      }),
  },
  {
    name: "footer.statusline.budget-hard",
    description: "Statusline budget-fraction pill in error color once session cost reaches the hard budget.",
    height: 8,
    render: (width, height) =>
      renderFooterView({
        width,
        height,
        agents: [BUDGET_AGENT],
        state: { agent: BUDGET_AGENT.name, cost: 2.5 },
      }),
  },
  {
    name: "panel.command-menu",
    description: "Standalone command palette body with commands, an agent, and a subagent entry.",
    height: RUN_COMMAND_PANEL_ROWS,
    render: (width, height) =>
      capturePanel(width, height, () => (
        <RunCommandMenuBody
          theme={() => RUN_THEME_FALLBACK.footer}
          commands={() => SAMPLE_COMMANDS}
          agents={() => SAMPLE_AGENTS}
          subagents={() => SAMPLE_SUBAGENT_TABS}
          queued={() => SAMPLE_QUEUED}
          variants={() => ["high", "minimal"]}
          variantCycle="ctrl+t"
          onClose={() => {}}
          onModel={() => {}}
          onAgent={() => {}}
          onEditor={() => {}}
          onSkill={() => {}}
          onSubagent={() => {}}
          onSessions={() => {}}
          onQueued={() => {}}
          onVariant={() => {}}
          onVariantCycle={() => {}}
          onCommand={() => {}}
          onNew={() => {}}
          onExit={() => {}}
        />
      )),
  },
  {
    name: "panel.model-select",
    description: "Standalone model picker body with a current selection and a deprecated model hidden.",
    height: RUN_COMMAND_PANEL_ROWS,
    render: (width, height) =>
      capturePanel(width, height, () => (
        <RunModelSelectBody
          theme={() => RUN_THEME_FALLBACK.footer}
          providers={() => [provider()]}
          current={() => ({ providerID: "opencode", modelID: "gpt-5" })}
          onClose={() => {}}
          onSelect={() => {}}
        />
      )),
  },
  {
    name: "panel.variant-select",
    description: "Standalone reasoning-variant picker body with a current selection.",
    height: RUN_COMMAND_PANEL_ROWS,
    render: (width, height) =>
      capturePanel(width, height, () => (
        <RunVariantSelectBody
          theme={() => RUN_THEME_FALLBACK.footer}
          variants={() => ["high", "minimal"]}
          current={() => "high"}
          onClose={() => {}}
          onSelect={() => {}}
        />
      )),
  },
  {
    name: "panel.skill-select",
    description: "Standalone skill picker body listing skill-sourced commands.",
    height: RUN_COMMAND_PANEL_ROWS,
    render: (width, height) =>
      capturePanel(width, height, () => (
        <RunSkillSelectBody
          theme={() => RUN_THEME_FALLBACK.footer}
          commands={() => SAMPLE_COMMANDS}
          onClose={() => {}}
          onSelect={() => {}}
        />
      )),
  },
  {
    name: "panel.subagent-select",
    description: "Standalone subagent picker body with a running and a completed tab.",
    height: RUN_SUBAGENT_PANEL_ROWS,
    render: (width, height) =>
      capturePanel(width, height, () => (
        <RunSubagentSelectBody
          theme={() => RUN_THEME_FALLBACK.footer}
          tabs={() => SAMPLE_SUBAGENT_TABS}
          current={() => undefined}
          onClose={() => {}}
          onSelect={() => {}}
          onRows={() => {}}
        />
      )),
  },
  {
    name: "panel.queued",
    description: "Standalone queued-prompt picker body with two pending prompts.",
    height: RUN_SUBAGENT_PANEL_ROWS,
    render: (width, height) =>
      capturePanel(width, height, () => (
        <RunQueuedPromptSelectBody
          theme={() => RUN_THEME_FALLBACK.footer}
          prompts={() => SAMPLE_QUEUED}
          onClose={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
        />
      )),
  },
  {
    name: "panel.sessions",
    description: "Standalone resume-session picker body listing other sessions newest first.",
    height: 16,
    render: (width, height) =>
      withFixedClock(FIXED_NOW, () =>
        capturePanel(width, height, () => (
          <RunSessionSelectBody
            theme={() => RUN_THEME_FALLBACK.footer}
            sessions={() => SAMPLE_SESSIONS}
            current={() => undefined}
            onClose={() => {}}
            onSelect={() => {}}
          />
        )),
      ),
  },
  // `height` here is a probe cap, not the final frame height: renderEntry()
  // renders once at this height to discover how many rows the entry's
  // content actually occupies, then re-renders at that tight height so
  // neither the .txt frame nor the --visual PNG has dead trailing space.
  ...SCROLLBACK_CASES.map(
    (item): GalleryCase => ({
      name: item.name,
      description: item.description,
      height: 90,
      render: (width, height) => renderEntry(width, height, item.commits),
    }),
  ),
]

// ---------------------------------------------------------------------------
// Generation / check / write
// ---------------------------------------------------------------------------

function fileName(caseName: string, width: number): string {
  return `${caseName}.w${width}.txt`
}

// State key shared by the visual (HTML/PNG) outputs, e.g. "footer.todos.w80".
function stateKey(caseName: string, width: number): string {
  return `${caseName}.w${width}`
}

type VisualEntry = { frame: CapturedFrame; description: string }

async function generateAll(): Promise<{ files: Map<string, string>; visuals: Map<string, VisualEntry> }> {
  const files = new Map<string, string>()
  const visuals = new Map<string, VisualEntry>()

  for (const kase of CASES) {
    for (const width of WIDTHS) {
      const { text, spans } = await kase.render(width, kase.height)
      files.set(fileName(kase.name, width), text)
      visuals.set(stateKey(kase.name, width), { frame: spans, description: kase.description })
    }
  }

  const index = [
    "# UI gallery",
    "",
    "Generated by `bun run ui-gallery` from `script/ui-gallery.tsx`. Do not edit by hand --",
    "regenerate with the script instead. Each state is rendered at widths 80 and 120.",
    "",
    "| File | Description |",
    "| --- | --- |",
    ...CASES.flatMap((kase) => WIDTHS.map((width) => `| \`${fileName(kase.name, width)}\` | ${kase.description} |`)),
    "",
  ].join("\n")
  files.set("INDEX.md", index)

  return { files, visuals }
}

async function writeAll(files: Map<string, string>): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true })
  for (const [name, content] of files) {
    await fs.writeFile(path.join(OUT_DIR, name), content)
  }
}

async function checkAll(files: Map<string, string>): Promise<string[]> {
  const drifted: string[] = []

  for (const [name, content] of files) {
    const target = path.join(OUT_DIR, name)
    const existing = await fs.readFile(target, "utf8").catch(() => undefined)
    if (existing !== content) {
      drifted.push(name)
    }
  }

  const existingFiles = await fs.readdir(OUT_DIR).catch(() => [] as string[])
  for (const name of existingFiles) {
    if (!files.has(name)) {
      drifted.push(`${name} (stale, no longer generated)`)
    }
  }

  return drifted
}

// ---------------------------------------------------------------------------
// Visual rendering (--visual): color-faithful HTML + headless-Chrome PNGs
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile)
const CHROME_BIN = process.env.UI_GALLERY_CHROME || "google-chrome"

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function cssRgba(r: number, g: number, b: number, a: number): string {
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)))
  const alpha = Math.max(0, Math.min(1, Math.round(a * 1000) / 1000))
  return `rgba(${clamp(r)}, ${clamp(g)}, ${clamp(b)}, ${alpha})`
}

// CSS for one captured span: color/background from its (possibly
// fg/bg-swapped, for INVERSE) RGBA channels, plus font-weight/style/
// text-decoration for the remaining attributes. DIM dims the foreground by
// scaling its alpha (not CSS opacity), so the span's own background stays
// fully opaque.
function spanStyle(span: CapturedSpan): string {
  const attrs = getBaseAttributes(span.attributes)
  const inverse = (attrs & TextAttributes.INVERSE) !== 0
  const dim = (attrs & TextAttributes.DIM) !== 0

  const fgSource = inverse ? span.bg : span.fg
  const bgSource = inverse ? span.fg : span.bg
  const [fgR, fgG, fgB, fgA] = fgSource.toInts()
  const [bgR, bgG, bgB, bgA] = bgSource.toInts()

  let fgAlpha = fgA / 255
  if (dim) fgAlpha *= 0.55

  const styles = [`color: ${cssRgba(fgR, fgG, fgB, fgAlpha)}`, `background-color: ${cssRgba(bgR, bgG, bgB, bgA / 255)}`]

  if (attrs & TextAttributes.BOLD) styles.push("font-weight: 700")
  if (attrs & TextAttributes.ITALIC) styles.push("font-style: italic")

  const decorations: string[] = []
  if (attrs & TextAttributes.UNDERLINE) decorations.push("underline")
  if (attrs & TextAttributes.STRIKETHROUGH) decorations.push("line-through")
  if (decorations.length > 0) styles.push(`text-decoration: ${decorations.join(" ")}`)

  return styles.join("; ")
}

// HIDDEN spans render as blank cells (same width) instead of their text.
function spanText(span: CapturedSpan): string {
  const attrs = getBaseAttributes(span.attributes)
  const text = attrs & TextAttributes.HIDDEN ? " ".repeat(span.text.length) : span.text
  return escapeHtml(text)
}

// NOTE: lines are joined with "" (not "\n"). The container this is injected
// into sets `white-space: pre` so that repeated space characters inside a
// span's text stay visible instead of collapsing -- but that also means any
// literal newline placed directly between the `<div>` lines below would
// render as an extra blank line (each `<div>` is already block-level and
// stacks on its own; no separator is needed, and one would double the
// effective line height).
function frameBodyHtml(frame: CapturedFrame): string {
  return frame.lines
    .map(
      (line) =>
        `<div>${line.spans.map((span) => `<span style="${spanStyle(span)}">${spanText(span)}</span>`).join("")}</div>`,
    )
    .join("")
}

// The page/frame background: the most common (by covered column width) span
// background in the frame, falling back to black when that color is fully
// transparent (or the frame has no spans at all).
function dominantBackground(frame: CapturedFrame): string {
  const weightByKey = new Map<string, number>()
  const cssByKey = new Map<string, string>()

  for (const line of frame.lines) {
    for (const span of line.spans) {
      const [r, g, b, a] = span.bg.toInts()
      const key = `${r},${g},${b},${a}`
      weightByKey.set(key, (weightByKey.get(key) ?? 0) + span.width)
      cssByKey.set(key, a === 0 ? "#000000" : cssRgba(r, g, b, a / 255))
    }
  }

  let bestKey: string | undefined
  let bestWeight = -1
  for (const [key, weight] of weightByKey) {
    if (weight > bestWeight) {
      bestKey = key
      bestWeight = weight
    }
  }

  return bestKey ? (cssByKey.get(bestKey) ?? "#000000") : "#000000"
}

const MONOSPACE_FONT_STACK = `"DejaVu Sans Mono", "Noto Sans Mono", monospace`

function frameToHtml(frame: CapturedFrame, title: string): string {
  const background = dominantBackground(frame)
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  html, body {
    margin: 0;
    padding: 12px;
    background: ${background};
  }
  body {
    display: inline-block;
    font-family: ${MONOSPACE_FONT_STACK};
    font-size: 14px;
    line-height: 1;
    white-space: pre;
  }
</style>
</head>
<body>${frameBodyHtml(frame)}</body>
</html>
`
}

function contactSheetHtml(entries: { key: string; description: string; frame: CapturedFrame }[]): string {
  const sections = entries
    .map(({ key, description, frame }) => {
      const background = dominantBackground(frame)
      return `<section>
  <h2>${escapeHtml(key)}</h2>
  <p>${escapeHtml(description)}</p>
  <div class="frame" style="background: ${background};">${frameBodyHtml(frame)}</div>
</section>`
    })
    .join("\n")

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>UI gallery contact sheet</title>
<style>
  html, body {
    margin: 0;
    padding: 16px;
    background: #111318;
    color: #d8dae0;
    font-family: system-ui, sans-serif;
  }
  h2 {
    font-size: 13px;
    font-weight: 600;
    margin: 28px 0 4px;
  }
  p {
    font-size: 12px;
    color: #9a9ea8;
    margin: 0 0 8px;
  }
  .frame {
    display: inline-block;
    padding: 12px;
    font-family: ${MONOSPACE_FONT_STACK};
    font-size: 14px;
    line-height: 1;
    white-space: pre;
  }
  section:first-child h2 {
    margin-top: 0;
  }
</style>
</head>
<body>
${sections}
</body>
</html>
`
}

function htmlFileName(key: string): string {
  return `${key}.html`
}

function pngFileName(key: string): string {
  return `${key}.png`
}

async function isChromeAvailable(): Promise<boolean> {
  try {
    await execFileAsync(CHROME_BIN, ["--version"], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

// Window size is a generous overshoot of the frame's cell grid so the
// screenshot never clips -- extra margin around the content is harmless.
function chromeWindowSize(cols: number, rows: number): { width: number; height: number } {
  return { width: cols * 9 + 40, height: rows * 17 + 40 }
}

async function renderPng(
  htmlPath: string,
  pngPath: string,
  cols: number,
  rows: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { width, height } = chromeWindowSize(cols, rows)
  try {
    await execFileAsync(
      CHROME_BIN,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        `--screenshot=${pngPath}`,
        `--window-size=${width},${height}`,
        `file://${htmlPath}`,
      ],
      { timeout: 30_000 },
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const workerCount = Math.max(1, Math.min(limit, queue.length))
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        const item = queue.shift()
        if (!item) break
        await fn(item)
      }
    }),
  )
}

async function writeVisuals(visuals: Map<string, VisualEntry>): Promise<void> {
  await fs.mkdir(VISUAL_DIR, { recursive: true })

  const entries = [...visuals.entries()].map(([key, entry]) => ({ key, ...entry }))

  for (const { key, frame } of entries) {
    await fs.writeFile(path.join(VISUAL_DIR, htmlFileName(key)), frameToHtml(frame, key))
  }
  await fs.writeFile(path.join(VISUAL_DIR, "contact-sheet.html"), contactSheetHtml(entries))

  console.log(
    `ui-gallery --visual: wrote ${entries.length} HTML file(s) + contact-sheet.html to ${path.relative(process.cwd(), VISUAL_DIR)}`,
  )

  if (!(await isChromeAvailable())) {
    console.warn(
      `ui-gallery --visual: Chrome binary "${CHROME_BIN}" not available (set UI_GALLERY_CHROME to override); skipping ${entries.length} PNG screenshot(s). HTML files were written.`,
    )
    return
  }

  const failures: string[] = []
  await runWithConcurrency(entries, 4, async ({ key, frame }) => {
    const result = await renderPng(
      path.join(VISUAL_DIR, htmlFileName(key)),
      path.join(VISUAL_DIR, pngFileName(key)),
      frame.cols,
      frame.rows,
    )
    if (!result.ok) failures.push(`${key}: ${result.error}`)
  })

  if (failures.length > 0) {
    console.warn(`ui-gallery --visual: ${failures.length} PNG screenshot(s) failed:`)
    for (const failure of failures.sort()) {
      console.warn(`  ${failure}`)
    }
    return
  }

  console.log(
    `ui-gallery --visual: wrote ${entries.length} PNG screenshot(s) to ${path.relative(process.cwd(), VISUAL_DIR)}`,
  )
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check")
  const visual = process.argv.includes("--visual")
  const { files, visuals } = await generateAll()

  if (check) {
    const drifted = await checkAll(files)
    if (drifted.length > 0) {
      console.error(`ui-gallery --check: ${drifted.length} file(s) differ from the committed gallery:`)
      for (const name of drifted.sort()) {
        console.error(`  ${name}`)
      }
      process.exit(1)
    }

    console.log(`ui-gallery --check: ${files.size} files match the committed gallery.`)
    return
  }

  await writeAll(files)
  console.log(`ui-gallery: wrote ${files.size} files to ${path.relative(process.cwd(), OUT_DIR)}`)

  if (visual) {
    await writeVisuals(visuals)
  }
}

await main()
