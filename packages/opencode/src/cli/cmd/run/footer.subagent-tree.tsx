/** @jsxImportSource @opentui/solid */
import { For, type Accessor } from "solid-js"
import type { FooterSubagentTab } from "./types"
import type { RunFooterTheme } from "./theme"

export function RunSubagentTree(props: {
  tabs: Accessor<FooterSubagentTab[]>
  theme: () => RunFooterTheme
  mainStatus?: Accessor<string>
}) {
  if (props.tabs().length === 0) return null

  return (
    <box
      width="100%"
      height={props.tabs().length + 1}
      flexShrink={0}
      flexDirection="column"
      backgroundColor="transparent"
      paddingLeft={1}
      paddingRight={1}
    >
      <box width="100%" height={1} flexDirection="row" flexShrink={0} backgroundColor="transparent">
        <text fg={props.theme().muted} wrapMode="none" truncate>
          ┌─ main: {props.mainStatus?.() ?? "working"}
        </text>
      </box>
      <For each={props.tabs()}>
        {(tab, index) => {
          const isLast = index() === props.tabs().length - 1
          const connector = isLast ? "└─ " : "├─ "
          const idle = tab.status === "running" && Date.now() - tab.lastUpdatedAt > 5000
          const dim = tab.status === "completed" || tab.status === "cancelled" || idle
          const glyph =
            tab.status === "running"
              ? idle
                ? "…"
                : "▶"
              : tab.status === "completed"
                ? "✓"
                : tab.status === "cancelled"
                  ? "○"
                  : "✗"
          const glyphColor =
            tab.status === "error"
              ? props.theme().error
              : dim
                ? props.theme().muted
                : props.theme().highlight
          const desc = tab.description || tab.title || ""

          return (
            <box width="100%" height={1} flexDirection="row" gap={0} flexShrink={0} backgroundColor="transparent">
              <text fg={props.theme().muted} wrapMode="none" flexShrink={0}>
                {connector}
              </text>
              <text fg={props.theme().highlight} wrapMode="none" flexShrink={0}>
                @{tab.label}
              </text>
              <text fg={props.theme().muted} wrapMode="none" flexShrink={0}>
                :{" "}
              </text>
              <text wrapMode="none" truncate flexGrow={1}>
                <span
                  style={{
                    fg: dim ? props.theme().muted : props.theme().text,
                    strikethrough: tab.status === "completed",
                  }}
                >
                  {desc}
                </span>
              </text>
              <text fg={glyphColor} wrapMode="none" flexShrink={0}>
                {" "}
                {glyph}
              </text>
            </box>
          )
        }}
      </For>
    </box>
  )
}
