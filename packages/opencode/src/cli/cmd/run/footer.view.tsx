// Footer layout
//
// Renders the footer region as a compact vertical stack:
//   1. Single-line composer or active footer body
//   2. Optional autocomplete/menu panels below the composer
//   3. A statusline-style footer row carrying state, hints, and model info
//
// All state comes from the parent RunFooter through SolidJS signals.
// The view itself is stateless except for derived memos.
/** @jsxImportSource @opentui/solid */
import { useTerminalDimensions } from "@opentui/solid"
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { registerOpencodeSpinner } from "@/cli/ui/component/register-spinner"
import { Spinner } from "@/cli/ui/component/spinner"
import { useKV } from "@/cli/ui/context/kv"

import { RGBA } from "@opentui/core"
import { budgetState } from "@opencode-ai/core/session/runner/budget"
import * as Locale from "@/util/locale"
import {
  RUN_SUBAGENT_PANEL_ROWS,
  RunAgentSelectBody,
  RunCommandMenuBody,
  RunModelSelectBody,
  RunQueuedPromptSelectBody,
  RunSkillSelectBody,
  RunSubagentSelectBody,
  RunVariantSelectBody,
} from "./footer.command"
import { FOOTER_MENU_ROWS, RunFooterMenu } from "./footer.menu"
import { canOpenSessionsMenu, RunSessionSelectBody } from "./footer.sessions"
import { RunFooterSubagentBody } from "./footer.subagent"
import { RunSubagentTree, subagentTreeRowCount } from "./footer.subagent-tree"
import { RunPromptBody, createPromptState } from "./footer.prompt"
import { RunPermissionBody } from "./footer.permission"
import { RunQuestionBody } from "./footer.question"
import { fitStatusline, statuslineGap, type StatuslineGroup, type StatuslineSegment } from "./footer.width"
import {
  OPENCODE_BASE_MODE,
  formatKeyBindings,
  formatKeySequence,
  useBindings,
  useKeymapSelector,
  type OpenTuiKeymap,
} from "@/cli/ui/keymap"
import { modeCycle, modeIndicator, type PermissionMode } from "./mode.shared"
import type {
  FooterPromptRoute,
  FooterQueuedPrompt,
  FooterSessionTab,
  FooterState,
  FooterSubagentState,
  FooterThinkingState,
  FooterTodoItem,
  FooterView,
  PermissionReply,
  QuestionReject,
  QuestionReply,
  RunAgent,
  RunCommand,
  RunDiffStyle,
  RunInput,
  RunPrompt,
  RunProvider,
  RunResource,
  RunTuiConfig,
} from "./types"
import type { RunFooterTheme, RunTheme } from "./theme"
import { modelInfo } from "./variant.shared"

registerOpencodeSpinner()

// A blinking ● dot for the judging indicator.
// Respects animationsEnabled: when disabled, shows a static ●.
function BlinkingDot(props: { theme: () => RunFooterTheme; color?: () => RGBA }) {
  const enabled = (): boolean => {
    try {
      return useKV().get("animations_enabled", true)
    } catch {
      return true
    }
  }
  const [frame, setFrame] = createSignal(0)

  createEffect(() => {
    if (!enabled()) return
    const id = setInterval(() => setFrame((i) => i + 1), 600)
    onCleanup(() => clearInterval(id))
  })

  const dotColor = () => props.color?.() ?? props.theme().muted

  return <text fg={dotColor()}>{enabled() ? (frame() % 2 === 0 ? "●" : " ") : "●"}</text>
}

const EMPTY_BORDER = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

type RunFooterViewProps = {
  directory: string
  findFiles: (query: string) => Promise<string[]>
  agents: () => RunAgent[]
  resources: () => RunResource[]
  commands: () => RunCommand[] | undefined
  providers: () => RunProvider[] | undefined
  currentModel: () => RunInput["model"]
  variants: () => string[]
  currentVariant: () => string | undefined
  state: () => FooterState
  view?: () => FooterView
  subagent?: () => FooterSubagentState
  queuedPrompts?: () => FooterQueuedPrompt[]
  todos?: () => FooterTodoItem[]
  todoSummary?: () => boolean
  thinking?: () => FooterThinkingState | undefined
  sessions?: () => FooterSessionTab[]
  sessionID?: () => string | undefined
  theme: () => RunTheme
  diffStyle?: RunDiffStyle
  tuiConfig: RunTuiConfig
  backgroundSubagents: boolean
  history?: RunPrompt[]
  currentAgent: () => string
  onSubmit: (input: RunPrompt) => boolean
  onPermissionReply: (input: PermissionReply) => void | Promise<void>
  onPermissionModeCycle?: () => void
  onQuestionReply: (input: QuestionReply) => void | Promise<void>
  onQuestionReject: (input: QuestionReject) => void | Promise<void>
  onCycle: () => void
  onInterrupt: () => boolean
  onBackground?: () => void
  onEditorOpen: (input: { value: string }) => Promise<string | undefined>
  onInputClear: () => void
  onExitRequest?: () => boolean
  onRequestExit?: (fn: (() => boolean) | undefined) => void
  onExit: () => void
  onModelSelect: (model: NonNullable<RunInput["model"]>) => void
  onAgentSelect: (agent: string) => void
  onVariantSelect: (variant: string | undefined) => void
  onRows: (rows: number) => void
  onLayout: (input: { route: FooterPromptRoute; autocomplete: boolean; subagentRows: number }) => void
  onStatus: (text: string) => void
  onSubagentSelect?: (sessionID: string | undefined) => void
  onQueuedRemove: (messageID: string) => Promise<boolean>
  onSessionSelect?: (sessionID: string, title: string | undefined) => void
  onSessionsOpen?: () => void
  onAutoToggle?: () => void
}

export { TEXTAREA_MIN_ROWS, TEXTAREA_MAX_ROWS } from "./footer.prompt"

export const MAX_TODO_ROWS = 6

// Rows the todo panel takes within a `cap`: one per visible todo, plus one
// more when the list is truncated (for the "… +N more" row). Shared with
// RunFooter.applyHeight() so the reserved footer height always matches what
// RunFooterTodoPanel actually renders.
export function todoPanelRowCount(total: number, summary: boolean, cap: number): number {
  if (total === 0) {
    return 0
  }

  if (summary) {
    return Math.min(1, cap)
  }

  const rows = Math.min(Math.min(total, MAX_TODO_ROWS) + (total > MAX_TODO_ROWS ? 1 : 0), cap)
  // A single row can only hold the "… +N more" line, which says nothing the
  // ☐N counter on the statusline does not already say.
  return rows === 1 && total > 1 ? 0 : rows
}

// Inverse of the above: todo items to draw once the panel knows its rows. One
// row goes to "… +N more" whenever anything is left out.
export function todoPanelVisible(total: number, rows: number): number {
  return rows >= total ? total : Math.max(0, rows - 1)
}

export const MAX_THINKING_ROWS = 10

// Rolling tail of the live thinking text, pre-wrapped to terminal width so
// each row is exactly one cell row. First row carries the tool-style ⎿
// marker so the block reads as one unit with the committed "● Thinking…"
// header directly above the footer.
export function thinkingTailRows(text: string, width: number, max = MAX_THINKING_ROWS): string[] {
  // slice(-0) returns the whole array, so a zero budget has to short-circuit.
  if (max <= 0) {
    return []
  }

  const cols = Math.max(10, width - 5)
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) =>
      Array.from({ length: Math.ceil(line.length / cols) }, (_, i) => line.slice(i * cols, (i + 1) * cols)),
    )
    .slice(-max)
    .map((row, index) => (index === 0 ? `  ⎿  ${row}` : `     ${row}`))
}

// Combined row budget for the panels stacked above the composer. Uncapped, a
// live thinking tail, a long todo list, and a subagent tree claim twenty rows
// between them and push the composer off the top of a short terminal.
export function footerPanelBudget(terminalHeight: number): number {
  return Math.max(4, Math.floor(terminalHeight / 2))
}

// Shares that budget out in the order the rows earn their keep: the subagent
// tree is live work, the todo list is the plan, and the thinking tail is
// ephemeral -- it gets committed to scrollback when the reasoning part ends,
// so losing rows off the live tail costs the least.
//
// Returns the rows each panel will actually draw, not a cap it may undershoot.
// Both RunFooterView and RunFooter.applyHeight() go through this, so the
// reserved footer height always matches what ends up on screen.
export function footerPanelRows(input: {
  budget: number
  // Thinking panel rows the tail wants: 0, or the tail length plus its header.
  thinking: number
  todos: number
  todoSummary: boolean
  tabs: number
}) {
  // The tree takes what the other two leave it, but never less than half the
  // budget: a fleet of subagents is worth seeing, and so is the plan under it.
  const wanted = todoPanelRowCount(input.todos, input.todoSummary, input.budget)
  const tree = subagentTreeRowCount(
    input.tabs,
    Math.max(Math.ceil(input.budget / 2), input.budget - wanted - input.thinking),
  )
  const todos = todoPanelRowCount(input.todos, input.todoSummary, input.budget - tree)
  const thinking = Math.min(input.thinking, input.budget - tree - todos)
  // A lone header with no tail under it says nothing, so the panel takes two
  // rows or none.
  return { tree, todos, thinking: thinking < 2 ? 0 : thinking }
}

// Context usage below this is not worth a pill -- it is the normal state of
// every session for its first hour.
const CTX_PILL_MIN_PERCENT = 50

// Columns the status zone occupies even when idle and empty: its box carries
// minWidth={12} plus a column of padding on each side, and the right zone
// adds one more. Counted so the fit below never hands out columns that the
// flexbox will then take back by truncating.
const STATUS_MIN_COLUMNS = 12
const STATUSLINE_PADDING = 4

// Statusline drop order, lowest first. Counters describing accumulated work go
// before the model name (checkable any time from the command palette), which
// goes before an action only available right now, which goes before the two
// numbers that can actually stop a turn.
const STATUSLINE_PRIORITY = {
  modified: 1,
  todos: 2,
  monitor: 3,
  queued: 4,
  model: 5,
  background: 6,
  cost: 7,
  ctx: 8,
  command: 9,
} as const

type StatuslinePart = { text: string; color: RunFooterTheme["muted"]; bold?: boolean }
type StatuslineItem = StatuslineSegment & { parts: StatuslinePart[] }

function statuslineItem(
  key: string,
  group: StatuslineGroup,
  priority: number,
  parts: StatuslinePart[],
): StatuslineItem {
  return { key, group, priority, parts, text: parts.map((part) => part.text).join("") }
}

// ctrl+p -> ^p. Chorded sequences keep their tail ("ctrl+x down" -> "^x down").
function compactKey(sequence: string): string {
  return sequence.replaceAll("ctrl+", "^")
}

export function RunFooterView(props: RunFooterViewProps) {
  const term = useTerminalDimensions()
  const width = createMemo(() => term().width)
  const active = createMemo<FooterView>(() => props.view?.() ?? { type: "prompt" })
  const subagent = createMemo<FooterSubagentState>(() => {
    return (
      props.subagent?.() ?? {
        tabs: [],
        details: {},
        permissions: [],
        questions: [],
      }
    )
  })
  const [route, setRoute] = createSignal<FooterPromptRoute>({ type: "composer" })
  const [subagentMenuRows, setSubagentMenuRows] = createSignal(RUN_SUBAGENT_PANEL_ROWS)
  const queuedPrompts = createMemo(() => props.queuedPrompts?.() ?? [])
  const sessions = createMemo(() => props.sessions?.() ?? [])
  const skills = createMemo(() => (props.commands() ?? []).filter((item) => item.source === "skill"))
  const prompt = createMemo(() => active().type === "prompt" && route().type === "composer")
  const selectingSubagent = createMemo(() => active().type === "prompt" && route().type === "subagent-menu")
  const selectingQueued = createMemo(() => active().type === "prompt" && route().type === "queued-menu")
  const inspecting = createMemo(() => active().type === "prompt" && route().type === "subagent")
  const commanding = createMemo(() => active().type === "prompt" && route().type === "command")
  const skilling = createMemo(() => active().type === "prompt" && route().type === "skill")
  const modeling = createMemo(() => active().type === "prompt" && route().type === "model")
  const agenting = createMemo(() => active().type === "prompt" && route().type === "agent")
  const varianting = createMemo(() => active().type === "prompt" && route().type === "variant")
  const selectingSession = createMemo(() => active().type === "prompt" && route().type === "sessions")
  const panel = createMemo(
    () =>
      active().type === "permission" ||
      active().type === "question" ||
      selectingQueued() ||
      selectingSubagent() ||
      commanding() ||
      skilling() ||
      modeling() ||
      agenting() ||
      varianting() ||
      selectingSession(),
  )
  const selected = createMemo(() => {
    const current = route()
    return current.type === "subagent" ? current.sessionID : undefined
  })
  const tabs = createMemo(() => subagent().tabs)
  const activeTabs = createMemo(() => tabs().filter((item) => item.status === "running"))
  const selectedTab = createMemo(() => tabs().find((item) => item.sessionID === selected()))
  const selectedIndex = createMemo(() => {
    const sessionID = selected()
    if (!sessionID) {
      return 0
    }

    return tabs().findIndex((item) => item.sessionID === sessionID) + 1
  })
  const foregroundSubagents = createMemo(
    () => props.backgroundSubagents && activeTabs().some((item) => !item.background),
  )
  const model = createMemo(() => {
    const current = props.currentModel()
    return current ? modelInfo(props.providers(), current) : { model: props.state().model, provider: undefined }
  })
  const detail = createMemo(() => {
    const current = route()
    return current.type === "subagent" ? subagent().details[current.sessionID] : undefined
  })
  const command = useKeymapSelector(
    (keymap: OpenTuiKeymap) =>
      formatKeySequence(
        keymap
          .getCommandBindings({ visibility: "registered", commands: ["command.palette.show"] })
          .get("command.palette.show")?.[0]?.sequence,
        props.tuiConfig,
      ) ?? "",
  )
  const backgroundShortcut = useKeymapSelector(
    (keymap: OpenTuiKeymap) =>
      formatKeySequence(
        keymap
          .getCommandBindings({ visibility: "registered", commands: ["session.background"] })
          .get("session.background")?.[0]?.sequence,
        props.tuiConfig,
      ) ?? "",
  )
  const interrupt = useKeymapSelector(
    (keymap: OpenTuiKeymap) =>
      formatKeySequence(
        keymap
          .getCommandBindings({ visibility: "registered", commands: ["session.interrupt"] })
          .get("session.interrupt")?.[0]?.sequence,
        props.tuiConfig,
      ) ?? "",
  )
  const variantCycle = useKeymapSelector(
    (keymap: OpenTuiKeymap) =>
      formatKeyBindings(
        keymap.getCommandBindings({ visibility: "registered", commands: ["variant.cycle"] }).get("variant.cycle"),
        props.tuiConfig,
      ) ?? "",
  )
  const clearShortcut = useKeymapSelector(
    (keymap: OpenTuiKeymap) =>
      formatKeySequence(
        keymap.getCommandBindings({ visibility: "registered", commands: ["prompt.clear"] }).get("prompt.clear")?.[0]
          ?.sequence,
        props.tuiConfig,
      ) ?? "",
  )
  const busy = createMemo(() => props.state().phase === "running")
  const subagentRunning = createMemo(() => tabs().some((t) => t.status === "running"))
  const armed = createMemo(() => props.state().interrupt > 0)
  const exiting = createMemo(() => props.state().exit > 0)
  const queue = createMemo(() => props.state().queue)
  const contextTokens = createMemo(() => props.state().contextTokens)
  const contextPercent = createMemo(() => props.state().contextPercent)
  const cost = createMemo(() => props.state().cost)
  // Budget-aware cost pill (P4): the current session's agent may carry a
  // soft/hard USD budget. Undefined when the agent has none configured, in
  // which case the cost pill falls back to its plain (non-fraction) form.
  const agentBudget = createMemo(() => props.agents().find((item) => item.name === props.state().agent)?.budget)
  const modifiedCount = createMemo(() => props.state().modified)
  const monitorCount = createMemo(() => props.state().monitorCount)
  const todoCount = createMemo(() => (props.todos?.() ?? []).filter((item) => item.status !== "completed").length)
  const interruptLabel = createMemo(() => {
    if (!interrupt()) {
      return
    }

    return interrupt() === "escape" ? "esc" : interrupt()
  })
  const runTheme = createMemo(() => props.theme())
  const theme = createMemo(() => runTheme().footer)
  const block = createMemo(() => runTheme().block)
  const permission = createMemo<Extract<FooterView, { type: "permission" }> | undefined>(() => {
    const view = active()
    return view.type === "permission" ? view : undefined
  })
  const question = createMemo<Extract<FooterView, { type: "question" }> | undefined>(() => {
    const view = active()
    return view.type === "question" ? view : undefined
  })
  const permissionMode = createMemo<PermissionMode>(() => props.state().permissionMode)
  const permissionModeIndicator = createMemo(() => modeIndicator(permissionMode()))
  const judging = createMemo(() => props.state().judging)
  const promptView = createMemo(() => {
    if (active().type !== "prompt") {
      return active().type
    }

    const current = route()
    return current.type === "composer" ? "prompt" : current.type
  })

  const openCommand = () => {
    setRoute({ type: "command" })
    props.onSubagentSelect?.(undefined)
  }

  const openModel = () => {
    setRoute({ type: "model" })
    props.onSubagentSelect?.(undefined)
  }

  const openAgent = () => {
    setRoute({ type: "agent" })
    props.onSubagentSelect?.(undefined)
  }

  const openSkillMenu = () => {
    if (props.commands() && skills().length === 0) {
      return
    }

    setRoute({ type: "skill" })
    props.onSubagentSelect?.(undefined)
  }

  const openVariant = () => {
    setRoute({ type: "variant" })
    props.onSubagentSelect?.(undefined)
  }

  const openSubagentMenu = () => {
    if (tabs().length === 0) {
      return
    }

    setRoute({ type: "subagent-menu" })
    props.onSubagentSelect?.(undefined)
  }

  const openQueuedMenu = () => {
    if (queuedPrompts().length === 0) return
    setRoute({ type: "queued-menu" })
    props.onSubagentSelect?.(undefined)
  }

  // Idle-only guard: a switch mid-turn would tear down the stream the active
  // turn is running on, so refuse to even open the list and surface a notice
  // through the same status-patch mechanism as other footer notices.
  const openSessionsMenu = () => {
    if (!canOpenSessionsMenu(props.state())) {
      props.onStatus("finish the current turn before switching sessions")
      return
    }

    setRoute({ type: "sessions" })
    props.onSubagentSelect?.(undefined)
    props.onSessionsOpen?.()
  }

  const closePanel = () => {
    setRoute({ type: "composer" })
  }

  const openTab = (sessionID: string) => {
    setRoute({ type: "subagent", sessionID })
    props.onSubagentSelect?.(sessionID)
  }

  const closeTab = () => {
    setRoute({ type: "composer" })
    props.onSubagentSelect?.(undefined)
  }

  const cycleTab = (dir: -1 | 1) => {
    if (tabs().length === 0) {
      return
    }

    const routeState = route()
    const current =
      routeState.type === "subagent" ? tabs().findIndex((item) => item.sessionID === routeState.sessionID) : -1
    const index = current === -1 ? 0 : (current + dir + tabs().length) % tabs().length
    const next = tabs()[index]
    if (!next) {
      return
    }

    openTab(next.sessionID)
  }
  const composer = createPromptState({
    directory: props.directory,
    findFiles: props.findFiles,
    agents: props.agents,
    resources: props.resources,
    commands: props.commands,
    tuiConfig: props.tuiConfig,
    state: props.state,
    view: promptView,
    prompt,
    width,
    theme,
    history: props.history,
    onSubmit: props.onSubmit,
    onCycle: props.onCycle,
    onInterrupt: props.onInterrupt,
    onEditorOpen: props.onEditorOpen,
    onInputClear: props.onInputClear,
    onExitRequest: props.onExitRequest,
    onExit: props.onExit,
    onSkillMenu: openSkillMenu,
    onModel: openModel,
    onAgent: openAgent,
    onSessions: openSessionsMenu,
    onVariant: openVariant,
    onRows: props.onRows,
    onStatus: props.onStatus,
    onAutoToggle: props.onAutoToggle,
  })
  const shell = createMemo(() => prompt() && composer.shell())
  const menu = createMemo(() => prompt() && composer.visible())
  const stateStatus = createMemo(() => props.state().status.trim())
  const modeLabel = createMemo(() => {
    if (exiting()) {
      return "EXIT"
    }

    return shell() ? "SHELL" : props.state().agent.toUpperCase()
  })
  const statusText = createMemo(() => {
    if (exiting()) {
      return `Press ${clearShortcut() || "ctrl+c"} again to exit`
    }

    if (busy()) {
      return armed() ? "again to interrupt" : "interrupt"
    }

    if (stateStatus().length > 0) {
      return stateStatus()
    }

    return shell() ? "Shell mode" : ""
  })
  // Statusline right zone: quiet by default, packed by measurement.
  //
  // A counter only appears once it is worth reacting to (P3's pills were
  // always on, so an untouched session still rendered five of them), key hints
  // collapse into the command palette they duplicate, and whatever survives is
  // composed into one text node -- as separate boxes they used to overwrite
  // each other whenever the row overflowed.
  const ctxColor = createMemo(() => {
    const percent = contextPercent()
    if (percent === null) {
      return theme().muted
    }
    if (percent >= 95) {
      return theme().error
    }
    if (percent >= 80) {
      return theme().warning
    }
    return theme().muted
  })
  const statusColor = createMemo(() => {
    if (exiting()) {
      return theme().error
    }

    if (armed()) {
      return theme().highlight
    }

    if (busy() || stateStatus().length > 0) {
      return theme().text
    }

    return theme().muted
  })
  const budgetPill = createMemo(() => {
    const budget = agentBudget()
    if (!budget || (budget.soft === undefined && budget.hard === undefined)) {
      return
    }

    const state = budgetState(cost(), budget)
    return {
      state,
      // "$1.52/1.50": the denominator drops its currency mark, which the
      // numerator already establishes.
      text: `${Locale.money(cost())}/${(budget.soft ?? budget.hard!).toFixed(2)}`,
      color: state === "ok" ? theme().muted : state === "soft" ? theme().warning : theme().error,
    }
  })
  const metricItems = createMemo(() => {
    const items: StatuslineItem[] = []
    const percent = contextPercent()
    const tokens = contextTokens()
    if (percent !== null && percent >= CTX_PILL_MIN_PERCENT) {
      items.push(
        statuslineItem("ctx", "metrics", STATUSLINE_PRIORITY.ctx, [{ text: `◆${percent}%`, color: ctxColor() }]),
      )
    } else if (percent === null && tokens > 0) {
      items.push(
        statuslineItem("ctx", "metrics", STATUSLINE_PRIORITY.ctx, [
          { text: `◆${Locale.number(tokens)}`, color: theme().muted },
        ]),
      )
    }

    if (cost() > 0) {
      const budget = budgetPill()
      items.push(
        statuslineItem("cost", "metrics", STATUSLINE_PRIORITY.cost, [
          budget ? { text: budget.text, color: budget.color } : { text: Locale.money(cost()), color: theme().muted },
        ]),
      )
    }

    if (queuedPrompts().length > 0) {
      items.push(
        statuslineItem("queued", "metrics", STATUSLINE_PRIORITY.queued, [
          { text: `⇥${queue()}`, color: theme().muted },
        ]),
      )
    }

    if (monitorCount() > 0) {
      items.push(
        statuslineItem("monitor", "metrics", STATUSLINE_PRIORITY.monitor, [
          { text: `▶${monitorCount()}`, color: theme().highlight },
        ]),
      )
    }

    if (todoCount() > 0) {
      items.push(
        statuslineItem("todos", "metrics", STATUSLINE_PRIORITY.todos, [
          { text: `☐${todoCount()}`, color: theme().warning },
        ]),
      )
    }

    if (modifiedCount() > 0) {
      items.push(
        statuslineItem("modified", "metrics", STATUSLINE_PRIORITY.modified, [
          { text: `✎${modifiedCount()}`, color: theme().success },
        ]),
      )
    }

    // A running turn hands the row to its status text. ctx% stays because it
    // decides whether the turn survives, and an over-budget cost stays because
    // it is the other reason you would reach for the interrupt key.
    if (!busy() || exiting()) {
      return items
    }

    return items.filter((item) => item.key === "ctx" || (item.key === "cost" && budgetPill()?.state !== "ok"))
  })
  const modelItem = createMemo<StatuslineItem | undefined>(() => {
    const current = props.currentModel()
    if (!prompt() || shell() || busy() || !current) {
      return
    }

    const variant = props.currentVariant()
    return statuslineItem("model", "model", STATUSLINE_PRIORITY.model, [
      { text: model().model, color: theme().text },
      ...(variant ? [{ text: ` ${variant}`, color: theme().warning, bold: true }] : []),
    ])
  })
  const hintItems = createMemo(() => {
    if (!prompt() || (busy() && !exiting())) {
      return []
    }

    const items: StatuslineItem[] = []
    if (!shell() && foregroundSubagents() && backgroundShortcut()) {
      items.push(
        statuslineItem("background", "background", STATUSLINE_PRIORITY.background, [
          { text: compactKey(backgroundShortcut()), color: theme().text },
          { text: " background", color: theme().muted },
        ]),
      )
    }

    if (shell()) {
      items.push(
        statuslineItem("command", "command", STATUSLINE_PRIORITY.command, [
          { text: "esc", color: theme().text },
          { text: " normal", color: theme().muted },
        ]),
      )
      return items
    }

    // Bare key, no "cmd" label: the palette it opens names every other binding
    // the statusline used to spell out, so this is the only one left to teach.
    if (command()) {
      items.push(
        statuslineItem("command", "command", STATUSLINE_PRIORITY.command, [
          { text: compactKey(command()), color: theme().text },
        ]),
      )
    }

    return items
  })
  // Columns the identity and status zones claim before the right zone gets
  // what is left. Measured rather than guessed: the flexbox will happily
  // overlap or shred a segment that does not fit, so the fit has to be decided
  // here instead.
  const reservedColumns = createMemo(() => {
    const identity =
      modeLabel().length +
      1 +
      (permissionModeIndicator().visible ? permissionModeIndicator().label.length + 1 : 0) +
      (props.state().automode ? "AUTO".length + 1 : 0)
    const spinner = busy() && !exiting() ? 2 + (interruptLabel() ? interruptLabel()!.length + 1 : 0) : 0
    const status = (judging() ? "● judging… ".length : 0) + spinner + statusText().length
    return identity + Math.max(STATUS_MIN_COLUMNS, status) + STATUSLINE_PADDING
  })
  const statusline = createMemo(() =>
    fitStatusline(
      [...metricItems(), ...(modelItem() ? [modelItem()!] : []), ...hintItems()],
      Math.max(0, width() - reservedColumns()),
    ),
  )
  // Rows the stacked panels get. Same call RunFooter.applyHeight() makes, so
  // the reserved footer height matches what the panels below actually draw.
  const panelRows = createMemo(() => {
    const thinking = props.thinking?.()
    const prompting = active().type === "prompt"
    const tail = prompting && thinking?.active ? thinkingTailRows(thinking.text, width()).length : 0
    return footerPanelRows({
      budget: footerPanelBudget(term().height),
      thinking: tail === 0 ? 0 : tail + 1,
      todos: prompting ? (props.todos?.() ?? []).length : 0,
      todoSummary: props.todoSummary?.() ?? false,
      tabs: !panel() && !menu() ? tabs().length : 0,
    })
  })

  createEffect(() => {
    props.onRequestExit?.(composer.requestExit)
  })

  onCleanup(() => {
    props.onRequestExit?.(undefined)
  })

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    enabled: active().type === "prompt" && route().type === "composer" && !composer.visible(),
    commands: [
      {
        name: "command.palette.show",
        title: "Open command palette",
        category: "Prompt",
        run: openCommand,
      },
      {
        name: "variant.cycle",
        title: "Cycle model variant",
        category: "Model",
        run: props.onCycle,
      },
    ],
    bindings: [
      ...props.tuiConfig.keybinds.get("command.palette.show"),
      ...props.tuiConfig.keybinds.get("variant.cycle"),
    ],
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    enabled: true,
    priority: -1,
    commands: [
      {
        name: "permission.mode.cycle",
        title: "Cycle permission mode",
        category: "Permission",
        run: () => props.onPermissionModeCycle?.(),
      },
    ],
    bindings: props.tuiConfig.keybinds.get("permission_mode_cycle"),
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    enabled: active().type === "prompt" && route().type === "composer" && foregroundSubagents(),
    priority: 1,
    commands: [
      {
        name: "session.background",
        title: "Background subagents",
        category: "Session",
        run: () => props.onBackground?.(),
      },
    ],
    bindings: props.tuiConfig.keybinds.get("session.background"),
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    enabled: active().type === "prompt" && route().type === "composer" && tabs().length > 0,
    commands: [
      {
        name: "session.child.first",
        title: "View subagents",
        category: "Session",
        run: openSubagentMenu,
      },
    ],
    bindings: props.tuiConfig.keybinds.get("session.child.first"),
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    enabled: active().type === "prompt" && route().type === "composer" && queuedPrompts().length > 0,
    commands: [
      {
        name: "session.queued_prompts",
        title: "Manage queued prompts",
        category: "Session",
        run: openQueuedMenu,
      },
    ],
    bindings: props.tuiConfig.keybinds.get("session.queued_prompts"),
  }))

  createEffect(() => {
    const current = route()
    if (current.type !== "subagent") {
      return
    }

    if (tabs().some((item) => item.sessionID === current.sessionID)) {
      return
    }

    closeTab()
  })

  createEffect(() => {
    if (route().type !== "subagent-menu") {
      return
    }

    if (tabs().length > 0) {
      return
    }

    closePanel()
  })

  createEffect(() => {
    if (route().type !== "queued-menu" || queuedPrompts().length > 0) return
    closePanel()
  })

  createEffect(() => {
    if (active().type === "prompt") {
      return
    }

    const current = route()
    if (
      current.type !== "command" &&
      current.type !== "skill" &&
      current.type !== "model" &&
      current.type !== "agent" &&
      current.type !== "variant" &&
      current.type !== "queued-menu" &&
      current.type !== "subagent-menu" &&
      current.type !== "sessions"
    ) {
      return
    }

    closePanel()
  })

  createEffect(() => {
    props.onLayout({
      route: route(),
      autocomplete: menu(),
      subagentRows: subagentMenuRows(),
    })
  })

  return (
    <box
      width="100%"
      height="100%"
      border={false}
      backgroundColor="transparent"
      flexDirection="column"
      gap={0}
      padding={0}
    >
      <Show when={panel() || inspecting()}>
        <box width="100%" height={1} flexShrink={0} backgroundColor="transparent" />
      </Show>

      <Show
        when={inspecting()}
        fallback={
          <box width="100%" flexDirection="column" gap={0}>
            <Show when={panelRows().thinking > 0}>
              <RunFooterThinkingPanel
                thinking={() => props.thinking?.()}
                theme={theme}
                rows={() => panelRows().thinking}
              />
            </Show>

            <Show when={panelRows().todos > 0}>
              <RunFooterTodoPanel
                todos={props.todos!}
                theme={theme}
                rows={() => panelRows().todos}
                todoSummary={props.todoSummary}
              />
            </Show>

            <For each={[promptView()]}>
              {() => (
                <box
                  width="100%"
                  flexShrink={0}
                  border={panel() || prompt() ? false : ["left"]}
                  borderColor={panel() || prompt() ? undefined : theme().highlight}
                  customBorderChars={
                    panel() || prompt()
                      ? undefined
                      : {
                          ...EMPTY_BORDER,
                          vertical: "█",
                        }
                  }
                >
                  <box
                    width="100%"
                    flexGrow={1}
                    paddingLeft={0}
                    paddingRight={0}
                    paddingTop={0}
                    flexDirection="column"
                    backgroundColor={panel() || prompt() ? "transparent" : theme().surface}
                    gap={0}
                  >
                    <box width="100%" flexGrow={1} flexShrink={1} flexDirection="column">
                      <Switch>
                        <Match when={active().type === "prompt" && route().type === "composer"}>
                          <RunPromptBody
                            theme={theme}
                            background={() => runTheme().background}
                            placeholder={composer.placeholder}
                            shell={composer.shell}
                            onSubmit={composer.onSubmit}
                            onKeyDown={composer.onKeyDown}
                            onContentChange={composer.onContentChange}
                            bind={composer.bind}
                          />
                        </Match>
                        <Match when={selectingSubagent()}>
                          <RunSubagentSelectBody
                            theme={theme}
                            tabs={tabs}
                            current={selected}
                            onClose={closePanel}
                            onSelect={openTab}
                            onRows={setSubagentMenuRows}
                          />
                        </Match>
                        <Match when={selectingQueued()}>
                          <RunQueuedPromptSelectBody
                            theme={theme}
                            prompts={queuedPrompts}
                            onClose={closePanel}
                            onDelete={(item) => void props.onQueuedRemove(item.messageID)}
                            onEdit={async (item) => {
                              if (!(await props.onQueuedRemove(item.messageID))) return
                              closePanel()
                              queueMicrotask(() => composer.replacePrompt(item.prompt))
                            }}
                            onRows={setSubagentMenuRows}
                          />
                        </Match>
                        <Match when={commanding()}>
                          <RunCommandMenuBody
                            theme={theme}
                            commands={props.commands}
                            agents={props.agents}
                            subagents={tabs}
                            queued={queuedPrompts}
                            variants={props.variants}
                            variantCycle={variantCycle()}
                            onClose={closePanel}
                            onModel={openModel}
                            onAgent={openAgent}
                            onEditor={() => {
                              closePanel()
                              void composer.openEditor()
                            }}
                            onSkill={openSkillMenu}
                            onSubagent={openSubagentMenu}
                            onSessions={openSessionsMenu}
                            onQueued={openQueuedMenu}
                            onVariant={openVariant}
                            onVariantCycle={() => {
                              props.onCycle()
                              closePanel()
                            }}
                            onCommand={(name) => {
                              composer.replacePrompt({
                                text: `/${name} `,
                                parts: [],
                                command: { name, arguments: "" },
                              })
                              closePanel()
                            }}
                            onNew={() => {
                              composer.submitText("/new")
                              closePanel()
                            }}
                            onExit={props.onExit}
                          />
                        </Match>
                        <Match when={skilling()}>
                          <RunSkillSelectBody
                            theme={theme}
                            commands={props.commands}
                            onClose={closePanel}
                            onSelect={(name) => {
                              composer.replacePrompt({
                                text: `/${name} `,
                                parts: [],
                                command: {
                                  name,
                                  arguments: "",
                                },
                              })
                              closePanel()
                            }}
                          />
                        </Match>
                        <Match when={modeling()}>
                          <RunModelSelectBody
                            theme={theme}
                            providers={props.providers}
                            current={props.currentModel}
                            onClose={closePanel}
                            onSelect={(model) => {
                              props.onModelSelect(model)
                              closePanel()
                            }}
                          />
                        </Match>
                        <Match when={agenting()}>
                          <RunAgentSelectBody
                            theme={theme}
                            agents={props.agents}
                            current={props.currentAgent}
                            onClose={closePanel}
                            onSelect={(agent) => {
                              props.onAgentSelect(agent)
                              closePanel()
                            }}
                          />
                        </Match>
                        <Match when={varianting()}>
                          <RunVariantSelectBody
                            theme={theme}
                            variants={props.variants}
                            current={props.currentVariant}
                            onClose={closePanel}
                            onSelect={(variant) => {
                              props.onVariantSelect(variant)
                              closePanel()
                            }}
                          />
                        </Match>
                        <Match when={selectingSession()}>
                          <RunSessionSelectBody
                            theme={theme}
                            sessions={sessions}
                            current={props.sessionID ?? (() => undefined)}
                            onClose={closePanel}
                            onSelect={(sessionID, title) => {
                              props.onSessionSelect?.(sessionID, title)
                              closePanel()
                            }}
                          />
                        </Match>
                        <Match when={active().type === "permission"}>
                          <RunPermissionBody
                            request={permission()!.request}
                            theme={theme()}
                            block={block()}
                            diffStyle={props.diffStyle}
                            onReply={props.onPermissionReply}
                          />
                        </Match>
                        <Match when={active().type === "question"}>
                          <RunQuestionBody
                            request={question()!.request}
                            theme={theme()}
                            onReply={props.onQuestionReply}
                            onReject={props.onQuestionReject}
                          />
                        </Match>
                      </Switch>
                    </box>
                  </box>
                </box>
              )}
            </For>

            <Show when={!panel() && menu()}>
              <RunFooterMenu
                theme={theme}
                items={composer.options}
                selected={composer.selected}
                offset={composer.offset}
                rows={composer.rows}
                limit={FOOTER_MENU_ROWS}
                border={false}
                paddingLeft={0}
              />
            </Show>

            <Show when={panelRows().tree > 0}>
              <RunSubagentTree tabs={tabs} theme={theme} rows={() => panelRows().tree} />
            </Show>

            <Show when={!panel() && !menu()}>
              <box width="100%" height={1} flexDirection="row" gap={0} flexShrink={0} backgroundColor="transparent">
                <box paddingRight={1} flexShrink={0}>
                  <text wrapMode="none" truncate>
                    <span style={{ fg: theme().highlight, bold: true }}>{modeLabel()}</span>
                  </text>
                </box>

                <Show when={permissionModeIndicator().visible}>
                  <box paddingRight={1} flexShrink={0}>
                    <text fg={theme().warning} wrapMode="none" truncate flexShrink={0}>
                      {permissionModeIndicator().label}
                    </text>
                  </box>
                </Show>

                <Show when={props.state().automode}>
                  <box paddingRight={1} flexShrink={0}>
                    <text fg={theme().highlight} wrapMode="none" truncate flexShrink={0}>
                      AUTO
                    </text>
                  </box>
                </Show>

                <box
                  flexDirection="row"
                  gap={1}
                  flexGrow={1}
                  flexShrink={1}
                  minWidth={12}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor="transparent"
                >
                  <Show when={judging()}>
                    <box flexShrink={0} flexDirection="row" gap={0}>
                      <BlinkingDot theme={theme} />
                      <text fg={theme().muted} wrapMode="none" truncate flexShrink={0}>
                        {" "}
                        judging…
                      </text>
                    </box>
                  </Show>

                  <Show when={busy() && !exiting()}>
                    <Show when={interruptLabel()}>
                      {(label) => (
                        <text flexShrink={0} fg={armed() ? statusColor() : theme().muted}>
                          {label()}{" "}
                        </text>
                      )}
                    </Show>
                    <box flexShrink={0}>
                      <Spinner
                        message={statusText}
                        mode={() => "responding"}
                        stalled={() => false}
                        color={() => theme().highlight as RGBA}
                        animationsEnabled={() => !subagentRunning()}
                      />
                    </box>
                  </Show>

                  <text fg={statusColor()} wrapMode="none" truncate flexGrow={1} flexShrink={1}>
                    <Show when={!busy() || exiting()}>{statusText()}</Show>
                  </text>
                </box>

                <Show when={statusline().length > 0}>
                  <box paddingRight={1} backgroundColor="transparent" flexShrink={0}>
                    <text wrapMode="none" truncate>
                      <For each={statusline()}>
                        {(item, index) => (
                          <>
                            <span>{statuslineGap(statusline()[index() - 1], item)}</span>
                            <For each={item.parts}>
                              {(part) => <span style={{ fg: part.color, bold: part.bold }}>{part.text}</span>}
                            </For>
                          </>
                        )}
                      </For>
                    </text>
                  </box>
                </Show>
              </box>
            </Show>
          </box>
        }
      >
        <box width="100%" flexGrow={1} flexShrink={1}>
          <RunFooterSubagentBody
            active={inspecting}
            theme={runTheme}
            tab={selectedTab}
            index={selectedIndex}
            total={() => tabs().length}
            detail={detail}
            width={width}
            diffStyle={props.diffStyle}
            onCycle={cycleTab}
            onClose={closeTab}
          />
        </box>
      </Show>
    </box>
  )
}

// Live thinking block rendered as the topmost footer element: a blinking
// "● Thinking…" header over the rolling ⎿ rows, at column 0 so it matches the
// static block committed to scrollback when the reasoning part ends.
function RunFooterThinkingPanel(props: {
  thinking: () => FooterThinkingState | undefined
  theme: () => RunFooterTheme
  rows: () => number
}) {
  const term = useTerminalDimensions()
  const rows = createMemo(() => {
    const state = props.thinking()
    if (!state?.active) {
      return []
    }

    // One of the allotted rows belongs to the "● Thinking…" header.
    return thinkingTailRows(state.text, term().width, props.rows() - 1)
  })

  return (
    <Show when={rows().length > 0}>
      <box
        width="100%"
        height={rows().length + 1}
        flexDirection="column"
        gap={0}
        flexShrink={0}
        backgroundColor="transparent"
      >
        <box width="100%" height={1} flexDirection="row" gap={0} flexShrink={0} backgroundColor="transparent">
          <BlinkingDot theme={props.theme} />
          <text wrapMode="none" truncate height={1}>
            <span style={{ fg: props.theme().muted, dim: true }}> Thinking…</span>
          </text>
        </box>
        <For each={rows()}>
          {(row) => (
            <text wrapMode="none" truncate height={1}>
              <span style={{ fg: props.theme().muted, dim: true }}>{row}</span>
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

function RunFooterTodoPanel(props: {
  todos: () => FooterTodoItem[]
  theme: () => RunFooterTheme
  rows: () => number
  todoSummary?: () => boolean
}) {
  function glyph(status: string) {
    if (status === "in_progress" || status === "pending") return "☐"
    return "☒"
  }

  function color(status: string) {
    if (status === "completed") return props.theme().muted
    if (status === "in_progress") return props.theme().warning
    return props.theme().muted
  }

  const summary = () => props.todoSummary?.() ?? false
  const visible = createMemo(() => todoPanelVisible(props.todos().length, props.rows()))
  const hidden = createMemo(() => props.todos().length - visible())

  return (
    <box
      width="100%"
      height={props.rows()}
      flexShrink={0}
      flexDirection="column"
      backgroundColor="transparent"
      paddingLeft={1}
      paddingRight={1}
    >
      <Show
        when={summary()}
        fallback={
          <>
            <For each={props.todos().slice(0, visible())}>
              {(item) => (
                <box width="100%" height={1} flexDirection="row" gap={1} flexShrink={0} backgroundColor="transparent">
                  <text fg={color(item.status)} wrapMode="none" flexShrink={0}>
                    {glyph(item.status)}
                  </text>
                  <text wrapMode="none" truncate flexGrow={1}>
                    <span
                      style={{
                        fg:
                          item.status === "in_progress"
                            ? props.theme().warning
                            : item.status === "completed"
                              ? props.theme().muted
                              : props.theme().muted,
                        bold: item.status === "in_progress",
                        strikethrough: item.status === "completed",
                      }}
                    >
                      {item.content}
                    </span>
                  </text>
                </box>
              )}
            </For>
            <Show when={hidden() > 0}>
              <box width="100%" height={1} flexDirection="row" flexShrink={0} backgroundColor="transparent">
                <text fg={props.theme().muted} wrapMode="none" truncate>
                  … +{hidden()} more
                </text>
              </box>
            </Show>
          </>
        }
      >
        <box width="100%" height={1} flexDirection="row" gap={1} flexShrink={0} backgroundColor="transparent">
          <text fg={props.theme().muted} wrapMode="none" flexShrink={0}>
            ☒
          </text>
          <text fg={props.theme().muted} wrapMode="none" truncate>
            {props.todos().length} tasks completed
          </text>
        </box>
      </Show>
    </box>
  )
}
