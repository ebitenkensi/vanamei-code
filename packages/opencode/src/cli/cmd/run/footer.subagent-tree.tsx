/** @jsxImportSource @opentui/solid */
import { createMemo, For, Show, type Accessor } from "solid-js"
import { SPINNER_BRAILLE_FRAMES } from "@/cli/ui/component/spinner"
import * as Locale from "@/util/locale"
import { statusColor } from "./footer.subagent"
import type { FooterSubagentTab } from "./types"
import type { RunFooterTheme } from "./theme"

// Rows the subagent tree takes within a `cap`: 2 per tab (header + elbow),
// plus one for "… +N more" when the cap cuts the list short. Mirrors
// todoPanelRowCount() in footer.view.tsx so RunFooter.applyHeight() reserves
// exactly what RunSubagentTree renders.
export function subagentTreeRowCount(tabs: number, cap: number): number {
  if (tabs * 2 <= cap) {
    return tabs * 2
  }

  const visible = subagentTreeVisible(tabs, cap)
  // A lone "… +N more" with no task above it says nothing the ▶N counter on
  // the statusline does not already say, so the tree takes three rows or none.
  return visible === 0 ? 0 : visible * 2 + 1
}

// Inverse of the above: tabs to draw once the tree knows its rows.
export function subagentTreeVisible(total: number, rows: number): number {
  return rows >= total * 2 ? total : Math.max(0, Math.floor((rows - 1) / 2))
}

function elbowLabel(tab: FooterSubagentTab): string {
  if (tab.status === "completed") {
    return "Done"
  }

  if (tab.status === "cancelled") {
    return "Cancelled"
  }

  return "Error"
}

// Non-running header glyph. Running tabs show the animated braille spinner
// instead (see the header row below) -- one spinner per tab, not two.
function headerGlyph(tab: FooterSubagentTab): string {
  if (tab.status === "completed") {
    return "✓"
  }

  if (tab.status === "cancelled") {
    return "○"
  }

  return "✗"
}

export function RunSubagentTree(props: {
  tabs: Accessor<FooterSubagentTab[]>
  theme: () => RunFooterTheme
  rows: Accessor<number>
}) {
  if (props.tabs().length === 0) return null

  // Derive height from tab count only, not the full array reference, so that
  // cost/activity updates that don't change the tab count do NOT re-evaluate
  // the outer box height (which would reflow the composer sibling above).
  const visible = createMemo(() => subagentTreeVisible(props.tabs().length, props.rows()))
  const hidden = createMemo(() => props.tabs().length - visible())

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
      <For each={props.tabs().slice(0, visible())}>
        {(tab) => (
          <box width="100%" flexDirection="column" gap={0} flexShrink={0} backgroundColor="transparent">
            <box width="100%" height={1} flexDirection="row" gap={1} flexShrink={0} backgroundColor="transparent">
              {tab.status === "running" ? (
                <box flexShrink={0}>
                  <spinner
                    frames={SPINNER_BRAILLE_FRAMES}
                    interval={80}
                    color={statusColor(props.theme(), tab.status)}
                  />
                </box>
              ) : (
                <text fg={statusColor(props.theme(), tab.status)} wrapMode="none" flexShrink={0}>
                  {headerGlyph(tab)}
                </text>
              )}
              <text fg={props.theme().text} wrapMode="none" truncate flexGrow={1}>
                {`Task(${tab.description})`}
                <span style={{ fg: props.theme().muted }}>{` ${tab.label}`}</span>
                <Show when={(tab.cost ?? 0) > 0}>
                  <span style={{ fg: props.theme().muted }}>{` ${Locale.money(tab.cost!)}`}</span>
                </Show>
              </text>
            </box>
            <box width="100%" height={1} flexDirection="row" gap={0} flexShrink={0} backgroundColor="transparent">
              <text fg={props.theme().muted} wrapMode="none" flexShrink={0}>
                {"  ⎿  "}
              </text>
              <text fg={tab.status === "error" ? props.theme().error : props.theme().muted} wrapMode="none" truncate>
                {tab.status === "running" ? (tab.activity ?? "Running…") : elbowLabel(tab)}
              </text>
            </box>
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
    </box>
  )
}
