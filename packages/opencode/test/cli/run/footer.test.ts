import { afterEach, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { RunFooter } from "@/cli/cmd/run/footer"
import { RUN_THEME_FALLBACK } from "@/cli/cmd/run/theme"
import type { FooterSubagentState, FooterSubagentTab } from "@/cli/cmd/run/types"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const FOOTER_BASE = 6
const teardown: (() => void)[] = []

afterEach(() => {
  for (const fn of teardown.splice(0)) fn()
})

async function setup() {
  const out = await createTestRenderer({
    width: 80,
    screenMode: "split-footer",
    footerHeight: FOOTER_BASE,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  const footer = new RunFooter(out.renderer, {
    directory: "/tmp",
    findFiles: async () => [],
    agents: [],
    resources: [],
    sessionID: () => "ses_main",
    agent: "build",
    agentLabel: "Build",
    modelLabel: "model",
    model: undefined,
    variant: undefined,
    first: false,
    theme: RUN_THEME_FALLBACK,
    keymap: createDefaultOpenTuiKeymap(out.renderer),
    tuiConfig: createTuiResolvedConfig(),
    backgroundSubagents: false,
    diffStyle: "auto",
    onPermissionReply: () => {},
    onQuestionReply: () => {},
    onQuestionReject: () => {},
    onEditorOpen: async () => undefined,
  })

  teardown.push(() => {
    footer.destroy()
    out.renderer.destroy()
  })

  return { renderer: out.renderer, footer }
}

function tab(input: Partial<FooterSubagentTab> & Pick<FooterSubagentTab, "sessionID" | "status">): FooterSubagentTab {
  return {
    partID: `prt_${input.sessionID}`,
    callID: `call_${input.sessionID}`,
    label: "Explore",
    description: "look around",
    lastUpdatedAt: Date.now(),
    ...input,
  }
}

function state(tabs: FooterSubagentTab[]): FooterSubagentState {
  return { tabs, details: {}, permissions: [], questions: [] }
}

// The reducer rebuilds every snapshot from its own tab map, so a tab the
// footer already pruned still arrives on the next event. Resurrecting it
// flashes a stale "Done" row under the composer and reflows the footer.
test("a pruned subagent tab stays pruned when later snapshots still carry it", async () => {
  const { renderer, footer } = await setup()

  footer.event({ type: "stream.subagent", state: state([tab({ sessionID: "ses_a", status: "running" })]) })
  expect(renderer.footerHeight).toBe(FOOTER_BASE + 2)

  // Finished long enough ago that the linger timer fires on the next macrotask.
  const done = tab({ sessionID: "ses_a", status: "completed", lastUpdatedAt: Date.now() - 60_000 })
  footer.event({ type: "stream.subagent", state: state([done]) })
  await Bun.sleep(20)
  expect(renderer.footerHeight).toBe(FOOTER_BASE)

  // A second task starts: the snapshot still lists the pruned, completed tab.
  footer.event({ type: "stream.subagent", state: state([tab({ sessionID: "ses_b", status: "running" }), done]) })
  expect(renderer.footerHeight).toBe(FOOTER_BASE + 2)

  await Bun.sleep(20)
  expect(renderer.footerHeight).toBe(FOOTER_BASE + 2)
})

test("a pruned session that runs again re-enters the tree", async () => {
  const { renderer, footer } = await setup()

  const done = tab({ sessionID: "ses_a", status: "completed", lastUpdatedAt: Date.now() - 60_000 })
  footer.event({ type: "stream.subagent", state: state([done]) })
  await Bun.sleep(20)
  expect(renderer.footerHeight).toBe(FOOTER_BASE)

  footer.event({ type: "stream.subagent", state: state([tab({ sessionID: "ses_a", status: "running" })]) })
  expect(renderer.footerHeight).toBe(FOOTER_BASE + 2)
})

test("an emptied snapshot forgets prunes so a switched-in session renders its tabs", async () => {
  const { renderer, footer } = await setup()

  footer.event({
    type: "stream.subagent",
    state: state([tab({ sessionID: "ses_a", status: "completed", lastUpdatedAt: Date.now() - 60_000 })]),
  })
  await Bun.sleep(20)
  expect(renderer.footerHeight).toBe(FOOTER_BASE)

  // Session switch resets the reducer, then replay re-seeds the same tab still
  // inside its linger window.
  footer.event({ type: "stream.subagent", state: state([]) })
  footer.event({ type: "stream.subagent", state: state([tab({ sessionID: "ses_a", status: "completed" })]) })
  expect(renderer.footerHeight).toBe(FOOTER_BASE + 2)
})
