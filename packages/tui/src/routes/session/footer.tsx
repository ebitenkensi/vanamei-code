import { createMemo, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../../context/theme"
import { useSync } from "../../context/sync"
import { useDirectory } from "../../context/directory"
import { useConnected } from "../../component/use-connected"
import { createStore } from "solid-js/store"
import { useRoute } from "../../context/route"
import { Locale } from "../../util/locale"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

export function Footer() {
  const { theme } = useTheme()
  const sync = useSync()
  const route = useRoute()
  const mcp = createMemo(() => Object.values(sync.data.mcp).filter((x) => x.status === "connected").length)
  const mcpError = createMemo(() => Object.values(sync.data.mcp).some((x) => x.status === "failed"))
  const lsp = createMemo(() => Object.keys(sync.data.lsp))
  const permissions = createMemo(() => {
    if (route.data.type !== "session") return []
    return sync.data.permission[route.data.sessionID] ?? []
  })
  const directory = useDirectory()
  const connected = useConnected()
  const dimensions = useTerminalDimensions()

  const sessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  const session = createMemo(() => (sessionID() ? sync.session.get(sessionID()!) : undefined))
  const messages = createMemo(() => (sessionID() ? sync.data.message[sessionID()!] ?? [] : []))
  const todos = createMemo(() => (sessionID() ? sync.data.todo[sessionID()!] ?? [] : []))
  const diffs = createMemo(() => (sessionID() ? sync.data.session_diff[sessionID()!] ?? [] : []))

  const sidebarHidden = createMemo(() => dimensions().width <= 120)

  const contextUsage = createMemo(() => {
    const last = messages().findLast((x): x is AssistantMessage => x.role === "assistant" && x.tokens.output > 0)
    if (!last) return null
    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  const contextColor = createMemo(() => {
    const percent = contextUsage()?.percent
    if (percent === null || percent === undefined) return theme.textMuted
    if (percent >= 95) return theme.error
    if (percent >= 80) return theme.warning
    return theme.primary
  })

  const sessionTitle = createMemo(() => Locale.truncate(session()?.title ?? "", 20))
  const cost = createMemo(() => session()?.cost ?? 0)
  const todoCount = createMemo(() => todos().filter((item) => item.status !== "completed").length)
  const diffCount = createMemo(() => diffs().length)

  const infoPills = createMemo(() => {
    if (!sidebarHidden()) return []
    const pills: Array<{ text: string; color: RGBA }> = []
    if (sessionTitle()) pills.push({ text: sessionTitle(), color: theme.text })
    if (contextUsage()?.percent !== null && contextUsage()?.percent !== undefined) {
      pills.push({ text: `◆ ${contextUsage()!.percent}%`, color: contextColor() })
    }
    if (cost() > 0) pills.push({ text: money.format(cost()), color: theme.textMuted })
    if (todoCount() > 0) pills.push({ text: `☐ ${todoCount()}`, color: theme.warning })
    if (diffCount() > 0) pills.push({ text: `✎ ${diffCount()}`, color: theme.success })
    return pills
  })

  const [store, setStore] = createStore({
    welcome: false,
  })

  onMount(() => {
    // Track all timeouts to ensure proper cleanup
    const timeouts: ReturnType<typeof setTimeout>[] = []

    function tick() {
      if (connected()) return
      if (!store.welcome) {
        setStore("welcome", true)
        timeouts.push(setTimeout(() => tick(), 5000))
        return
      }

      if (store.welcome) {
        setStore("welcome", false)
        timeouts.push(setTimeout(() => tick(), 10_000))
        return
      }
    }
    timeouts.push(setTimeout(() => tick(), 10_000))

    onCleanup(() => {
      timeouts.forEach(clearTimeout)
    })
  })

  return (
    <box flexDirection="row" justifyContent="space-between" gap={1} flexShrink={0}>
      <text fg={theme.textMuted}>{directory()}</text>
      <box gap={2} flexDirection="row" flexShrink={0}>
        <Switch>
          <Match when={store.welcome}>
            <text fg={theme.text}>
              Get started <span style={{ fg: theme.textMuted }}>/connect</span>
            </text>
          </Match>
          <Match when={connected()}>
            <Show when={infoPills().length > 0}>
              <text wrapMode="none">
                <For each={infoPills()}>
                  {(pill, index) => (
                    <>
                      <Show when={index() > 0}>
                        <span style={{ fg: theme.textMuted }}> · </span>
                      </Show>
                      <span style={{ fg: pill.color }}>{pill.text}</span>
                    </>
                  )}
                </For>
              </text>
            </Show>
            <Show when={permissions().length > 0}>
              <text fg={theme.warning}>
                <span style={{ fg: theme.warning }}>△</span> {permissions().length} Permission
                {permissions().length > 1 ? "s" : ""}
              </text>
            </Show>
            <text fg={theme.text}>
              <span style={{ fg: lsp().length > 0 ? theme.success : theme.textMuted }}>•</span> {lsp().length} LSP
            </text>
            <Show when={mcp()}>
              <text fg={theme.text}>
                <Switch>
                  <Match when={mcpError()}>
                    <span style={{ fg: theme.error }}>⊙ </span>
                  </Match>
                  <Match when={true}>
                    <span style={{ fg: theme.success }}>⊙ </span>
                  </Match>
                </Switch>
                {mcp()} MCP
              </text>
            </Show>
            <text fg={theme.textMuted}>/status</text>
          </Match>
        </Switch>
      </box>
    </box>
  )
}
