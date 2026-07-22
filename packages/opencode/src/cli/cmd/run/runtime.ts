// Top-level orchestrator for `opencode --mini`.
//
// Wires the boot sequence, lifecycle (renderer + footer), stream transport,
// and prompt queue together into a single session loop. Two entry points:
//
//   runInteractiveMode     -- used when an SDK client already exists (attach mode)
//   runInteractiveLocalMode -- used for local in-process mode (no server)
//
// Both delegate to runInteractiveRuntime, which:
//   1. resolves TUI config, model info, and session history,
//   2. creates the split-footer lifecycle (renderer + RunFooter),
//   3. starts the stream transport (SDK event subscription), lazily for fresh
//      local sessions,
//   4. runs the prompt queue until the footer closes.
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Flag } from "@opencode-ai/core/flag/flag"
import { MessageID } from "@/session/schema"
import * as Locale from "@/util/locale"
import { createRunDemo } from "./demo"
import { modeCycle, modeDecision } from "./mode.shared"
import { resolveModelInfo, resolveRunTuiConfig, resolveSessionInfo } from "./runtime.boot"
import { createRuntimeLifecycle } from "./runtime.lifecycle"
import { trace } from "./trace"
import { cycleVariant, formatModelLabel, resolveSavedVariant, resolveVariant, saveVariant } from "./variant.shared"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import type {
  FooterQueuedPrompt,
  FooterView,
  LocalReplayAnchor,
  LocalReplayRow,
  PermissionReply,
  RunAgent,
  RunInput,
  RunPrompt,
  RunProvider,
  StreamCommit,
} from "./types"

/** @internal Exported for testing */
export { pickVariant, resolveVariant } from "./variant.shared"

/** @internal Exported for testing */
export { runPromptQueue } from "./runtime.queue"

type BootContext = Pick<
  RunInput,
  "sdk" | "directory" | "sessionID" | "sessionTitle" | "resume" | "agent" | "model" | "variant"
>

type CreateSessionInput = {
  agent: string | undefined
  model: RunInput["model"]
  variant: string | undefined
}

type CreateSession = (sdk: RunInput["sdk"], input: CreateSessionInput) => Promise<{ id: string; title?: string }>

type RunRuntimeInput = {
  boot: () => Promise<BootContext>
  afterPaint?: (ctx: BootContext) => Promise<void> | void
  resolveSession?: (
    ctx: BootContext,
  ) => Promise<{ sessionID: string; sessionTitle?: string; agent?: string | undefined }>
  createSession?: (ctx: BootContext, input: CreateSessionInput) => Promise<ResolvedSession>
  files: RunInput["files"]
  initialInput?: string
  thinking: boolean
  backgroundSubagents: boolean
  replay?: boolean
  replayLimit?: number
  demo?: RunInput["demo"]
  // `sessionID` is the current session at call time, threaded through so
  // /detach carries the right session across /new and /sessions switches.
  onDetach?: (live?: boolean, sessionID?: string, queued?: FooterQueuedPrompt[]) => Promise<void>
  onShutdown?: () => Promise<void>
  // If provided, normal exits (/exit, Ctrl+C double-press, palette exit)
  // run this before closing the client. Used by the detachable startup path
  // to shut down the server; plain --attach leaves this undefined so exit
  // only leaves the client.
  onExit?: () => void | Promise<void>
}

type RunLocalInput = {
  directory: string
  fetch: typeof globalThis.fetch
  resolveAgent: () => Promise<string | undefined>
  session: (sdk: RunInput["sdk"]) => Promise<{ id: string; title?: string } | undefined>
  share: (sdk: RunInput["sdk"], sessionID: string) => Promise<void>
  createSession?: CreateSession
  agent: RunInput["agent"]
  model: RunInput["model"]
  variant: RunInput["variant"]
  files: RunInput["files"]
  initialInput?: string
  thinking: boolean
  backgroundSubagents: boolean
  replay?: boolean
  replayLimit?: number
  demo?: RunInput["demo"]
  // `sessionID` is the current session at call time, threaded through so
  // /detach carries the right session across /new and /sessions switches.
  onDetach?: (live?: boolean, sessionID?: string, queued?: FooterQueuedPrompt[]) => Promise<void>
}

type StreamTransportModule = Pick<
  Awaited<typeof import("./stream.transport")>,
  "createSessionTransport" | "formatUnknownError"
>

export type RunRuntimeDeps = {
  createRuntimeLifecycle?: typeof createRuntimeLifecycle
  streamTransport?: Promise<StreamTransportModule>
}

type StreamState = {
  mod: StreamTransportModule
  handle: Awaited<ReturnType<StreamTransportModule["createSessionTransport"]>>
}

type ResolvedSession = {
  sessionID: string
  sessionTitle?: string
  agent?: string | undefined
}

function createSessionResolver(fn?: CreateSession) {
  if (!fn) {
    return undefined
  }

  return async (ctx: BootContext, input: CreateSessionInput): Promise<ResolvedSession> => {
    const created = await fn(ctx.sdk, input)
    if (!created.id) {
      throw new Error("Failed to create session")
    }

    return {
      sessionID: created.id,
      sessionTitle: created.title,
      agent: input.agent,
    }
  }
}

type RuntimeState = {
  shown: boolean
  aborting: boolean
  model: RunInput["model"]
  providers: RunProvider[]
  variants: string[]
  limits: Record<string, number>
  activeVariant: string | undefined
  sessionID: string
  history: RunPrompt[]
  localRows: LocalReplayRow[]
  sessionTitle?: string
  agent: string | undefined
  // Catalog snapshot for the current agent's budget lookup (P4), fed to the
  // stream transport's client-side budget-crossing detection.
  agents: RunAgent[]
  switching?: Promise<void>
  demo?: ReturnType<typeof createRunDemo>
  selectSubagent?: (sessionID: string | undefined) => void
  session?: Promise<void>
  stream?: Promise<StreamState>
  // Whether the next prompt turn should re-attach the initial file mentions.
  // Lives on state (rather than a local closure in runQueue) so both
  // onNewSession and switchSession can reset it from outside that scope.
  includeFiles: boolean
  permissionMode: import("./mode.shared").PermissionMode
  pendingPermission?: PermissionRequest
  // Set once onDetach (live /detach or SIGHUP auto-detach) succeeds, so the
  // exit splash's `opencode --mini -s <id>` hint -- wrong once the session
  // moved to a background server -- is suppressed at shell.close() below.
  detached?: boolean
  // Set while a live /detach flush+spawn is running. SIGHUP must not trigger
  // the in-place auto-detach in either window: during the spawn it would
  // daemonize the parent alongside the child, and after it the parent's
  // Discovery.write would clobber the child's record with a pid that is
  // about to die (observed as "stale record" attach failures when the
  // terminal closes right after the record appears).
  detachPending?: boolean
}

function hasSession(input: RunRuntimeInput, state: RuntimeState) {
  return !input.resolveSession || !!state.sessionID
}

function eagerStream(input: RunRuntimeInput, ctx: BootContext) {
  return ctx.resume === true || !input.resolveSession || !!input.demo
}

function variantsFor(providers: RunProvider[], model: RunInput["model"]) {
  if (!model) {
    return []
  }

  return Object.keys(providers.find((item) => item.id === model.providerID)?.models?.[model.modelID]?.variants ?? {})
}

const RESIZE_DELAY = 250
const LOCAL_REPLAY_ROW_LIMIT = 100

async function resolveExitTitle(
  ctx: BootContext,
  input: RunRuntimeInput,
  state: RuntimeState,
): Promise<string | undefined> {
  if (!state.shown || !hasSession(input, state)) {
    return undefined
  }

  return ctx.sdk.session
    .get({
      sessionID: state.sessionID,
    })
    .then((x) => x.data?.title)
    .catch(() => undefined)
}

// Core runtime loop. Boot resolves the SDK context, then we set up the
// lifecycle (renderer + footer), wire the stream transport for SDK events,
// and feed prompts through the queue until the user exits.
//
// Files only attach on the first prompt turn -- after that, includeFiles
// flips to false so subsequent turns don't re-send attachments.
async function runInteractiveRuntime(input: RunRuntimeInput, deps: RunRuntimeDeps = {}): Promise<void> {
  const start = performance.now()
  const log = trace()
  const tuiConfigTask = resolveRunTuiConfig()
  const ctx = await input.boot()
  const modelTask = resolveModelInfo(ctx.sdk, ctx.directory, ctx.model)
  const sessionTask =
    ctx.resume === true
      ? resolveSessionInfo(ctx.sdk, ctx.sessionID, ctx.model)
      : Promise.resolve({
          first: true,
          history: [],
          variant: undefined,
        })
  const savedTask = resolveSavedVariant(ctx.model)
  const [tuiConfig, session, savedVariant] = await Promise.all([tuiConfigTask, sessionTask, savedTask])
  const state: RuntimeState = {
    shown: !session.first,
    aborting: false,
    model: ctx.model,
    providers: [],
    variants: [],
    limits: {},
    activeVariant: resolveVariant(ctx.variant, session.variant, savedVariant, []),
    sessionID: ctx.sessionID,
    history: [...session.history],
    localRows: [],
    sessionTitle: ctx.sessionTitle,
    agent: ctx.agent,
    agents: [],
    includeFiles: true,
    permissionMode: "normal",
  }
  const ensureSession = () => {
    if (!input.resolveSession || state.sessionID) {
      return Promise.resolve()
    }

    if (state.session) {
      return state.session
    }

    state.session = input.resolveSession(ctx).then((next) => {
      state.sessionID = next.sessionID
      state.sessionTitle = next.sessionTitle ?? state.sessionTitle
      state.agent = next.agent
    })
    return state.session
  }

  const shell = await (deps.createRuntimeLifecycle ?? createRuntimeLifecycle)({
    directory: ctx.directory,
    findFiles: (query) =>
      ctx.sdk.find
        .files({ query, directory: ctx.directory })
        .then((x) => x.data ?? [])
        .catch(() => []),
    agents: [],
    resources: [],
    sessionID: state.sessionID,
    sessionTitle: state.sessionTitle,
    getSessionID: () => state.sessionID,
    first: session.first,
    history: session.history,
    agent: state.agent,
    model: state.model,
    variant: state.activeVariant,
    tuiConfig,
    backgroundSubagents: input.backgroundSubagents,
    onPermissionReply: async (next) => {
      if (state.demo?.permission(next)) {
        return
      }

      log?.write("send.permission.reply", next)
      await ctx.sdk.permission.reply(next)
    },
    onPermissionModeCycle: async () => {
      if (state.demo?.permissionModeCycle()) {
        return
      }

      state.permissionMode = modeCycle(state.permissionMode)
      footer.event({ type: "stream.patch", patch: { permissionMode: state.permissionMode } })
      log?.write("permission.mode.cycle", { permissionMode: state.permissionMode })

      const pending = state.pendingPermission
      if (!pending || modeDecision(state.permissionMode, pending) !== "allow") {
        return
      }

      log?.write("permission.auto.allow", { requestID: pending.id, permission: pending.permission })
      state.pendingPermission = undefined
      await ctx.sdk.permission.reply({ requestID: pending.id, reply: "once" })
      footer.event({ type: "stream.view", view: { type: "prompt" } })
    },
    onAutoToggle: async () => {
      if (!state.sessionID) {
        return
      }

      // The server record is the source of truth: fetch before flipping so a
      // toggle never desyncs after resume, session switch, or external change.
      const response = await ctx.sdk.session.get({ sessionID: state.sessionID }).catch(() => undefined)
      if (!response?.data || footer.isClosed) {
        return
      }

      const next = !(response.data.automode ?? false)
      footer.event({ type: "stream.patch", patch: { automode: next } })
      log?.write("auto.toggle", { automode: next })

      await ctx.sdk.session.update({ sessionID: state.sessionID, automode: next })
    },
    onQuestionReply: async (next) => {
      if (state.demo?.questionReply(next)) {
        return
      }

      await ctx.sdk.question.reply(next)
    },
    onQuestionReject: async (next) => {
      if (state.demo?.questionReject(next)) {
        return
      }

      await ctx.sdk.question.reject(next)
    },
    onCycleVariant: () => {
      if (!state.model || state.variants.length === 0) {
        return {
          status: "no variants available",
        }
      }

      state.activeVariant = cycleVariant(state.activeVariant, state.variants)
      saveVariant(state.model, state.activeVariant)
      return {
        status: state.activeVariant ? `variant ${state.activeVariant}` : "variant default",
        modelLabel: formatModelLabel(state.model, state.activeVariant, state.providers),
        variant: state.activeVariant,
      }
    },
    onModelSelect: async (model) => {
      if (state.model?.providerID === model.providerID && state.model.modelID === model.modelID) {
        return
      }

      state.model = model
      state.activeVariant = undefined
      state.variants = variantsFor(state.providers, model)
      const switching = resolveSavedVariant(model).then((saved) => {
        const current = state.model
        if (!current || current.providerID !== model.providerID || current.modelID !== model.modelID) {
          return
        }

        state.activeVariant = resolveVariant(ctx.variant, undefined, saved, state.variants)
      })
      state.switching = switching
      await switching
      if (state.switching === switching) {
        state.switching = undefined
      }

      const current = state.model
      if (!current || current.providerID !== model.providerID || current.modelID !== model.modelID) {
        return
      }

      return {
        modelLabel: formatModelLabel(model, state.activeVariant, state.providers),
        status: `model ${model.modelID}`,
        variant: state.activeVariant,
        variants: state.variants,
      }
    },
    onVariantSelect: async (variant) => {
      if (!state.model || state.variants.length === 0) {
        return {
          status: "no variants available",
        }
      }

      if (variant && !state.variants.includes(variant)) {
        return {
          status: `variant ${variant} unavailable`,
        }
      }

      state.activeVariant = variant
      saveVariant(state.model, state.activeVariant)
      return {
        status: state.activeVariant ? `variant ${state.activeVariant}` : "variant default",
        modelLabel: formatModelLabel(state.model, state.activeVariant, state.providers),
        variant: state.activeVariant,
        variants: state.variants,
      }
    },
    // Agent switch, mirroring onModelSelect: takes effect on the next prompt
    // turn (state.agent is read fresh in run()), no idle guard needed since
    // switching agents doesn't tear down the stream.
    onAgentSelect: (agent) => {
      if (state.agent === agent) {
        return
      }

      state.agent = agent
      return {
        agentLabel: Locale.titlecase(agent),
        status: `agent ${agent}`,
      }
    },
    onInterrupt: () => {
      if (!hasSession(input, state) || state.aborting) {
        return
      }

      state.aborting = true
      void ctx.sdk.session
        .abort({
          sessionID: state.sessionID,
        })
        .catch(() => {})
        .finally(() => {
          state.aborting = false
        })
    },
    onBackground: () => {
      if (!hasSession(input, state)) return
      void ctx.sdk.experimental.session.background({ sessionID: state.sessionID }).catch(() => {})
    },
    onSubagentSelect: (sessionID) => {
      state.selectSubagent?.(sessionID)
      log?.write("subagent.select", {
        sessionID,
      })
    },
    onSessionsOpen: () => {
      void loadSessions()
    },
    onSessionSelect: (sessionID, title) => {
      void switchSession(sessionID, title)
    },
  })
  const footer = shell.footer

  // SIGHUP auto-detach (P4). In local mode with onDetach available, detach on
  // SIGHUP and close the TUI. In attach mode, exit gracefully.
  const onSighup = input.onDetach
    ? () => {
        // A finished live /detach already moved the session to the child
        // server; the parent was about to exit anyway, so just do it now.
        if (state.detached) return void process.exit(0)
        // A live /detach in flight owns the discovery record; ignore the
        // hangup and let it finish (see detachPending on RuntimeState).
        if (state.detachPending) return
        void input.onDetach!(undefined, state.sessionID).then(() => {
          state.detached = true
          footer.close()
        })
      }
    : () => process.exit(0)
  process.on("SIGHUP", onSighup)

  const rememberLocal = (commit: StreamCommit, after?: LocalReplayAnchor) => {
    state.localRows = [...state.localRows, { commit, after }].slice(-LOCAL_REPLAY_ROW_LIMIT)
  }

  const loadCatalog = async (): Promise<void> => {
    if (footer.isClosed) {
      return
    }

    const [agents, resources, commands] = await Promise.all([
      ctx.sdk.app
        .agents({ directory: ctx.directory })
        .then((x) => x.data ?? [])
        .catch(() => []),
      ctx.sdk.experimental.resource
        .list({ directory: ctx.directory })
        .then((x) => Object.values(x.data ?? {}))
        .catch(() => []),
      ctx.sdk.command
        .list({ directory: ctx.directory })
        .then((x) => x.data ?? [])
        .catch(() => []),
    ])
    if (footer.isClosed) {
      return
    }

    state.agents = agents
    footer.event({
      type: "catalog",
      agents,
      resources,
      commands,
    })
  }

  const loadTodos = async (): Promise<void> => {
    if (footer.isClosed) {
      return
    }

    const response = await ctx.sdk.session.todo({ sessionID: state.sessionID }).catch(() => undefined)
    if (!response || footer.isClosed) {
      return
    }

    const todos = response.data
    if (!todos) {
      return
    }

    footer.event({
      type: "stream.todo",
      todos: todos.map((item) => ({
        status: item.status,
        content: item.content,
      })),
    })
  }

  // Initial fetch for the ✎ modified-file pill, mirroring loadTodos above.
  // Live updates after this come from session.diff events (session-data.ts).
  const loadDiff = async (): Promise<void> => {
    if (footer.isClosed) {
      return
    }

    const response = await ctx.sdk.session.diff({ sessionID: state.sessionID }).catch(() => undefined)
    if (!response || footer.isClosed) {
      return
    }

    const diff = response.data
    if (!diff) {
      return
    }

    footer.event({
      type: "stream.patch",
      patch: { modified: diff.length },
    })
  }

  // Initial fetch for the AUTO automode pill, mirroring loadDiff above.
  // Live updates after this come from session.updated events (session-data.ts).
  const loadAutomode = async (): Promise<void> => {
    if (footer.isClosed || !state.sessionID) {
      return
    }

    const response = await ctx.sdk.session.get({ sessionID: state.sessionID }).catch(() => undefined)
    if (!response?.data || footer.isClosed) {
      return
    }

    footer.event({
      type: "stream.patch",
      patch: { automode: response.data.automode === true },
    })
  }

  // Refreshes the /sessions panel's list. Fetched fresh on every panel open
  // (rather than cached alongside the startup catalog) so "updated" times
  // stay accurate across a long-running footer.
  const loadSessions = async (): Promise<void> => {
    if (footer.isClosed) {
      return
    }

    const list = await ctx.sdk.session
      .list({ directory: ctx.directory })
      .then((x) => x.data ?? [])
      .catch(() => [])
    if (footer.isClosed) {
      return
    }

    footer.event({
      type: "sessions",
      sessions: list.map((item) => ({
        sessionID: item.id,
        parentID: item.parentID,
        title: item.title,
        updated: item.time.updated,
      })),
    })
  }

  void footer
    .idle()
    .then(loadCatalog)
    .catch(() => {})

  if (Flag.OPENCODE_SHOW_TTFD) {
    footer.append({
      kind: "system",
      text: `startup ${Math.max(0, Math.round(performance.now() - start))}ms`,
      phase: "final",
      source: "system",
    })
  }

  if (input.demo) {
    await ensureSession()
    state.demo = createRunDemo({
      footer,
      sessionID: state.sessionID,
      thinking: input.thinking,
      limits: () => state.limits,
    })
  }

  if (input.afterPaint) {
    void Promise.resolve(input.afterPaint(ctx)).catch(() => {})
  }

  void modelTask.then((info) => {
    state.providers = info.providers
    state.variants = variantsFor(state.providers, state.model)
    state.limits = info.limits

    const next = resolveVariant(ctx.variant, session.variant, savedVariant, state.variants)
    if (next !== state.activeVariant) {
      state.activeVariant = next
    }

    if (footer.isClosed) {
      return
    }

    footer.event({ type: "models", providers: info.providers })
    footer.event({ type: "variants", variants: state.variants, current: state.activeVariant })
    if (!state.model) {
      return
    }

    footer.event({
      type: "model",
      model: formatModelLabel(state.model, state.activeVariant, state.providers),
    })
  })

  const streamTask = deps.streamTransport ?? import("./stream.transport")
  const ensureStream = () => {
    if (state.stream) {
      return state.stream
    }

    // Share eager prewarm and first-turn boot through one in-flight promise,
    // but clear it if transport creation fails so a later prompt can retry.
    const next = (async () => {
      await ensureSession()
      if (footer.isClosed) {
        throw new Error("runtime closed")
      }

      const mod = await streamTask
      if (footer.isClosed) {
        throw new Error("runtime closed")
      }

      const handle = await mod.createSessionTransport({
        sdk: ctx.sdk,
        directory: ctx.directory,
        sessionID: state.sessionID,
        thinking: input.thinking,
        replay: input.replay,
        replayLimit: input.replayLimit,
        limits: () => state.limits,
        providers: () => state.providers,
        budget: () => state.agents.find((item) => item.name === state.agent)?.budget,
        footer,
        trace: log,
        permissionMode: () => state.permissionMode,
        onPermissionAsked: (request) => {
          state.pendingPermission = request
        },
        onPermissionAutoAllow: ({ requestID }) => {
          if (state.pendingPermission?.id === requestID) {
            state.pendingPermission = undefined
          }
        },
        onPermissionResolved: (requestID) => {
          if (state.pendingPermission?.id === requestID) {
            state.pendingPermission = undefined
          }
        },
      })
      if (footer.isClosed) {
        await handle.close()
        throw new Error("runtime closed")
      }

      state.selectSubagent = (sessionID) => handle.selectSubagent(sessionID)
      return { mod, handle }
    })()
    state.stream = next
    void next.catch(() => {
      if (state.stream === next) {
        state.stream = undefined
      }
    })
    return next
  }

  // /sessions (resume): tear down the current session's subscription and
  // rebind to the chosen one, mirroring onNewSession's reset below except
  // that an existing session has real history to restore. resolveSessionInfo
  // (the same helper --continue uses at boot) gives us that session's actual
  // `first`/`history` so state.shown and the footer's "first" placeholder
  // reflect the resumed session instead of behaving like a blank new one --
  // and ensureStream() (not resetForReplay, which is reserved for resize)
  // replays it into scrollback via the existing bootstrap path.
  const switchSession = async (sessionID: string, title: string | undefined): Promise<void> => {
    if (sessionID === state.sessionID) {
      return
    }

    try {
      await state.switching?.catch(() => {})
      await footer.idle().catch(() => {})
      await state.stream?.then((item) => item.handle.close()).catch(() => {})
      state.stream = undefined
      state.session = undefined
      state.selectSubagent = undefined
      state.sessionID = sessionID
      state.sessionTitle = title
      state.localRows = []
      state.includeFiles = true

      const info = await resolveSessionInfo(ctx.sdk, sessionID, state.model)
      state.shown = !info.first
      state.history = info.history

      state.demo = input.demo
        ? createRunDemo({
            footer,
            sessionID: state.sessionID,
            thinking: input.thinking,
            limits: () => state.limits,
          })
        : undefined
      log?.write("session.switch", {
        sessionID: state.sessionID,
      })
      footer.event({
        type: "stream.subagent",
        state: {
          tabs: [],
          details: {},
          permissions: [],
          questions: [],
        },
      })
      footer.event({ type: "stream.view", view: { type: "prompt" } })
      // Reset todos and the modified count to 0 before the fresh fetches below
      // resolve, so the panel/pill don't briefly show the previous session's
      // stale state.
      footer.event({ type: "stream.todo", todos: [] })
      footer.event({
        type: "stream.patch",
        patch: {
          phase: "idle",
          duration: "",
          contextTokens: 0,
          contextPercent: null,
          cost: 0,
          modified: 0,
          automode: false,
          first: info.first,
        },
      })
      footer.append({
        kind: "system",
        text: `resume session ${state.sessionID}`,
        phase: "final",
        source: "system",
      })
      await ensureStream()
      await loadTodos().catch(() => {})
      await loadDiff().catch(() => {})
      await loadAutomode().catch(() => {})
      await state.demo?.start()
    } catch (error) {
      footer.event({
        type: "stream.patch",
        patch: {
          phase: "idle",
          status: "failed to switch session",
        },
      })
      const commit = {
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
        phase: "start",
        source: "system",
        messageID: MessageID.ascending(),
      } as const
      rememberLocal(commit)
      footer.append(commit)
    }
  }

  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  const offResize = shell.onResize(() => {
    if (resizeTimer) {
      clearTimeout(resizeTimer)
    }

    resizeTimer = setTimeout(() => {
      resizeTimer = undefined
      if (footer.isClosed) {
        return
      }

      shell.refreshTheme()
      if (!input.replay || !state.stream) {
        return
      }

      void state.stream
        .then((item) =>
          item.handle.replayOnResize({
            localRows: () => state.localRows,
            reset: () =>
              shell.resetForReplay({
                sessionTitle: state.sessionTitle,
                sessionID: state.sessionID,
                history: state.history,
              }),
          }),
        )
        .catch(() => {})
    }, RESIZE_DELAY)
  })

  const runQueue = async () => {
    if (state.demo) {
      await state.demo.start()
    }

    const mod = await import("./runtime.queue")
    const createSession = input.createSession
    await mod.runPromptQueue({
      footer,
      initialInput: input.initialInput,
      trace: log,
      // runtime.queue.ts's onDetach only forwards `live` and the queued
      // snapshot; wrap it here so the session id it reads is state.sessionID
      // at call time (reflects /new and /sessions switches), without
      // changing runtime.queue.ts's type. Marks state.detached on success so
      // the exit splash below knows to suppress its stale resume hint.
      onDetach: input.onDetach
        ? async (live?: boolean, queued?: FooterQueuedPrompt[]) => {
            state.detachPending = true
            try {
              await input.onDetach!(live, state.sessionID, queued)
            } catch (error) {
              // Aborted flush: re-arm SIGHUP auto-detach along with the queue.
              state.detachPending = false
              throw error
            }
            state.detached = true
          }
        : undefined,
      onShutdown: input.onShutdown,
      onExit: input.onExit,
      onSend: (prompt) => {
        state.shown = true
        state.history.push(prompt)
        if (prompt.mode !== "shell") {
          rememberLocal({
            kind: "user",
            text: prompt.text,
            phase: "start",
            source: "system",
            messageID: prompt.messageID,
          })
        }
      },
      onNewSession: createSession
        ? async () => {
            try {
              await state.switching?.catch(() => {})
              const created = await createSession(ctx, {
                agent: state.agent,
                model: state.model,
                variant: state.activeVariant,
              })
              await footer.idle().catch(() => {})
              await state.stream?.then((item) => item.handle.close()).catch(() => {})
              state.stream = undefined
              state.session = undefined
              state.selectSubagent = undefined
              state.shown = false
              state.sessionID = created.sessionID
              state.sessionTitle = created.sessionTitle
              state.agent = created.agent ?? state.agent
              state.history = []
              state.localRows = []
              state.includeFiles = true
              state.demo = input.demo
                ? createRunDemo({
                    footer,
                    sessionID: state.sessionID,
                    thinking: input.thinking,
                    limits: () => state.limits,
                  })
                : undefined
              log?.write("session.new", {
                sessionID: state.sessionID,
              })
              footer.event({
                type: "stream.subagent",
                state: {
                  tabs: [],
                  details: {},
                  permissions: [],
                  questions: [],
                },
              })
              footer.event({ type: "stream.view", view: { type: "prompt" } })
              // Fix: a new session starts with no todos and no diff -- without
              // this the footer kept showing the previous session's todo
              // panel/count and modified-file pill.
              footer.event({ type: "stream.todo", todos: [] })
              footer.event({
                type: "stream.patch",
                patch: {
                  phase: "idle",
                  duration: "",
                  contextTokens: 0,
                  contextPercent: null,
                  cost: 0,
                  modified: 0,
                  automode: false,
                  first: true,
                },
              })
              footer.append({
                kind: "system",
                text: `new session ${state.sessionID}`,
                phase: "final",
                source: "system",
              })
              await state.demo?.start()
            } catch (error) {
              footer.event({
                type: "stream.patch",
                patch: {
                  phase: "idle",
                  status: "failed to start new session",
                },
              })
              const commit = {
                kind: "error",
                text: error instanceof Error ? error.message : String(error),
                phase: "start",
                source: "system",
                messageID: MessageID.ascending(),
              } as const
              rememberLocal(commit)
              footer.append(commit)
            }
          }
        : undefined,
      run: async (prompt, signal) => {
        if (state.demo && (await state.demo.prompt(prompt, signal))) {
          return
        }

        await state.switching?.catch(() => {})

        let outputAnchor: LocalReplayAnchor | undefined
        try {
          const next = await ensureStream()
          await next.handle.runPromptTurn({
            agent: state.agent,
            model: state.model,
            variant: state.activeVariant,
            prompt,
            files: input.files,
            includeFiles: state.includeFiles,
            onVisibleOutput: (anchor) => {
              outputAnchor = anchor
            },
            signal,
          })
          if (prompt.messageID) {
            state.localRows = state.localRows.filter(
              (row) => row.commit.kind !== "user" || row.commit.messageID !== prompt.messageID,
            )
          }
          state.includeFiles = false
        } catch (error) {
          if (signal.aborted || footer.isClosed) {
            return
          }

          const text =
            (await state.stream?.then((item) => item.mod).catch(() => undefined))?.formatUnknownError(error) ??
            (error instanceof Error ? error.message : String(error))
          const commit = {
            kind: "error",
            text,
            phase: "start",
            source: "system",
            messageID: prompt.messageID,
          } as const
          rememberLocal(commit, outputAnchor)
          footer.append(commit)
        }
      },
    })
  }

  try {
    const eager = eagerStream(input, ctx)
    if (eager) {
      if (input.replay && state.shown) {
        // Replay commits immutable scrollback rows, so wait for provider names
        // before bootstrapping existing session history.
        await modelTask
      }

      await ensureStream()
      await loadTodos().catch(() => {})
      await loadDiff().catch(() => {})
      await loadAutomode().catch(() => {})
    }

    if (!eager && input.resolveSession) {
      queueMicrotask(() => {
        if (footer.isClosed) {
          return
        }

        void ensureStream().catch(() => {})
      })
    }

    try {
      await runQueue()
    } finally {
      if (resizeTimer) {
        clearTimeout(resizeTimer)
      }
      offResize()
      await state.stream?.then((item) => item.handle.close()).catch(() => {})
    }
  } finally {
    process.off("SIGHUP", onSighup)
    const title = await resolveExitTitle(ctx, input, state)

    await shell.close({
      // Detach exits print their own reattach guidance (see run.ts) after
      // this shell fully tears down, so the generic exit splash -- whose
      // `opencode --mini -s <id>` hint is wrong once the session moved to a
      // background server -- is skipped entirely rather than reworded here.
      showExit: state.shown && hasSession(input, state) && !state.detached,
      sessionTitle: title,
      sessionID: state.sessionID,
      history: state.history,
    })
  }
}

// Local in-process mode. Creates an SDK client backed by a direct fetch to
// the in-process server, so no external HTTP server is needed.
export async function runInteractiveLocalMode(input: RunLocalInput): Promise<void> {
  const sdk = createOpencodeClient({
    baseUrl: "http://opencode.internal",
    fetch: input.fetch,
    directory: input.directory,
  })
  let session: Promise<ResolvedSession> | undefined

  return runInteractiveRuntime({
    files: input.files,
    initialInput: input.initialInput,
    thinking: input.thinking,
    backgroundSubagents: input.backgroundSubagents,
    replay: input.replay,
    replayLimit: input.replayLimit,
    demo: input.demo,
    onDetach: input.onDetach,
    resolveSession: () => {
      if (session) {
        return session
      }

      session = Promise.all([input.resolveAgent(), input.session(sdk)]).then(([agent, next]) => {
        if (!next?.id) {
          throw new Error("Session not found")
        }

        void input.share(sdk, next.id).catch(() => {})
        return {
          sessionID: next.id,
          sessionTitle: next.title,
          agent,
        }
      })
      return session
    },
    createSession: createSessionResolver(input.createSession),
    boot: async () => {
      return {
        sdk,
        directory: input.directory,
        sessionID: "",
        sessionTitle: undefined,
        resume: false,
        agent: input.agent,
        model: input.model,
        variant: input.variant,
      }
    },
  })
}

// Attach mode. Uses the caller-provided SDK client directly.
export async function runInteractiveMode(
  input: RunInput & {
    createSession?: CreateSession
    onDetach?: () => Promise<void>
    onShutdown?: () => Promise<void>
    onExit?: () => void | Promise<void>
  },
  deps?: RunRuntimeDeps,
): Promise<void> {
  return runInteractiveRuntime(
    {
      files: input.files,
      initialInput: input.initialInput,
      thinking: input.thinking,
      backgroundSubagents: input.backgroundSubagents,
      replay: input.replay,
      replayLimit: input.replayLimit,
      demo: input.demo,
      onDetach: input.onDetach,
      onShutdown: input.onShutdown,
      onExit: input.onExit,
      boot: async () => ({
        sdk: input.sdk,
        directory: input.directory,
        sessionID: input.sessionID,
        sessionTitle: input.sessionTitle,
        resume: input.resume,
        agent: input.agent,
        model: input.model,
        variant: input.variant,
      }),
      createSession: createSessionResolver(input.createSession),
    },
    deps,
  )
}
