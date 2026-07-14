// Core reducer for direct interactive mode.
//
// Takes raw SDK events and produces two outputs:
//   - StreamCommit[]: append-only scrollback entries (text, tool, error, etc.)
//   - FooterOutput:   status bar patches and view transitions (permission, question)
//
// The reducer mutates SessionData in place for performance but has no
// external side effects -- no IO, no footer calls. The caller
// (stream.transport.ts) feeds events in and forwards output to the footer
// through stream.ts.
//
// Key design decisions:
//
// - Text parts buffer in `data.text` until their message role is confirmed as
//   "assistant". This prevents echoing user-role text parts. The `ready()`
//   check gates output: if we see a text delta before the message.updated
//   event that tells us the role, we stash it and flush later via `replay()`.
//
// - Tool echo stripping: bash tools may echo their own output in the next
//   assistant text part. `stashEcho()` records completed bash output, and
//   `stripEcho()` removes it from the start of the next assistant chunk.
//
// - Permission and question requests queue in `data.permissions` and
//   `data.questions`. The footer shows whichever is first. When a reply
//   event arrives, the queue entry is removed and the footer falls back
//   to the next pending request or to the prompt view.
import type { Event, Part, PermissionRequest, QuestionRequest, ToolPart } from "@opencode-ai/sdk/v2"
import * as Locale from "@/util/locale"
import { toolView } from "./tool"
import type { FooterOutput, FooterPatch, FooterThinkingState, FooterTodoItem, FooterView, StreamCommit } from "./types"

type Tokens = {
  input?: number
  output?: number
  reasoning?: number
  cache?: {
    read?: number
    write?: number
  }
}

type PartKind = "assistant" | "reasoning" | "user"
type MessageRole = "assistant" | "user"
type Dict = Record<string, unknown>
type SessionCommit = StreamCommit

// Mutable accumulator for the reducer. Each field tracks a different aspect
// of the stream so we can produce correct incremental output:
//
// - ids:    parts and error keys we've already committed (dedup guard)
// - tools:  tool parts we've emitted a "start" for but not yet completed
// - call:   tool call inputs, keyed by msg:call, for enriching permission views
// - role:   message ID → "assistant" | "user", learned from message.updated
// - msg:    part ID → message ID
// - part:   part ID → "assistant" | "reasoning" (text parts only)
// - text:   part ID → full accumulated text so far
// - sent:   part ID → byte offset of last flushed text (for incremental output)
// - visible: part ID → rendered text for an active part after display transforms
// - end:    part IDs whose time.end has arrived (part is finished)
// - shell:  shell call ID → chosen transcript source for direct shell calls
// - echo:   message ID → bash outputs to strip from the next assistant chunk
type ShellCall = {
  source: "shell" | "tool"
  command?: string
}

export type SessionData = {
  includeUserText: boolean
  announced: boolean
  ids: Set<string>
  tools: Set<string>
  call: Map<string, Dict>
  shell: Map<string, ShellCall>
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  pendingJudge: Map<string, PermissionRequest>
  judgeReasons: Map<string, string>
  role: Map<string, MessageRole>
  msg: Map<string, string>
  part: Map<string, PartKind>
  text: Map<string, string>
  sent: Map<string, number>
  visible: Map<string, string>
  end: Set<string>
  echo: Map<string, Set<string>>
}

export type SessionDataInput = {
  data: SessionData
  event: Event
  sessionID: string
  thinking: boolean
  limits: Record<string, number>
}

export type SessionDataOutput = {
  data: SessionData
  commits: SessionCommit[]
  footer?: FooterOutput
}

export function createSessionData(
  input: {
    includeUserText?: boolean
  } = {},
): SessionData {
  return {
    includeUserText: input.includeUserText ?? false,
    announced: false,
    ids: new Set(),
    tools: new Set(),
    call: new Map(),
    shell: new Map(),
    permissions: [],
    questions: [],
    pendingJudge: new Map(),
    judgeReasons: new Map(),
    role: new Map(),
    msg: new Map(),
    part: new Map(),
    text: new Map(),
    sent: new Map(),
    visible: new Map(),
    end: new Set(),
    echo: new Map(),
  }
}

function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

// Structured usage numbers for the footer's statusline info pills (P3). Kept
// separate from formatting/rendering, which is the view's job (footer.view.tsx).
type UsageMetrics = {
  tokens: number
  percent: number | null
}

function usageMetrics(tokens: Tokens | undefined, limit: number | undefined): UsageMetrics {
  const total =
    (tokens?.input ?? 0) +
    (tokens?.output ?? 0) +
    (tokens?.reasoning ?? 0) +
    (tokens?.cache?.read ?? 0) +
    (tokens?.cache?.write ?? 0)

  return {
    tokens: total,
    percent: limit && limit > 0 ? Math.round((total / limit) * 100) : null,
  }
}

export function formatError(error: {
  name?: string
  message?: string
  data?: {
    message?: string
  }
}): string {
  if (error.data?.message) {
    return error.data.message
  }

  if (error.message) {
    return error.message
  }

  if (error.name) {
    return error.name
  }

  return "unknown error"
}

function isAbort(error: { name?: string } | undefined): boolean {
  return error?.name === "MessageAbortedError"
}

// Truncates a denied permission's pattern so a long glob/command doesn't blow
// out the one-line scrollback notice (P4).
const PERMISSION_DENIED_PATTERN_LIMIT = 60

function formatPermissionDenied(properties: { permission: string; patterns: string[] }): string {
  const pattern = properties.patterns[0]
  const suffix = pattern ? ` "${Locale.truncateMiddle(pattern, PERMISSION_DENIED_PATTERN_LIMIT)}"` : ""
  return `✗ permission denied: ${properties.permission}${suffix}`
}

function formatPermissionJudged(properties: { permission: string; patterns: string[]; reason?: string }): string {
  const pattern = properties.patterns[0]
  const suffix = pattern ? `(${pattern})` : ""
  const reason = properties.reason?.trim() || "no reason"
  return `⏺ Auto-allowed ${properties.permission}${suffix} — ${reason}`
}

function msgErr(id: string): string {
  return `msg:${id}:error`
}

function patch(patch?: FooterPatch, view?: FooterView): FooterOutput | undefined {
  if (!patch && !view) {
    return undefined
  }

  return {
    patch,
    view,
  }
}

function out(data: SessionData, commits: SessionCommit[], footer?: FooterOutput): SessionDataOutput {
  if (!footer) {
    return {
      data,
      commits,
    }
  }

  return {
    data,
    commits,
    footer,
  }
}

export function pickBlockerView(input: { permission?: PermissionRequest; question?: QuestionRequest }): FooterView {
  if (input.permission) {
    return { type: "permission", request: input.permission }
  }

  if (input.question) {
    return { type: "question", request: input.question }
  }

  return { type: "prompt" }
}

export function blockerStatus(view: FooterView) {
  if (view.type === "permission") {
    return "awaiting permission"
  }

  if (view.type === "question") {
    return "awaiting answer"
  }

  return ""
}

function pickSessionView(data: SessionData): FooterView {
  const view = pickBlockerView({
    permission: data.permissions[0],
    question: data.questions[0],
  })
  if (view.type === "permission") {
    const reason = data.judgeReasons.get(view.request.id)
    if (reason !== undefined) {
      return { ...view, judgeReason: reason }
    }
  }
  return view
}

function queueFooter(data: SessionData): FooterOutput {
  const view = pickSessionView(data)

  return {
    view,
    patch: { status: blockerStatus(view) },
  }
}

function queueOut(data: SessionData, commits: SessionCommit[]): SessionDataOutput {
  return out(data, commits, queueFooter(data))
}

function upsert<T extends { id: string }>(list: T[], item: T) {
  const idx = list.findIndex((entry) => entry.id === item.id)
  if (idx === -1) {
    list.push(item)
    return
  }

  list[idx] = item
}

function remove(list: Array<{ id: string }>, id: string): boolean {
  const idx = list.findIndex((entry) => entry.id === id)
  if (idx === -1) {
    return false
  }

  list.splice(idx, 1)
  return true
}

export function bootstrapSessionData(input: {
  data: SessionData
  messages: Array<{
    parts: Part[]
  }>
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
}) {
  for (const message of input.messages) {
    for (const part of message.parts) {
      if (part.type !== "tool") {
        continue
      }

      input.data.call.set(key(part.messageID, part.callID), part.state.input)
    }
  }

  for (const request of input.permissions.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    upsert(input.data.permissions, enrichPermission(input.data, request))
  }

  for (const request of input.questions.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    upsert(input.data.questions, request)
  }
}

function key(msg: string, call: string): string {
  return `${msg}:${call}`
}

function enrichPermission(data: SessionData, request: PermissionRequest): PermissionRequest {
  if (!request.tool) {
    return request
  }

  const input = data.call.get(key(request.tool.messageID, request.tool.callID))
  if (!input) {
    return request
  }

  const meta = request.metadata ?? {}
  if (meta.input === input) {
    return request
  }

  return {
    ...request,
    metadata: {
      ...meta,
      input,
    },
  }
}

// Updates the active permission request when the matching tool part gets
// new input (e.g., a diff). This keeps the permission UI in sync with the
// tool's evolving state. Only triggers a footer update if the currently
// displayed permission was the one that changed.
function syncPermission(data: SessionData, part: ToolPart): FooterOutput | undefined {
  data.call.set(key(part.messageID, part.callID), part.state.input)
  if (data.permissions.length === 0) {
    return undefined
  }

  let changed = false
  let active = false
  data.permissions = data.permissions.map((request, index) => {
    if (!request.tool || request.tool.messageID !== part.messageID || request.tool.callID !== part.callID) {
      return request
    }

    const next = enrichPermission(data, request)
    if (next === request) {
      return request
    }

    changed = true
    active ||= index === 0
    return next
  })

  if (!changed || !active) {
    return undefined
  }

  return {
    view: pickSessionView(data),
  }
}

// Question tool replies can complete without a matching question.replied event.
// When that happens, drop the recovered pending request tied to this tool call so
// the footer can return to the next blocker or to the prompt.
function syncQuestion(data: SessionData, part: ToolPart): FooterOutput | undefined {
  if (part.tool !== "question") {
    return undefined
  }

  if (part.state.status !== "completed" && part.state.status !== "error") {
    return undefined
  }

  const next = data.questions.filter(
    (request) => request.tool?.messageID !== part.messageID || request.tool?.callID !== part.callID,
  )
  if (next.length === data.questions.length) {
    return undefined
  }

  data.questions = next
  return queueFooter(data)
}

function toolStatus(part: ToolPart): string {
  if (part.tool !== "task") {
    return `running ${part.tool}`
  }

  const state = part.state as {
    input?: {
      description?: unknown
      subagent_type?: unknown
    }
  }
  const desc = state.input?.description
  if (typeof desc === "string" && desc.trim()) {
    return `running ${desc.trim()}`
  }

  const type = state.input?.subagent_type
  if (typeof type === "string" && type.trim()) {
    return `running ${type.trim()}`
  }

  return "running task"
}

// Returns true if we can flush this part's text to scrollback.
//
// We gate on the message role being "assistant" because user-role messages
// also contain text parts (the user's own input) which we don't want to
// echo. If we haven't received the message.updated event yet, we return
// false and the text stays buffered until replay() flushes it.
function ready(data: SessionData, partID: string): boolean {
  const msg = data.msg.get(partID)
  if (!msg) {
    return true
  }

  const role = data.role.get(msg)
  if (!role) {
    return false
  }

  if (role === "assistant") {
    return true
  }

  return data.includeUserText && role === "user"
}

function syncText(data: SessionData, partID: string, next: string) {
  const prev = data.text.get(partID) ?? ""
  if (!next) {
    return prev
  }

  if (!prev || next.length >= prev.length) {
    data.text.set(partID, next)
    return next
  }

  return prev
}

// Records bash tool output for echo stripping. Some models echo bash output
// verbatim at the start of their next text part. We save both the raw and
// trimmed forms so stripEcho() can match either.
function stashEcho(data: SessionData, part: ToolPart) {
  if (part.tool !== "bash") {
    return
  }

  if (typeof part.messageID !== "string" || !part.messageID) {
    return
  }

  const output = "output" in part.state ? part.state.output : undefined
  if (typeof output !== "string") {
    return
  }

  const text = output.replace(/^\n+/, "")
  if (!text.trim()) {
    return
  }

  const set = data.echo.get(part.messageID) ?? new Set<string>()
  set.add(text)
  const trim = text.replace(/\n+$/, "")
  if (trim && trim !== text) {
    set.add(trim)
  }
  data.echo.set(part.messageID, set)
}

function stripEcho(data: SessionData, msg: string | undefined, chunk: string): string {
  if (!msg) {
    return chunk
  }

  const set = data.echo.get(msg)
  if (!set || set.size === 0) {
    return chunk
  }

  data.echo.delete(msg)
  const list = [...set].sort((a, b) => b.length - a.length)
  for (const item of list) {
    if (!item || !chunk.startsWith(item)) {
      continue
    }

    return chunk.slice(item.length).replace(/^\n+/, "")
  }

  return chunk
}

function flushPart(data: SessionData, commits: SessionCommit[], partID: string, interrupted = false) {
  const kind = data.part.get(partID)
  if (!kind) {
    return
  }

  const text = data.text.get(partID) ?? ""
  const sent = data.sent.get(partID) ?? 0
  let chunk = text.slice(sent)
  const msg = data.msg.get(partID)

  if (sent === 0) {
    chunk = chunk.replace(/^\n+/, "")
    // Some models emit a standalone whitespace token before real content.
    // Keep buffering until we have visible text so scrollback doesn't get a blank row.
    if (!chunk.trim()) {
      return
    }
    if (kind === "reasoning" && chunk) {
      // Defer the "● Thinking…" header to reasoningSummary: while streaming it
      // lives in the footer panel (with a blinking dot), and only the finished
      // block is committed to scrollback.
      const clean = chunk.replace(/\[REDACTED\]/g, "")
      data.sent.set(partID, text.length)
      data.visible.set(partID, (data.visible.get(partID) ?? "") + clean)
      return
    }
    if (kind === "assistant" && chunk) {
      chunk = stripEcho(data, msg, chunk)
      if (!chunk.trim()) {
        return
      }
    }
  }

  // Subsequent reasoning chunks: accumulate silently into visible (footer panel),
  // never push a progress commit into scrollback. The header and summary are
  // committed together by reasoningSummary once the part ends.
  if (kind === "reasoning") {
    data.sent.set(partID, text.length)
    data.visible.set(partID, (data.visible.get(partID) ?? "") + chunk)
    return
  }

  if (chunk) {
    data.sent.set(partID, text.length)
    data.visible.set(partID, (data.visible.get(partID) ?? "") + chunk)
    commits.push({
      kind,
      text: chunk,
      phase: "progress",
      source: kind === "user" ? "system" : kind,
      messageID: msg,
      partID,
    })
  }

  if (!interrupted) {
    return
  }

  commits.push({
    kind,
    text: "",
    phase: "final",
    source: kind === "user" ? "system" : kind,
    messageID: msg,
    partID,
    interrupted: true,
  })
}

// Commits the finished thinking block: the "● Thinking…" header followed by
// the tool-style "⎿ N lines" summary. Emitted only once a reasoning part
// finishes; while streaming, the block lives in the footer panel instead.
function reasoningSummary(data: SessionData, commits: SessionCommit[], partID: string) {
  const lines = (data.visible.get(partID) ?? "").split("\n").filter((line) => line.trim() !== "").length
  if (lines === 0) {
    return
  }

  commits.push({
    kind: "reasoning",
    text: "● Thinking…",
    phase: "start",
    source: "reasoning",
    messageID: data.msg.get(partID),
    partID,
  })
  commits.push({
    kind: "reasoning",
    text: lines === 1 ? "1 line" : `${lines} lines`,
    phase: "final",
    source: "reasoning",
    messageID: data.msg.get(partID),
    partID,
  })
}

function drop(data: SessionData, partID: string) {
  data.part.delete(partID)
  data.text.delete(partID)
  data.sent.delete(partID)
  data.visible.delete(partID)
  data.msg.delete(partID)
  data.end.delete(partID)
}

// Called when we learn a message's role (from message.updated). Flushes any
// buffered text parts that were waiting on role confirmation. User-role
// parts are silently dropped.
function replay(data: SessionData, commits: SessionCommit[], messageID: string, role: MessageRole, thinking: boolean) {
  for (const [partID, msg] of data.msg.entries()) {
    if (msg !== messageID || data.ids.has(partID)) {
      continue
    }

    if (role === "user" && !data.includeUserText) {
      data.ids.add(partID)
      drop(data, partID)
      continue
    }

    const kind = data.part.get(partID)
    if (!kind) {
      continue
    }

    if (role === "user" && kind === "assistant") {
      data.part.set(partID, "user")
    }

    if (kind === "reasoning" && !thinking) {
      if (data.end.has(partID)) {
        data.ids.add(partID)
      }
      drop(data, partID)
      continue
    }

    flushPart(data, commits, partID)

    if (!data.end.has(partID)) {
      continue
    }

    if (kind === "reasoning") {
      reasoningSummary(data, commits, partID)
    }

    data.ids.add(partID)
    drop(data, partID)
  }
}

function toolCommit(
  part: ToolPart,
  next: Pick<SessionCommit, "text" | "phase" | "toolState"> & { toolError?: string },
): SessionCommit {
  return {
    kind: "tool",
    source: "tool",
    messageID: part.messageID,
    partID: part.id,
    tool: part.tool,
    part,
    ...next,
  }
}

function shellPartID(callID: string): string {
  return `shell:${callID}`
}

function claimShell(data: SessionData, callID: string, source: ShellCall["source"], command?: string): ShellCall {
  const current = data.shell.get(callID)
  if (current) {
    if (command && !current.command) {
      current.command = command
    }

    return current
  }

  const next = {
    source,
    ...(command ? { command } : {}),
  } satisfies ShellCall
  data.shell.set(callID, next)
  return next
}

function bashCommand(part: ToolPart): string | undefined {
  if (part.tool !== "bash") {
    return undefined
  }

  const input = part.state.input
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined
  }

  const command = Reflect.get(input, "command")
  return typeof command === "string" ? command : undefined
}

function shellCommit(
  input: {
    callID: string
    command: string
  },
  next: Pick<SessionCommit, "text" | "phase" | "toolState">,
): SessionCommit {
  return {
    kind: "tool",
    source: "tool",
    partID: shellPartID(input.callID),
    tool: "bash",
    shell: input,
    ...next,
  }
}

function startShell(callID: string, command: string): SessionCommit {
  return shellCommit(
    {
      callID,
      command,
    },
    {
      text: "running shell",
      phase: "start",
      toolState: "running",
    },
  )
}

function doneShell(callID: string, command: string, output: string): SessionCommit {
  return shellCommit(
    {
      callID,
      command,
    },
    {
      text: output,
      phase: "progress",
      toolState: "completed",
    },
  )
}

function startTool(part: ToolPart): SessionCommit {
  return toolCommit(part, {
    text: toolStatus(part),
    phase: "start",
    toolState: "running",
  })
}

function doneTool(part: ToolPart): SessionCommit {
  return toolCommit(part, {
    text: "",
    phase: "final",
    toolState: "completed",
  })
}

function failTool(part: ToolPart, text: string): SessionCommit {
  return toolCommit(part, {
    text,
    phase: "final",
    toolState: "error",
    toolError: text,
  })
}

function extractThinking(data: SessionData): FooterThinkingState | undefined {
  // Find the active reasoning part (the one with text but no end yet)
  for (const [partID, kind] of data.part.entries()) {
    if (kind !== "reasoning") continue
    if (data.ids.has(partID)) continue
    if (data.end.has(partID)) continue
    const text = data.visible.get(partID) ?? data.text.get(partID) ?? ""
    if (!text.trim()) continue
    const lines = text.split("\n").length
    return { active: true, text, lines, expanded: false }
  }
  return undefined
}

function extractTodos(input: unknown): FooterTodoItem[] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined
  }

  const todos = Reflect.get(input, "todos")
  if (!Array.isArray(todos)) {
    return undefined
  }

  return todos.flatMap((item): FooterTodoItem[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return []
    }

    const content = typeof Reflect.get(item, "content") === "string" ? Reflect.get(item, "content") : ""
    if (!content) {
      return []
    }

    const status = typeof Reflect.get(item, "status") === "string" ? Reflect.get(item, "status") : ""
    return [{ status, content }]
  })
}

// Emits "interrupted" final entries for all in-flight parts. Called when a turn is aborted.
export function flushInterrupted(data: SessionData, commits: SessionCommit[]) {
  for (const partID of data.part.keys()) {
    if (data.ids.has(partID)) {
      continue
    }

    const msg = data.msg.get(partID)
    if (msg && data.role.get(msg) === "user" && !data.includeUserText) {
      data.ids.add(partID)
      drop(data, partID)
      continue
    }

    flushPart(data, commits, partID, true)

    // Reasoning streams silently, so an aborted part has no committed header
    // yet: emit the header plus an interrupted final so the block still reads
    // "● Thinking…" / "⎿ interrupted". Parts with no visible text stay silent.
    if (data.part.get(partID) === "reasoning" && (data.visible.get(partID) ?? "").trim()) {
      commits.push({
        kind: "reasoning",
        text: "● Thinking…",
        phase: "start",
        source: "reasoning",
        messageID: data.msg.get(partID),
        partID,
      })
      commits.push({
        kind: "reasoning",
        text: "",
        phase: "final",
        source: "reasoning",
        messageID: data.msg.get(partID),
        partID,
        interrupted: true,
      })
    }

    data.ids.add(partID)
    drop(data, partID)
  }
}

// The main reducer. Takes one SDK event and returns scrollback commits and
// footer updates. Called once per event from the stream transport's watch loop.
//
// Event handling follows the SDK event types:
//   message.updated      → learn role, flush buffered parts, track usage
//   message.part.delta   → accumulate text, flush if ready
//   message.part.updated → handle text/reasoning/tool state transitions
//   permission.*         → manage the permission queue, drive footer view
//   question.*           → manage the question queue, drive footer view
//   session.error        → emit error scrollback entry
//   session.diff         → update the ✎ modified-file pill count
export function reduceSessionData(input: SessionDataInput): SessionDataOutput {
  const commits: SessionCommit[] = []
  const data = input.data
  const event = input.event

  if (event.type === "session.next.shell.started") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    const shell = claimShell(data, event.properties.callID, "shell", event.properties.command)
    if (shell.source !== "shell") {
      return out(data, commits)
    }

    const partID = shellPartID(event.properties.callID)
    if (data.ids.has(partID) || data.tools.has(partID)) {
      return out(data, commits, patch({ status: "running shell" }))
    }

    data.tools.add(partID)
    commits.push(startShell(event.properties.callID, shell.command ?? event.properties.command))
    return out(data, commits, patch({ status: "running shell" }))
  }

  if (event.type === "session.next.shell.ended") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    const shell = claimShell(data, event.properties.callID, "shell")
    if (shell.source !== "shell") {
      return out(data, commits)
    }

    const partID = shellPartID(event.properties.callID)
    const seen = data.tools.has(partID)
    const command = shell.command ?? ""
    data.tools.delete(partID)
    if (data.ids.has(partID)) {
      return out(data, commits)
    }

    if (!seen && command) {
      commits.push(startShell(event.properties.callID, command))
    }

    data.ids.add(partID)
    commits.push(doneShell(event.properties.callID, command, event.properties.output))
    return out(data, commits)
  }

  if (event.type === "message.updated") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    const info = event.properties.info
    if (typeof info.id === "string") {
      data.role.set(info.id, info.role)
      replay(data, commits, info.id, info.role, input.thinking)
    }

    if (info.role !== "assistant") {
      return out(data, commits)
    }

    let next: FooterPatch | undefined
    if (!data.announced) {
      data.announced = true
      next = { status: "assistant responding" }
    }

    const metrics = usageMetrics(info.tokens, input.limits[modelKey(info.providerID, info.modelID)])
    const cost = typeof info.cost === "number" ? info.cost : undefined
    if (metrics.tokens > 0 || (typeof cost === "number" && cost > 0)) {
      next = {
        ...next,
        contextTokens: metrics.tokens,
        contextPercent: metrics.percent,
        cost: cost ?? 0,
      }
    }

    if (typeof info.id === "string" && info.error && !isAbort(info.error) && !data.ids.has(msgErr(info.id))) {
      data.ids.add(msgErr(info.id))
      commits.push({
        kind: "error",
        text: formatError(info.error),
        phase: "start",
        source: "system",
        messageID: info.id,
      })
    }

    return out(data, commits, patch(next))
  }

  if (event.type === "message.part.delta") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    if (
      typeof event.properties.partID !== "string" ||
      typeof event.properties.field !== "string" ||
      typeof event.properties.delta !== "string"
    ) {
      return out(data, commits)
    }

    if (event.properties.field !== "text") {
      return out(data, commits)
    }

    const partID = event.properties.partID
    if (data.ids.has(partID)) {
      return out(data, commits)
    }

    if (typeof event.properties.messageID === "string") {
      data.msg.set(partID, event.properties.messageID)
    }

    const text = data.text.get(partID) ?? ""
    data.text.set(partID, text + event.properties.delta)

    const kind = data.part.get(partID)
    if (!kind) {
      return out(data, commits)
    }

    if (kind === "reasoning" && !input.thinking) {
      return out(data, commits)
    }

    if (!ready(data, partID)) {
      return out(data, commits)
    }

    flushPart(data, commits, partID)

    // Emit footer thinking patch for reasoning text
    if (kind === "reasoning") {
      const thinking = extractThinking(data)
      if (thinking) {
        return out(data, commits, { thinking })
      }
    }

    return out(data, commits)
  }

  if (event.type === "message.part.updated") {
    const part = event.properties.part
    if (part.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    if (part.type === "tool") {
      const view = syncPermission(data, part) ?? syncQuestion(data, part)
      if (part.tool === "bash" && part.callID) {
        if (claimShell(data, part.callID, "tool", bashCommand(part)).source === "shell") {
          return out(data, commits, view)
        }
      }

      if (part.state.status === "running") {
        if (data.ids.has(part.id)) {
          return out(data, commits, view)
        }

        if (!data.tools.has(part.id)) {
          data.tools.add(part.id)
          commits.push(startTool(part))
        }

        const todos = part.tool === "todowrite" ? extractTodos(part.state.input) : undefined
        const footer = view || todos ? { ...view, todos } : undefined
        return out(data, commits, footer ?? patch({ status: toolStatus(part) }))
      }

      if (part.state.status === "completed") {
        const seen = data.tools.has(part.id)
        const mode = toolView(part.tool)
        data.tools.delete(part.id)
        if (data.ids.has(part.id)) {
          return out(data, commits, view)
        }

        if (!seen) {
          commits.push(startTool(part))
        }

        data.ids.add(part.id)
        stashEcho(data, part)

        const output = part.state.output
        if (mode.output && typeof output === "string" && output.trim()) {
          commits.push({
            kind: "tool",
            text: output,
            phase: "progress",
            source: "tool",
            messageID: part.messageID,
            partID: part.id,
            tool: part.tool,
            part,
            toolState: "completed",
          })
        }

        if (mode.final) {
          commits.push(doneTool(part))
        }

        const todos = part.tool === "todowrite" ? extractTodos(part.state.input) : undefined
        const footer = view || todos ? { ...view, todos } : undefined
        return out(data, commits, footer)
      }

      if (part.state.status === "error") {
        const seen = data.tools.has(part.id)
        data.tools.delete(part.id)
        if (data.ids.has(part.id)) {
          return out(data, commits, view)
        }

        if (!seen) {
          commits.push(startTool(part))
        }

        data.ids.add(part.id)
        const text =
          typeof part.state.error === "string" && part.state.error.trim() ? part.state.error : "unknown error"
        commits.push(failTool(part, text))
        return out(data, commits, view)
      }
    }

    if (part.type !== "text" && part.type !== "reasoning") {
      return out(data, commits)
    }

    if (data.ids.has(part.id)) {
      return out(data, commits)
    }

    const kind = part.type === "text" ? "assistant" : "reasoning"
    if (typeof part.messageID === "string") {
      data.msg.set(part.id, part.messageID)
    }

    const msg = part.messageID
    const role = msg ? data.role.get(msg) : undefined
    if (role === "user" && part.type === "text" && !data.includeUserText) {
      data.ids.add(part.id)
      drop(data, part.id)
      return out(data, commits)
    }

    if (kind === "reasoning" && !input.thinking) {
      if (part.time?.end) {
        data.ids.add(part.id)
      }
      drop(data, part.id)
      return out(data, commits)
    }

    data.part.set(part.id, role === "user" && kind === "assistant" ? "user" : kind)
    syncText(data, part.id, part.text)

    if (part.time?.end) {
      data.end.add(part.id)
    }

    if (msg && !role) {
      return out(data, commits)
    }

    if (!ready(data, part.id)) {
      return out(data, commits)
    }

    flushPart(data, commits, part.id)

    if (!part.time?.end) {
      // Emit thinking patch for reasoning text while still streaming
      if (kind === "reasoning") {
        const thinking = extractThinking(data)
        if (thinking) {
          return out(data, commits, { thinking })
        }
      }
      return out(data, commits)
    }

    if (kind === "reasoning") {
      reasoningSummary(data, commits, part.id)
    }

    data.ids.add(part.id)
    drop(data, part.id)

    // Clear thinking footer when reasoning part ends
    if (kind === "reasoning") {
      return out(data, commits, { thinking: { active: false, text: "", lines: 0, expanded: false } })
    }

    return out(data, commits)
  }

  if (event.type === "permission.asked") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    // If the request is eligible for LLM judging (auto), delay the ask
    // screen until the judge returns. Store in pendingJudge; the
    // permission.judged event will move it to data.permissions if the
    // judge rejects (outcome "ask").
    if (event.properties.auto === true) {
      const request = enrichPermission(data, event.properties)
      data.pendingJudge.set(request.id, request)
      return out(data, commits, patch({ judging: true }))
    }

    upsert(data.permissions, enrichPermission(data, event.properties))
    return queueOut(data, commits)
  }

  if (event.type === "permission.replied") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    // A judge auto-allow replies before publishing permission.judged, so this
    // may be the event that clears a pendingJudge entry — recompute judging.
    const hadPending = data.pendingJudge.delete(event.properties.requestID)
    data.judgeReasons.delete(event.properties.requestID)
    if (!remove(data.permissions, event.properties.requestID)) {
      if (hadPending) {
        return out(data, commits, patch({ judging: data.pendingJudge.size > 0 }))
      }
      return out(data, commits)
    }

    return queueOut(data, commits)
  }

  if (event.type === "question.asked") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    upsert(data.questions, event.properties)
    return queueOut(data, commits)
  }

  if (event.type === "question.replied" || event.type === "question.rejected") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    if (!remove(data.questions, event.properties.requestID)) {
      return out(data, commits)
    }

    return queueOut(data, commits)
  }

  if (event.type === "session.error") {
    if (event.properties.sessionID !== input.sessionID || !event.properties.error) {
      return out(data, commits)
    }

    commits.push({
      kind: "error",
      text: formatError(event.properties.error),
      phase: "start",
      source: "system",
    })
    return out(data, commits)
  }

  // Rule/hook permission denials (P4). Surfaced as a muted one-line scrollback
  // notice for the bound (main) session only -- subagent denies are not
  // routed here (see subagent-data.ts's reduceSubagentData event list).
  if (event.type === "permission.denied") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    commits.push({
      kind: "system",
      text: formatPermissionDenied(event.properties),
      phase: "start",
      source: "system",
    })
    return out(data, commits)
  }

  if (event.type === "permission.judged") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    const requestID = event.properties.requestID
    const pending = data.pendingJudge.get(requestID)
    const outcome = (event.properties as { outcome?: string }).outcome
    data.pendingJudge.delete(requestID)
    const stillJudging = data.pendingJudge.size > 0

    if (outcome === "ask") {
      // Judge escalated: show the ask screen now, with the judge's reason.
      // Without a pendingJudge entry the request was already replied — there
      // is no prompt left to surface.
      if (!pending) {
        return out(data, commits, patch({ judging: stillJudging }))
      }
      upsert(data.permissions, enrichPermission(data, pending))
      data.judgeReasons.set(requestID, event.properties.reason || "")
      commits.push({
        kind: "system",
        text: `● LLM judge escalated to manual approval — ${event.properties.reason || "no reason"}`,
        phase: "start",
        source: "system",
      })

      return out(data, commits, {
        view: pickSessionView(data),
        patch: { judging: stillJudging },
      })
    }

    // outcome === "allowed": auto-allowed by judge. The judge replies "once"
    // before publishing Judged, so permission.replied has usually already
    // cleared pendingJudge — the notice must not depend on the entry.
    commits.push({
      kind: "system",
      text: formatPermissionJudged(event.properties),
      phase: "start",
      source: "system",
    })
    return out(data, commits, patch({ judging: stillJudging }))
  }

  // Monitor one-line muted notices for the bound (main) session.
  if ((event.type as string) === "monitor.event") {
    const props = event.properties as { sessionID: string; description: string; lines: string[] }
    if (props.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    const first = props.lines[0] ?? ""
    const suffix = props.lines.length > 1 ? ` (+${props.lines.length - 1} more)` : ""
    commits.push({
      kind: "system",
      text: `⏺ monitor(${props.description}): ${first}${suffix}`,
      phase: "start",
      source: "system",
    })
    return out(data, commits)
  }

  if ((event.type as string) === "monitor.stopped") {
    const props = event.properties as { sessionID: string; description: string; reason: string }
    if (props.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    commits.push({
      kind: "system",
      text: `⏺ monitor(${props.description}) stopped — ${props.reason}`,
      phase: "start",
      source: "system",
    })
    return out(data, commits)
  }

  // AUTO pill state follows the server's session record. The /auto toggle
  // round-trips through session.update, so this event both confirms the
  // toggle and reflects changes made by other clients.
  if (event.type === "session.updated") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    return out(data, commits, patch({ automode: event.properties.info.automode === true }))
  }

  // Modified-file count for the ✎ pill (P3). Subagent sessions also emit
  // session.diff, but we only surface the bound session's count.
  if (event.type === "session.diff") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    return out(data, commits, patch({ modified: event.properties.diff.length }))
  }

  return out(data, commits)
}
