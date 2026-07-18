/** @jsxImportSource @opentui/solid */
import { createMemo, For, Show, type Accessor } from "solid-js"
import { SPINNER_BRAILLE_FRAMES } from "@/cli/ui/component/spinner"
import * as Locale from "@/util/locale"
import { statusColor } from "./footer.subagent"
import type { FooterSubagentTab } from "./types"
import type { RunFooterTheme } from "./theme"

// Rows the subagent tree needs: 2 per tab (header + elbow), mirroring
// todoPanelRowCount() in footer.view.tsx so RunFooter.applyHeight() reserves
// exactly what RunSubagentTree renders.
export function subagentTreeRowCount(tabs: FooterSubagentTab[]): number {
  return tabs.length * 2
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

export function RunSubagentTree(props: { tabs: Accessor<FooterSubagentTab[]>; theme: () => RunFooterTheme }) {
  if (props.tabs().length === 0) return null

  // Derive height from tab count only, not the full array reference, so that
  // cost/activity updates that don't change the tab count do NOT re-evaluate
  // the outer box height (which would reflow the composer sibling above).
  const rowCount = createMemo(() => subagentTreeRowCount(props.tabs()))

  return (
    <box
      width="100%"
      height={rowCount()}
      flexShrink={0}
      flexDirection="column"
      backgroundColor="transparent"
      paddingLeft={1}
      paddingRight={1}
    >
      <For each={props.tabs()}>
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
    </box>
  )
}
