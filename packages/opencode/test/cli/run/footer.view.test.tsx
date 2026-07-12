/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { BoxRenderable, RGBA, type CapturedFrame, type RootRenderable } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { createSignal } from "solid-js"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "@/cli/ui/keymap"
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
import { RunFooterView } from "@/cli/cmd/run/footer.view"
import { RunEntryContent } from "@/cli/cmd/run/scrollback.writer"
import { RUN_THEME_FALLBACK, type RunTheme } from "@/cli/cmd/run/theme"
import type {
  FooterState,
  FooterSubagentState,
  FooterSubagentTab,
  FooterTodoItem,
  FooterView,
  RunAgent,
  RunCommand,
  RunInput,
  RunPrompt,
  RunProvider,
  RunTuiConfig,
  StreamCommit,
} from "@/cli/cmd/run/types"
import { RunQuestionBody } from "@/cli/cmd/run/footer.question"
import { RejectField } from "@/cli/cmd/run/footer.permission"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const tuiConfig = createTuiResolvedConfig()

function command(input: { name: string; description: string; source?: "command" | "mcp" | "skill" }) {
  return {
    name: input.name,
    description: input.description,
    source: input.source,
    template: "",
    hints: [],
  } satisfies RunCommand
}

function model(input: {
  id: string
  name: string
  status?: "active" | "deprecated"
  cost?: number
  variants?: Record<string, Record<string, never>>
}) {
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
      input: {
        text: true,
        audio: false,
        image: true,
        video: false,
        pdf: true,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    cost: {
      input: input.cost ?? 1,
      output: 1,
      cache: {
        read: 0,
        write: 0,
      },
    },
    limit: {
      context: 128000,
      output: 8192,
    },
    status: input.status ?? "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    variants: input.variants,
  } satisfies RunProvider["models"][string]
}

function provider() {
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
  } satisfies RunProvider
}

function subagent(input: {
  sessionID: string
  label: string
  description: string
  status?: FooterSubagentTab["status"]
}) {
  return {
    sessionID: input.sessionID,
    partID: `part-${input.sessionID}`,
    callID: `call-${input.sessionID}`,
    label: input.label,
    description: input.description,
    status: input.status ?? "running",
    lastUpdatedAt: 1,
  } satisfies FooterSubagentTab
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
  } satisfies RunAgent
}

function footerState(input: Partial<FooterState> = {}) {
  const [state] = createSignal<FooterState>({
    phase: "idle",
    status: "",
    queue: 0,
    model: "",
    agent: "opencode",
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
    ...input,
  })
  return state
}

async function renderFooter(
  input: {
    tuiConfig?: RunTuiConfig
    commands?: RunCommand[]
    theme?: () => RunTheme
    providers?: RunProvider[]
    currentModel?: RunInput["model"]
    currentVariant?: string
    subagents?: FooterSubagentState
    todos?: () => FooterTodoItem[]
    backgroundSubagents?: boolean
    width?: number
    height?: number
    state?: Partial<FooterState>
    onCycle?: () => void
    onSubmit?: (prompt: RunPrompt) => boolean
    agents?: RunAgent[]
    currentAgent?: string
    onAgentSelect?: (agent: string) => void
  } = {},
) {
  const [view] = createSignal<FooterView>({ type: "prompt" })
  const [subagents] = createSignal<FooterSubagentState>(
    input.subagents ?? { tabs: [], details: {}, permissions: [], questions: [] },
  )
  const state = footerState(input.state)
  const config = input.tuiConfig ?? tuiConfig
  let offKeymap: (() => void) | undefined

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    offKeymap = registerOpencodeKeymap(keymap, renderer, config)

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
          subagent={subagents}
          todos={input.todos ?? (() => [])}
          theme={input.theme ?? (() => RUN_THEME_FALLBACK)}
          tuiConfig={config}
          backgroundSubagents={input.backgroundSubagents ?? true}
          currentAgent={() => input.currentAgent ?? "build"}
          onSubmit={input.onSubmit ?? (() => true)}
          onPermissionReply={() => {}}
          onQuestionReply={() => {}}
          onQuestionReject={() => {}}
          onCycle={input.onCycle ?? (() => {})}
          onInterrupt={() => false}
          onEditorOpen={async () => undefined}
          onInputClear={() => {}}
          onExit={() => {}}
          onModelSelect={() => {}}
          onAgentSelect={input.onAgentSelect ?? (() => {})}
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
      <box width={input.width ?? 100} height={input.height ?? 8}>
        <Harness />
      </box>
    ),
    { width: input.width ?? 100, height: input.height ?? 8, kittyKeyboard: true },
  )

  return {
    ...app,
    cleanup() {
      app.renderer.currentFocusedRenderable?.blur()
      app.renderer.currentFocusedEditor?.blur()
      offKeymap?.()
      offKeymap = undefined
      app.renderer.destroy()
    },
  }
}

function expectPaletteList(list: BoxRenderable, selectedIndex: number) {
  expect(list.backgroundColor.toInts()).toEqual([0, 0, 0, 0])
  expect((list.getChildren()[selectedIndex] as BoxRenderable).backgroundColor.toInts()).toEqual([0, 0, 0, 0])
}

function child(root: BoxRenderable | RootRenderable, index: number) {
  return root.getChildren()[index] as BoxRenderable
}

function boxPath(root: BoxRenderable | RootRenderable, name: string): BoxRenderable[] | undefined {
  for (const item of root.getChildren()) {
    if (item.constructor.name === name) return root instanceof BoxRenderable ? [root] : []
    if (!(item instanceof BoxRenderable)) continue
    const path = boxPath(item, name)
    if (path) return root instanceof BoxRenderable ? [root, ...path] : path
  }
}

function footerComposerFrame(root: BoxRenderable | RootRenderable) {
  return boxPath(root, "TextareaRenderable")!.at(-5)!
}

function footerStatusline(root: BoxRenderable | RootRenderable) {
  const outer = child(root, 0)
  const rfv = child(outer, 0)
  const fallback = child(rfv, 1)
  const children = fallback.getChildren().filter((item): item is BoxRenderable => item instanceof BoxRenderable)
  const statusline = children.at(-1)
  if (!statusline) throw new Error("Footer statusline not found")
  return statusline
}

function panelMenu(root: BoxRenderable | RootRenderable) {
  const panel = child(child(root, 0), 0)
  const content = child(panel, 0)
  return child(content.getChildren().at(-1) as BoxRenderable, 0)
}

test("direct footer composer area does not adopt footer surface", async () => {
  const surface = RGBA.fromHex("#123456")
  const [theme, setTheme] = createSignal(RUN_THEME_FALLBACK)
  const app = await renderFooter({ theme })

  try {
    await app.renderOnce()
    const area = child(footerComposerFrame(app.renderer.root), 0)

    expect(area.backgroundColor.toInts()).not.toEqual(surface.toInts())
    setTheme({
      ...RUN_THEME_FALLBACK,
      footer: {
        ...RUN_THEME_FALLBACK.footer,
        surface,
      },
    })
    await app.renderOnce()

    expect(area.backgroundColor.toInts()).not.toEqual(surface.toInts())
  } finally {
    app.cleanup()
  }
})

test("run entry content updates when live commit text changes", async () => {
  const [commit, setCommit] = createSignal<StreamCommit>({
    kind: "tool",
    text: "I",
    phase: "progress",
    source: "tool",
    messageID: "msg-1",
    partID: "part-1",
    tool: "bash",
  })

  const app = await testRender(
    () => (
      <box width={80} height={4}>
        <RunEntryContent commit={commit()} theme={RUN_THEME_FALLBACK} width={80} />
      </box>
    ),
    {
      width: 80,
      height: 4,
    },
  )

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("I")

    setCommit({
      kind: "tool",
      text: "I need to inspect the codebase",
      phase: "progress",
      source: "tool",
      messageID: "msg-1",
      partID: "part-1",
      tool: "bash",
    })
    await app.renderOnce()

    expect(app.captureCharFrame()).toContain("I need to inspect the codebase")
  } finally {
    app.renderer.destroy()
  }
})

test("direct command panel renders grouped command palette", async () => {
  const [commands] = createSignal<RunCommand[] | undefined>([
    command({ name: "review", description: "Review code" }),
    command({ name: "deploy", description: "Deploy prompt", source: "mcp" }),
    command({ name: "internal", description: "Skill command", source: "skill" }),
  ])
  const [subagents] = createSignal([])
  const [variants] = createSignal(["high", "minimal"])

  const app = await testRender(
    () => (
      <box width={100} height={RUN_COMMAND_PANEL_ROWS}>
        <RunCommandMenuBody
          theme={() => RUN_THEME_FALLBACK.footer}
          commands={commands}
          agents={() => []}
          subagents={subagents}
          queued={() => []}
          variants={variants}
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
      </box>
    ),
    {
      width: 100,
      height: RUN_COMMAND_PANEL_ROWS,
    },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("Commands")
    expect(frame).toContain("Search")
    expect(frame).toContain("Session")
    expect(frame).toContain("Agent")
    expect(frame).toContain("Prompt")
    expect(frame).toContain("Open editor")
    expect(frame).toContain("/editor")
    expect(frame).toContain("Switch model")
    expect(frame).toContain("Skills")
    expect(frame).toContain("/skills")
    expect(frame.match(/\bAgent\b/g)?.length).toBe(1)
    expect(frame).not.toContain("┌")
    expect(frame).not.toContain("┃")
    expect(frame).not.toContain("/internal")
    expect(frame).not.toContain("Choose model for future turns")
    expect(frame).not.toContain("Cycle reasoning effort for future turns")
    expect(frame).not.toContain("Review code")
    expect(frame).not.toContain("Commands 8")
  } finally {
    app.renderer.destroy()
  }
})

test("direct command panel lists resume session and finds it by either keyword", async () => {
  const [commands] = createSignal<RunCommand[] | undefined>([])
  const [subagents] = createSignal([])
  const [variants] = createSignal<string[]>([])

  for (const query of ["resume", "sessions"]) {
    const app = await testRender(
      () => (
        <box width={100} height={RUN_COMMAND_PANEL_ROWS}>
          <RunCommandMenuBody
            theme={() => RUN_THEME_FALLBACK.footer}
            commands={commands}
            agents={() => []}
            subagents={subagents}
            queued={() => []}
            variants={variants}
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
        </box>
      ),
      { width: 100, height: RUN_COMMAND_PANEL_ROWS },
    )

    try {
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("Resume session")
      expect(app.captureCharFrame()).toContain("/sessions")

      query.split("").forEach((key) => app.mockInput.pressKey(key))
      await app.renderOnce()

      const frame = app.captureCharFrame()
      expect(frame).toContain("Resume session")
      expect(frame).not.toContain("New session")
    } finally {
      app.renderer.destroy()
    }
  }
})

test("direct command panel selecting resume session dispatches onSessions", async () => {
  const [commands] = createSignal<RunCommand[] | undefined>([])
  const [subagents] = createSignal([])
  const [variants] = createSignal<string[]>([])
  let calls = 0

  const app = await testRender(
    () => (
      <box width={100} height={RUN_COMMAND_PANEL_ROWS}>
        <RunCommandMenuBody
          theme={() => RUN_THEME_FALLBACK.footer}
          commands={commands}
          agents={() => []}
          subagents={subagents}
          queued={() => []}
          variants={variants}
          variantCycle="ctrl+t"
          onClose={() => {}}
          onModel={() => {}}
          onAgent={() => {}}
          onEditor={() => {}}
          onSkill={() => {}}
          onSubagent={() => {}}
          onSessions={() => {
            calls++
          }}
          onQueued={() => {}}
          onVariant={() => {}}
          onVariantCycle={() => {}}
          onCommand={() => {}}
          onNew={() => {}}
          onExit={() => {}}
        />
      </box>
    ),
    { width: 100, height: RUN_COMMAND_PANEL_ROWS },
  )

  try {
    await app.renderOnce()
    "resume".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()
    app.mockInput.pressEnter()

    expect(calls).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("direct skill panel renders searchable skill list", async () => {
  const [commands] = createSignal<RunCommand[] | undefined>([
    command({ name: "review", description: "Review code" }),
    command({ name: "internal", description: "Skill command", source: "skill" }),
    command({ name: "formatter", description: "Apply formatter fixes", source: "skill" }),
  ])

  const app = await testRender(
    () => (
      <box width={100} height={RUN_COMMAND_PANEL_ROWS}>
        <RunSkillSelectBody
          theme={() => RUN_THEME_FALLBACK.footer}
          commands={commands}
          onClose={() => {}}
          onSelect={() => {}}
        />
      </box>
    ),
    {
      width: 100,
      height: RUN_COMMAND_PANEL_ROWS,
    },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("Skills")
    expect(frame).toContain("Search")
    expect(frame).toContain("internal")
    expect(frame).not.toContain("/internal")
    expect(frame).toContain("formatter")
    expect(frame).toContain("Apply formatter fixes")
    expect(frame).not.toContain("review")
  } finally {
    app.renderer.destroy()
  }
})

test("direct skill panel truncates long descriptions from the end", async () => {
  const [commands] = createSignal<RunCommand[] | undefined>([
    command({
      name: "terminal-control",
      description:
        "Control and test terminal applications, REPLs, interactive CLIs, shell processes, OpenTUI applications, or other terminal-backed workflows.",
      source: "skill",
    }),
  ])

  const app = await testRender(
    () => (
      <box width={100} height={RUN_COMMAND_PANEL_ROWS}>
        <RunSkillSelectBody
          theme={() => RUN_THEME_FALLBACK.footer}
          commands={commands}
          onClose={() => {}}
          onSelect={() => {}}
        />
      </box>
    ),
    {
      width: 100,
      height: RUN_COMMAND_PANEL_ROWS,
    },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("terminal-control")
    expect(frame).toContain("Control and test terminal applications")
    expect(frame).not.toMatch(/application(?:…|\.\.\.)ocess/)
  } finally {
    app.renderer.destroy()
  }
})

test("direct command panel shows subagent entry when available", async () => {
  const [commands] = createSignal<RunCommand[] | undefined>([])
  const [subagents] = createSignal([subagent({ sessionID: "s-1", label: "Explore", description: "Inspect auth flow" })])
  const [variants] = createSignal<string[]>([])

  const app = await testRender(
    () => (
      <box width={100} height={RUN_COMMAND_PANEL_ROWS}>
        <RunCommandMenuBody
          theme={() => RUN_THEME_FALLBACK.footer}
          commands={commands}
          agents={() => []}
          subagents={subagents}
          queued={() => []}
          variants={variants}
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
      </box>
    ),
    {
      width: 100,
      height: RUN_COMMAND_PANEL_ROWS,
    },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("View subagents")
    expect(frame).toContain("1 active")
  } finally {
    app.renderer.destroy()
  }
})

test("direct command panel keeps completed subagents available", async () => {
  const [commands] = createSignal<RunCommand[] | undefined>([])
  const [subagents] = createSignal([
    subagent({ sessionID: "s-1", label: "Explore", description: "Inspect auth flow", status: "completed" }),
  ])
  const [variants] = createSignal<string[]>([])

  const app = await testRender(
    () => (
      <box width={100} height={RUN_COMMAND_PANEL_ROWS}>
        <RunCommandMenuBody
          theme={() => RUN_THEME_FALLBACK.footer}
          commands={commands}
          agents={() => []}
          subagents={subagents}
          queued={() => []}
          variants={variants}
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
      </box>
    ),
    {
      width: 100,
      height: RUN_COMMAND_PANEL_ROWS,
    },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("View subagents")
    expect(frame).toContain("1 recent")
  } finally {
    app.renderer.destroy()
  }
})

test("direct subagent panel renders active subagents", async () => {
  const [tabs] = createSignal([
    subagent({ sessionID: "s-1", label: "Explore", description: "Inspect auth flow" }),
    subagent({ sessionID: "s-2", label: "General", description: "Write migration plan", status: "completed" }),
  ])
  const [current] = createSignal<string | undefined>("s-1")
  let rows = 0

  const app = await testRender(
    () => (
      <box width={100} height={RUN_SUBAGENT_PANEL_ROWS}>
        <RunSubagentSelectBody
          theme={() => RUN_THEME_FALLBACK.footer}
          tabs={tabs}
          current={current}
          onClose={() => {}}
          onSelect={() => {}}
          onRows={(value) => {
            rows = value
          }}
        />
      </box>
    ),
    {
      width: 100,
      height: RUN_SUBAGENT_PANEL_ROWS,
    },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    const list = panelMenu(app.renderer.root)

    expect(frame).toContain("Select subagent")
    expect(frame).toContain("Inspect auth flow")
    expect(frame).toContain("Write migration plan")
    expect(frame).toContain("done")
    expect(frame).not.toContain("┌")
    expect(frame).not.toContain("┃")
    expectPaletteList(list, 0)
    expect(rows).toBe(8)
  } finally {
    app.renderer.destroy()
  }
})

test("direct queued prompt panel renders pending prompt actions", async () => {
  const [prompts] = createSignal([
    { messageID: "m-1", partID: "p-1", prompt: { text: "fix the auth test", parts: [] } },
  ])

  const app = await testRender(
    () => (
      <box width={100} height={RUN_SUBAGENT_PANEL_ROWS}>
        <RunQueuedPromptSelectBody
          theme={() => RUN_THEME_FALLBACK.footer}
          prompts={prompts}
          onClose={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
        />
      </box>
    ),
    { width: 100, height: RUN_SUBAGENT_PANEL_ROWS },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    const list = panelMenu(app.renderer.root)

    expect(frame).toContain("Queued prompts")
    expect(frame).toContain("fix the auth test")
    expect(frame).toContain("queued")
    expect(frame).not.toContain("┌")
    expect(frame).not.toContain("┃")
    expectPaletteList(list, 0)
  } finally {
    app.renderer.destroy()
  }
})

// OpenTUI currently crashes Bun in the full `test/cli/run` directory run here.
// Re-enable after the upstream OpenTUI fix lands in this repo.
test.skip("direct footer recreates the frame across command panel transitions", async () => {
  const app = await renderFooter()

  try {
    await app.renderOnce()

    for (let index = 0; index < 3; index++) {
      const composerFrame = footerComposerFrame(app.renderer.root)
      app.mockInput.pressKey("p", { ctrl: true })
      await app.renderOnce()

      expect(app.captureCharFrame()).toContain("Commands")
      expect(footerComposerFrame(app.renderer.root)).not.toBe(composerFrame)
      app.mockInput.pressKey("c", { ctrl: true })
      await app.renderOnce()
      expect(app.captureCharFrame()).not.toContain("Commands")
      expect(app.captureCharFrame()).not.toContain("┃")
      expect(app.captureCharFrame()).not.toContain("█")
    }
  } finally {
    app.cleanup()
  }
})

test.skip("direct footer dispatches leader variant binding only when leader is registered", async () => {
  const calls: string[] = []
  const app = await renderFooter({
    tuiConfig: createTuiResolvedConfig({ keybinds: { leader: "ctrl+x", variant_cycle: "<leader>t" } }),
    onCycle: () => calls.push("cycle"),
  })

  try {
    await app.renderOnce()
    app.mockInput.pressKey("t")
    expect(calls).toEqual([])

    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("t")
    expect(calls).toEqual(["cycle"])
  } finally {
    app.cleanup()
  }
})

test("direct footer keeps leader variant binding inactive when leader is disabled", async () => {
  const calls: string[] = []
  const app = await renderFooter({
    tuiConfig: createTuiResolvedConfig({ keybinds: { leader: "none", variant_cycle: "<leader>t" } }),
    onCycle: () => calls.push("cycle"),
  })

  try {
    await app.renderOnce()
    app.mockInput.pressKey("t")
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("t")

    expect(calls).toEqual([])
  } finally {
    app.cleanup()
  }
})

test("direct footer submits slash autocomplete selections without dispatching shell completions", async () => {
  const submits: RunPrompt[] = []
  const app = await renderFooter({
    commands: [command({ name: "review", description: "Review code" })],
    onSubmit(prompt) {
      submits.push(prompt)
      return true
    },
  })

  try {
    await app.renderOnce()
    "/rev".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()

    "/rev".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()
    app.mockInput.pressKey("TAB")
    await app.renderOnce()

    "/re branch".split("").forEach((key) => app.mockInput.pressKey(key))
    Array.from({ length: 7 }).forEach(() => app.mockInput.pressKey("ARROW_LEFT"))
    app.mockInput.pressKey("v")
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()

    "/nx".split("").forEach((key) => app.mockInput.pressKey(key))
    app.mockInput.pressKey("ARROW_LEFT")
    app.mockInput.pressKey("e")
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()

    "/n scratch".split("").forEach((key) => app.mockInput.pressKey(key))
    Array.from({ length: 8 }).forEach(() => app.mockInput.pressKey("ARROW_LEFT"))
    app.mockInput.pressKey("e")
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()

    app.mockInput.pressKey("!")
    "/rev".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()

    expect(submits).toEqual([
      { text: "/review ", parts: [], command: { name: "review", arguments: "" } },
      { text: "/review ", parts: [], command: { name: "review", arguments: "" } },
      { text: "/review branch", parts: [], command: { name: "review", arguments: "branch" } },
      { text: "/new ", parts: [] },
      { text: "/new ", parts: [] },
    ])
    expect(app.captureCharFrame()).toContain("/review")
  } finally {
    app.cleanup()
  }
})

test("direct footer slash autocomplete keeps a real skills command", async () => {
  const submits: RunPrompt[] = []
  const app = await renderFooter({
    commands: [
      command({ name: "skills", description: "Run the real skills command" }),
      command({ name: "formatter", description: "Apply formatter fixes", source: "skill" }),
    ],
    onSubmit(prompt) {
      submits.push(prompt)
      return true
    },
  })

  try {
    await app.renderOnce()
    "/skills".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()

    expect(submits).toEqual([{ text: "/skills ", parts: [], command: { name: "skills", arguments: "" } }])
    expect(app.captureCharFrame()).not.toContain("Apply formatter fixes")
  } finally {
    app.cleanup()
  }
})

// OpenTUI currently segfaults Bun while tearing down this composer-to-skill-panel transition.
// Re-enable after the upstream renderer teardown fix lands.
test.skip("direct footer skill picker inserts an editable bound skill command", async () => {
  const submits: RunPrompt[] = []
  const app = await renderFooter({
    commands: [command({ name: "new", description: "Skill named new", source: "skill" })],
    onSubmit(prompt) {
      submits.push(prompt)
      return true
    },
  })

  try {
    await app.renderOnce()
    "/skills".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()

    expect(app.captureCharFrame()).toContain("Skill named new")

    app.mockInput.pressEnter()
    await app.renderOnce()

    expect(submits).toEqual([])
    expect(app.captureCharFrame()).toContain("/new")

    "task".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()

    expect(submits).toEqual([{ text: "/new task", parts: [], command: { name: "new", arguments: "task" } }])
  } finally {
    app.cleanup()
  }
})

// OpenTUI currently segfaults Bun while tearing down this skill-panel close transition.
// Re-enable after the upstream renderer teardown fix lands.
test.skip("direct footer clears the synthetic skills draft when the panel closes", async () => {
  const submits: RunPrompt[] = []
  const app = await renderFooter({
    commands: [command({ name: "formatter", description: "Apply formatter fixes", source: "skill" })],
    onSubmit(prompt) {
      submits.push(prompt)
      return true
    },
  })

  try {
    await app.renderOnce()
    "/skills".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()

    expect(app.captureCharFrame()).toContain("Apply formatter fixes")

    app.mockInput.pressKey("c", { ctrl: true })
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()

    expect(submits).toEqual([])
    expect(app.captureCharFrame()).not.toContain("/skills")
  } finally {
    app.cleanup()
  }
})

test("direct footer shows editable prompts and additional queued work while running", async () => {
  const [state] = createSignal<FooterState>({
    phase: "running",
    status: "",
    queue: 3,
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
  })
  const [view] = createSignal<FooterView>({ type: "prompt" })
  const [subagents] = createSignal<FooterSubagentState>({
    tabs: [subagent({ sessionID: "s-1", label: "Explore", description: "Inspect auth flow" })],
    details: {},
    permissions: [],
    questions: [],
  })
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
          agents={() => []}
          resources={() => []}
          commands={() => []}
          providers={() => undefined}
          currentModel={() => ({
            providerID: "opencode",
            modelID: "a-model-name-long-enough-to-force-responsive-truncation",
          })}
          variants={() => []}
          currentVariant={() => undefined}
          state={state}
          view={view}
          subagent={subagents}
          queuedPrompts={() => [
            { messageID: "m-queued", partID: "p-queued", prompt: { text: "follow up", parts: [] } },
          ]}
          theme={() => RUN_THEME_FALLBACK}
          tuiConfig={tuiConfig}
          backgroundSubagents={true}
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
      <box width={160} height={8}>
        <Harness />
      </box>
    ),
    {
      width: 160,
      height: 8,
    },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    const transparent = RGBA.fromValues(0, 0, 0, 0).toInts()
    const statusline = footerStatusline(app.renderer.root)
    const statusItems = statusline.getChildren().filter((item): item is BoxRenderable => item instanceof BoxRenderable)
    const mode = statusItems[0]
    const main = statusItems[1]
    const spinner = main.getChildren()[0]
    const model = statusItems[2]
    const queued = statusItems[3]
    const hint = statusItems.at(-1)!

    expect(spinner).toBeDefined()
    expect(frame).toContain("a-model-name-long-enough-to-force-responsive-truncation")
    expect(frame).toContain("3 queued")
    expect(frame).toContain("ctrl+b background")
    expect(frame).toContain("ctrl+x q 3 queued")
    expect(frame).toContain("ctrl+x down subagents")
    expect(frame).toContain("ctrl+p cmd")
    expect(frame).toContain("a-model-name-long-enough-to-force-responsive-truncation")
    expect(frame).toContain("subagents · ctrl+p cmd")
    expect(frame).not.toContain("1 agent")
    expect(statusline.backgroundColor.toInts()).toEqual(transparent)
    expect(mode.backgroundColor.toInts()).toEqual(transparent)
    expect(main.backgroundColor.toInts()).toEqual(transparent)
    expect(model.backgroundColor.toInts()).toEqual(transparent)
    expect(queued.backgroundColor.toInts()).toEqual(transparent)
    expect(hint.backgroundColor.toInts()).toEqual(transparent)
  } finally {
    app.renderer.currentFocusedRenderable?.blur()
    app.renderer.currentFocusedEditor?.blur()
    offKeymap?.()
    app.renderer.destroy()
  }
})

test("direct footer separates a lone context hint from model and command hint", async () => {
  const app = await renderFooter({
    providers: [provider()],
    currentModel: { providerID: "opencode", modelID: "gpt-5" },
    currentVariant: "xhigh",
    subagents: {
      tabs: [subagent({ sessionID: "s-1", label: "Explore", description: "Inspect auth flow" })],
      details: {},
      permissions: [],
      questions: [],
    },
    backgroundSubagents: false,
    width: 160,
  })

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("GPT-5")
    expect(frame).toContain("xhigh · ctrl+x down subagents · ctrl+p cmd")
    expect(frame).not.toContain("ctrl+b background")
    expect(frame).not.toContain("queued")
  } finally {
    app.cleanup()
  }
})

test("direct footer hides the subagent hint when only completed subagents remain", async () => {
  const app = await renderFooter({
    providers: [provider()],
    currentModel: { providerID: "opencode", modelID: "gpt-5" },
    currentVariant: "xhigh",
    subagents: {
      tabs: [subagent({ sessionID: "s-1", label: "Explore", description: "Inspect auth flow", status: "completed" })],
      details: {},
      permissions: [],
      questions: [],
    },
    backgroundSubagents: false,
    width: 160,
  })

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("GPT-5")
    expect(frame).toContain("xhigh · ctrl+p cmd")
    expect(frame).not.toContain("ctrl+x down subagents")
  } finally {
    app.cleanup()
  }
})

test("direct footer omits interrupt key hint when interrupt is unbound", async () => {
  const app = await renderFooter({
    tuiConfig: createTuiResolvedConfig({ keybinds: { session_interrupt: "none", input_clear: "ctrl+l" } }),
    state: { phase: "running" },
  })

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("interrupt")
    expect(frame).not.toContain("ctrl+l")
  } finally {
    app.cleanup()
  }
})

test("direct footer renders all four info pills separated by middots", async () => {
  const app = await renderFooter({
    width: 130,
    state: { contextTokens: 159_600, contextPercent: 42, cost: 4.23, modified: 3 },
    todos: () => [
      { status: "pending", content: "one" },
      { status: "completed", content: "two" },
    ],
  })

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("◆ 42%")
    expect(frame).toContain("$4.23")
    expect(frame).toContain("☐ 1")
    expect(frame).toContain("✎ 3")
    expect(frame).toContain("◆ 42% · $4.23 · ☐ 1 · ✎ 3")
  } finally {
    app.cleanup()
  }
})

test("direct footer shows the full context form once spacious", async () => {
  const app = await renderFooter({
    width: 150,
    state: { contextTokens: 159_600, contextPercent: 16 },
  })

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("◆ 159.6K (16%)")
  } finally {
    app.cleanup()
  }
})

test("direct footer colors the ctx% pill by threshold", async () => {
  const app = await renderFooter({ width: 130, state: { contextTokens: 1000, contextPercent: 50 } })

  try {
    await app.renderOnce()
    expect(findSpan(app.captureSpans(), "50%")?.fg.toInts()).toEqual((RUN_THEME_FALLBACK.footer.muted as RGBA).toInts())
  } finally {
    app.cleanup()
  }
})

test("direct footer colors the ctx% pill warning at 80% and error at 95%", async () => {
  const warn = await renderFooter({ width: 130, state: { contextTokens: 1000, contextPercent: 80 } })
  try {
    await warn.renderOnce()
    expect(findSpan(warn.captureSpans(), "80%")?.fg.toInts()).toEqual(
      (RUN_THEME_FALLBACK.footer.warning as RGBA).toInts(),
    )
  } finally {
    warn.cleanup()
  }

  const error = await renderFooter({ width: 130, state: { contextTokens: 1000, contextPercent: 95 } })
  try {
    await error.renderOnce()
    expect(findSpan(error.captureSpans(), "95%")?.fg.toInts()).toEqual(
      (RUN_THEME_FALLBACK.footer.error as RGBA).toInts(),
    )
  } finally {
    error.cleanup()
  }
})

test("direct footer hides zero-value pills", async () => {
  const app = await renderFooter({
    width: 130,
    state: { contextTokens: 1000, contextPercent: 10, cost: 0, modified: 0 },
    todos: () => [],
  })

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("◆ 10%")
    expect(frame).not.toContain("$")
    expect(frame).not.toContain("☐")
    expect(frame).not.toContain("✎")
  } finally {
    app.cleanup()
  }
})

test("direct footer shows a budget-fraction cost pill colored by threshold", async () => {
  const budgetAgent = agent({ name: "budget-build", mode: "primary", budget: { soft: 1.5, hard: 2.5 } })

  const ok = await renderFooter({
    width: 130,
    agents: [budgetAgent],
    state: { agent: "budget-build", cost: 0.42 },
  })
  try {
    await ok.renderOnce()
    expect(ok.captureCharFrame()).toContain("$0.42/$1.50")
    expect(findSpan(ok.captureSpans(), "$0.42/$1.50")?.fg.toInts()).toEqual(
      (RUN_THEME_FALLBACK.footer.muted as RGBA).toInts(),
    )
  } finally {
    ok.cleanup()
  }

  const soft = await renderFooter({
    width: 130,
    agents: [budgetAgent],
    state: { agent: "budget-build", cost: 1.52 },
  })
  try {
    await soft.renderOnce()
    expect(soft.captureCharFrame()).toContain("$1.52/$1.50")
    expect(findSpan(soft.captureSpans(), "$1.52/$1.50")?.fg.toInts()).toEqual(
      (RUN_THEME_FALLBACK.footer.warning as RGBA).toInts(),
    )
  } finally {
    soft.cleanup()
  }

  const hard = await renderFooter({
    width: 130,
    agents: [budgetAgent],
    state: { agent: "budget-build", cost: 2.5 },
  })
  try {
    await hard.renderOnce()
    expect(hard.captureCharFrame()).toContain("$2.50/$1.50")
    expect(findSpan(hard.captureSpans(), "$2.50/$1.50")?.fg.toInts()).toEqual(
      (RUN_THEME_FALLBACK.footer.error as RGBA).toInts(),
    )
  } finally {
    hard.cleanup()
  }
})

test("direct footer keeps the plain cost pill when the current agent has no budget", async () => {
  const app = await renderFooter({
    width: 130,
    agents: [agent({ name: "build", mode: "primary" })],
    state: { agent: "build", cost: 4.23 },
  })

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("$4.23")
    expect(frame).not.toContain("$4.23/")
  } finally {
    app.cleanup()
  }
})

test("direct footer degrades the budget pill at the same width breakpoint as the plain cost pill", async () => {
  const budgetAgent = agent({ name: "budget-build", mode: "primary", budget: { soft: 1.5, hard: 2.5 } })
  const app = await renderFooter({
    width: 85,
    agents: [budgetAgent],
    state: { agent: "budget-build", cost: 0.42 },
  })

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("$0.42")
  } finally {
    app.cleanup()
  }
})

function pillsRow(frame: string) {
  return frame.split("\n").find((line) => line.includes("BUILD") && line.includes("cmd")) ?? ""
}

test("direct footer drops info pills by priority as width shrinks", async () => {
  const state = {
    contextTokens: 1000,
    contextPercent: 42,
    cost: 4.23,
    modified: 3,
  } satisfies Partial<FooterState>
  // The todo panel's own checkbox glyph ("☐ one") also uses ☐, so the
  // pills-row assertions below check the status line specifically rather
  // than the whole frame.
  const todos = () => [{ status: "pending", content: "one" }]

  const full = await renderFooter({ width: 130, state, todos })
  try {
    await full.renderOnce()
    const frame = full.captureCharFrame()
    expect(frame).toContain("◆ 42%")
    expect(frame).toContain("$4.23")
    expect(frame).toContain("☐ 1")
    expect(frame).toContain("✎ 3")
  } finally {
    full.cleanup()
  }

  const noModified = await renderFooter({ width: 110, state, todos })
  try {
    await noModified.renderOnce()
    const frame = noModified.captureCharFrame()
    expect(frame).toContain("◆ 42%")
    expect(frame).toContain("$4.23")
    expect(frame).toContain("☐ 1")
    expect(frame).not.toContain("✎")
  } finally {
    noModified.cleanup()
  }

  const noTodos = await renderFooter({ width: 95, state, todos })
  try {
    await noTodos.renderOnce()
    const frame = noTodos.captureCharFrame()
    expect(frame).toContain("◆ 42%")
    expect(frame).toContain("$4.23")
    expect(pillsRow(frame)).not.toContain("☐")
    expect(frame).not.toContain("✎")
  } finally {
    noTodos.cleanup()
  }

  const noCost = await renderFooter({ width: 85, state, todos })
  try {
    await noCost.renderOnce()
    const frame = noCost.captureCharFrame()
    expect(frame).toContain("◆ 42%")
    expect(frame).not.toContain("$")
    expect(pillsRow(frame)).not.toContain("☐")
    expect(frame).not.toContain("✎")
  } finally {
    noCost.cleanup()
  }

  const hidden = await renderFooter({ width: 79, state, todos })
  try {
    await hidden.renderOnce()
    const frame = hidden.captureCharFrame()
    expect(frame).not.toContain("◆")
    expect(frame).not.toContain("$")
    expect(pillsRow(frame)).not.toContain("☐")
    expect(frame).not.toContain("✎")
  } finally {
    hidden.cleanup()
  }
})

test("direct footer mode label keeps left padding without a status pill", async () => {
  const app = await renderFooter({ state: { agent: "build" } })

  try {
    await app.renderOnce()
    const statusline = app
      .captureCharFrame()
      .split("\n")
      .find((line) => line.includes("BUILD") && line.includes("cmd"))

    expect(statusline).toBeDefined()
    expect(statusline?.startsWith("BUILD ")).toBe(true)
  } finally {
    app.cleanup()
  }
})

test("direct footer mode label reflects a custom agent", async () => {
  const app = await renderFooter({ state: { agent: "plan" } })

  try {
    await app.renderOnce()
    const statusline = app
      .captureCharFrame()
      .split("\n")
      .find((line) => line.includes("PLAN") && line.includes("cmd"))

    expect(statusline).toBeDefined()
  } finally {
    app.cleanup()
  }
})

test("direct footer shows AUTO pill when automode is enabled", async () => {
  const app = await renderFooter({
    width: 130,
    state: { automode: true },
  })

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("AUTO")
  } finally {
    app.cleanup()
  }
})

test("direct footer hides AUTO pill when automode is off", async () => {
  const app = await renderFooter({ width: 130, state: { automode: false } })

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).not.toContain("AUTO")
  } finally {
    app.cleanup()
  }
})

test("direct footer command panel selecting an agent dispatches onAgentSelect", async () => {
  const selected: string[] = []
  const app = await renderFooter({
    height: RUN_COMMAND_PANEL_ROWS + 8,
    agents: [agent({ name: "build", mode: "primary" }), agent({ name: "plan", mode: "primary" })],
    onAgentSelect: (next) => {
      selected.push(next)
    },
  })

  try {
    await app.renderOnce()
    app.mockInput.pressKey("p", { ctrl: true })
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Switch agent")

    // Open editor, Resume session, New session, Switch model precede the
    // Agent category's Switch agent entry -- four steps down from the
    // initial selection.
    Array.from({ length: 4 }).forEach(() => app.mockInput.pressKey("ARROW_DOWN"))
    app.mockInput.pressEnter()
    await app.renderOnce()

    expect(app.captureCharFrame()).toContain("Select agent")

    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressEnter()
    await app.renderOnce()

    expect(selected).toEqual(["plan"])
  } finally {
    app.cleanup()
  }
})

test("direct question body separates single-select checkmark from label", async () => {
  const request = {
    id: "question-1",
    sessionID: "session-1",
    questions: [
      {
        question: "Which categorical concept is often described as a universal way to combine two objects?",
        header: "Universal Product",
        options: [
          { label: "Product", description: "A product comes with projections." },
          { label: "Equalizer", description: "An equalizer selects morphisms where arrows agree." },
        ],
      },
    ],
  } satisfies QuestionRequest
  const replies: unknown[] = []

  const app = await testRender(
    () => (
      <box width={100} height={12}>
        <RunQuestionBody
          request={request}
          theme={RUN_THEME_FALLBACK.footer}
          onReply={(input) => {
            replies.push(input)
          }}
          onReject={() => {}}
        />
      </box>
    ),
    {
      width: 100,
      height: 12,
    },
  )

  try {
    app.mockInput.pressEnter()
    await app.renderOnce()

    expect(replies).toHaveLength(1)
    expect(app.captureCharFrame()).toContain("Product  ✓")
  } finally {
    app.renderer.destroy()
  }
})

// OpenTUI currently segfaults while tearing down this textarea-backed keymap renderer.
// Re-enable after the runtime fix.
test.skip("direct custom answer submits through keymap return binding", async () => {
  const question = {
    id: "question-1",
    sessionID: "session-1",
    questions: [
      {
        question: "Which answer should I use?",
        header: "Answer",
        options: [{ label: "Provided", description: "Use the listed answer." }],
        custom: true,
      },
    ],
  } satisfies QuestionRequest
  const questions: unknown[] = []
  let off: (() => void) | undefined

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    off = registerOpencodeKeymap(keymap, renderer, tuiConfig)

    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <RunQuestionBody
          request={question}
          theme={RUN_THEME_FALLBACK.footer}
          onReply={(input) => {
            questions.push(input)
          }}
          onReject={() => {}}
        />
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(
    () => (
      <box width={100} height={18}>
        <Harness />
      </box>
    ),
    { width: 100, height: 18, kittyKeyboard: true },
  )

  try {
    await app.renderOnce()
    app.mockInput.pressKey("2")
    await app.renderOnce()
    "typed".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(questions).toEqual([{ requestID: "question-1", answers: [["typed"]] }])
  } finally {
    app.renderer.currentFocusedRenderable?.blur()
    app.renderer.currentFocusedEditor?.blur()
    off?.()
    app.renderer.destroy()
  }
})

test("direct permission rejection submits through keymap return binding", async () => {
  let text = ""
  const submits: string[] = []
  let off: (() => void) | undefined

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    off = registerOpencodeKeymap(keymap, renderer, tuiConfig)

    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <RejectField
          theme={RUN_THEME_FALLBACK.footer}
          text=""
          disabled={false}
          onChange={(input) => {
            text = input
          }}
          onConfirm={() => {
            submits.push(text)
          }}
          onCancel={() => {}}
        />
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(
    () => (
      <box width={100} height={18}>
        <Harness />
      </box>
    ),
    { width: 100, height: 18, kittyKeyboard: true },
  )

  try {
    await app.renderOnce()
    "retry".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("retry")
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(submits).toEqual(["retry"])
  } finally {
    app.renderer.currentFocusedRenderable?.blur()
    app.renderer.currentFocusedEditor?.blur()
    off?.()
    app.renderer.destroy()
  }
})

test("direct model panel renders current model selector", async () => {
  const [providers] = createSignal<RunProvider[] | undefined>([provider()])
  const [current] = createSignal<RunInput["model"]>({ providerID: "opencode", modelID: "gpt-5" })

  const app = await testRender(
    () => (
      <box width={100} height={RUN_COMMAND_PANEL_ROWS}>
        <RunModelSelectBody
          theme={() => RUN_THEME_FALLBACK.footer}
          providers={providers}
          current={current}
          onClose={() => {}}
          onSelect={() => {}}
        />
      </box>
    ),
    {
      width: 100,
      height: RUN_COMMAND_PANEL_ROWS,
    },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    const list = panelMenu(app.renderer.root)

    expect(frame).toContain("Select model")
    expect(frame).toContain("Search")
    expect(frame).toContain("opencode")
    expect(frame).toContain("GPT-5")
    expect(frame).toContain("current")
    expect(frame).toContain("GPT Free")
    expect(frame).toContain("Free")
    expect(frame).not.toContain("┌")
    expect(frame).not.toContain("┃")
    expect(frame).not.toContain("Old Model")
    expectPaletteList(list, 2)
  } finally {
    app.renderer.destroy()
  }
})

test("direct variant panel renders current variant selector", async () => {
  const [variants] = createSignal(["high", "minimal"])
  const [current] = createSignal<string | undefined>("high")

  const app = await testRender(
    () => (
      <box width={100} height={RUN_COMMAND_PANEL_ROWS}>
        <RunVariantSelectBody
          theme={() => RUN_THEME_FALLBACK.footer}
          variants={variants}
          current={current}
          onClose={() => {}}
          onSelect={() => {}}
        />
      </box>
    ),
    {
      width: 100,
      height: RUN_COMMAND_PANEL_ROWS,
    },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    const list = panelMenu(app.renderer.root)

    expect(frame).toContain("Select variant")
    expect(frame).toContain("Default")
    expect(frame).toContain("high")
    expect(frame).toContain("minimal")
    expect(frame).toContain("current")
    expect(frame).not.toContain("┌")
    expect(frame).not.toContain("┃")
    expectPaletteList(list, 1)
  } finally {
    app.renderer.destroy()
  }
})

function capturedSpans(frame: CapturedFrame) {
  return frame.lines.flatMap((line, row) => line.spans.map((span) => ({ ...span, row })))
}

function findSpan(frame: CapturedFrame, text: string) {
  return capturedSpans(frame).find((span) => span.text.includes(text))
}

function glyphColorForContent(frame: CapturedFrame, content: string) {
  const spans = capturedSpans(frame)
  const contentSpan = spans.find((span) => span.text.includes(content))
  if (!contentSpan) return undefined

  const rowSpans = spans.filter((span) => span.row === contentSpan.row)
  const contentIndex = rowSpans.findIndex((span) => span === contentSpan)
  const glyphSpan = rowSpans.slice(0, contentIndex).findLast((span) => /[☒☐]/.test(span.text))
  return glyphSpan?.fg
}

test("direct footer todo panel renders todos with status glyphs and colors", async () => {
  const [todos, setTodos] = createSignal<FooterTodoItem[]>([
    { status: "completed", content: "Set up project" },
    { status: "in_progress", content: "Implement feature" },
    { status: "pending", content: "Write tests" },
  ])

  const app = await renderFooter({ todos, height: 12 })

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("Set up project")
    expect(frame).toContain("Implement feature")
    expect(frame).toContain("Write tests")

    const spans = app.captureSpans()
    expect(findSpan(spans, "☒")).toBeDefined()
    expect(findSpan(spans, "☐")).toBeDefined()

    expect(glyphColorForContent(spans, "Set up project")?.toInts()).toEqual(
      (RUN_THEME_FALLBACK.footer.muted as RGBA).toInts(),
    )
    expect(glyphColorForContent(spans, "Implement feature")?.toInts()).toEqual(
      (RUN_THEME_FALLBACK.footer.warning as RGBA).toInts(),
    )
    expect(glyphColorForContent(spans, "Write tests")?.toInts()).toEqual(
      (RUN_THEME_FALLBACK.footer.muted as RGBA).toInts(),
    )

    setTodos([])
    await app.renderOnce()
    const emptyFrame = app.captureCharFrame()
    expect(emptyFrame).not.toContain("Set up project")
    expect(emptyFrame).not.toContain("Implement feature")
    expect(emptyFrame).not.toContain("Write tests")
  } finally {
    app.cleanup()
  }
})

test("direct footer todo panel is hidden when empty", async () => {
  const app = await renderFooter({ height: 12 })

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).not.toContain("☒")
    expect(frame).not.toContain("☐")
  } finally {
    app.cleanup()
  }
})

test("direct footer todo panel shows an overflow row past the max", async () => {
  const todos: FooterTodoItem[] = Array.from({ length: 8 }, (_, index) => ({
    status: "pending",
    content: `Task ${index + 1}`,
  }))

  const app = await renderFooter({ todos: () => todos, height: 12 })

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    for (let index = 1; index <= 6; index += 1) {
      expect(frame).toContain(`Task ${index}`)
    }
    expect(frame).not.toContain("Task 7")
    expect(frame).not.toContain("Task 8")
    expect(frame).toContain("+2 more")
  } finally {
    app.cleanup()
  }
})
