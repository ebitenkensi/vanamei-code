// Sessions (resume) panel -- lists the project's other sessions, newest
// first, and lets the user switch into one. Mirrors the list-panel-with-
// filter-field shape of RunSubagentSelectBody / RunModelSelectBody in
// footer.command.tsx, reusing their shared chrome so it looks and behaves
// like every other footer command-menu panel.
/** @jsxImportSource @opentui/solid */
import type { InputRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createMemo, createSignal, type Accessor } from "solid-js"
import * as Locale from "@/util/locale"
import {
  handleKey,
  match,
  PanelShell,
  PANEL_FRAME_ROWS,
  PANEL_LIST_ROWS,
  PANEL_PAD,
  type PanelEntry,
} from "./footer.command"
import { RunFooterMenu, createFooterMenuState } from "./footer.menu"
import type { RunFooterTheme } from "./theme"
import type { FooterPhase, FooterSessionTab } from "./types"

export const RUN_SESSIONS_PANEL_ROWS = PANEL_LIST_ROWS + PANEL_FRAME_ROWS

const UNTITLED_SESSION = "Untitled session"

type SessionEntry = PanelEntry & {
  sessionID: string
}

// Newest-first, excluding subagent/child sessions (parentID set) and the
// session currently open in the footer.
export function sortSessionTabs(sessions: FooterSessionTab[], current: string | undefined): FooterSessionTab[] {
  return sessions
    .filter((item) => !item.parentID && item.sessionID !== current)
    .slice()
    .sort((a, b) => b.updated - a.updated)
}

// Session switching is only offered between turns: a running assistant turn
// or anything still queued behind it must finish (or be interrupted) first.
export function canOpenSessionsMenu(state: { phase: FooterPhase; queue: number }): boolean {
  return state.phase === "idle" && state.queue === 0
}

export function sessionTitle(session: Pick<FooterSessionTab, "title">): string {
  return session.title?.trim() || UNTITLED_SESSION
}

// Composes the existing duration formatter ("2h 30m") into a relative label.
// `now` is a parameter (rather than reading Date.now() internally) so the
// formatting itself stays a pure, deterministic function to test.
export function relativeTime(updated: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - updated)
  if (diff < 1000) {
    return "just now"
  }

  return `${Locale.duration(diff)} ago`
}

export function RunSessionSelectBody(props: {
  theme: Accessor<RunFooterTheme>
  sessions: Accessor<FooterSessionTab[]>
  current: Accessor<string | undefined>
  onClose: () => void
  onSelect: (sessionID: string, title: string | undefined) => void
}) {
  let field: InputRenderable | undefined
  const [query, setQuery] = createSignal("")
  const sorted = createMemo(() => sortSessionTabs(props.sessions(), props.current()))
  const entries = createMemo<SessionEntry[]>(() =>
    sorted().map((session) => ({
      category: "",
      display: sessionTitle(session),
      footer: relativeTime(session.updated),
      keywords: sessionTitle(session),
      sessionID: session.sessionID,
    })),
  )
  const items = createMemo<SessionEntry[]>(() => match(query(), entries()))
  const menu = createFooterMenuState({ count: () => items().length, limit: PANEL_LIST_ROWS })
  const select = () => {
    const item = items()[menu.selected()]
    if (!item) {
      return
    }

    const session = sorted().find((entry) => entry.sessionID === item.sessionID)
    props.onSelect(item.sessionID, session?.title)
  }

  createEffect(() => {
    query()
    menu.reset()
  })

  useKeyboard((event) => {
    if (event.defaultPrevented) {
      return
    }

    handleKey({ event, menu, field: () => field, setQuery, select, close: props.onClose })
  })

  return (
    <PanelShell
      title="Resume session"
      query={query()}
      count={items().length}
      total={entries().length}
      placeholder="Search"
      theme={props.theme}
      inputRef={(input) => {
        field = input
      }}
      onQuery={setQuery}
      dark
      chrome="minimal"
    >
      <RunFooterMenu
        theme={props.theme}
        items={items}
        selected={menu.selected}
        offset={menu.offset}
        rows={() => PANEL_LIST_ROWS}
        limit={PANEL_LIST_ROWS}
        empty={props.sessions().length > 0 ? "No results found" : "No other sessions"}
        border={false}
        paddingLeft={PANEL_PAD}
        paddingRight={PANEL_PAD}
        grouped={false}
        background
      />
    </PanelShell>
  )
}
