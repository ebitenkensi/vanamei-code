/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import type { CapturedFrame } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { canOpenSessionsMenu, relativeTime, RunSessionSelectBody, sortSessionTabs } from "@/cli/cmd/run/footer.sessions"
import { RUN_THEME_FALLBACK } from "@/cli/cmd/run/theme"
import type { FooterSessionTab } from "@/cli/cmd/run/types"

function session(input: Partial<FooterSessionTab> & { sessionID: string; updated: number }): FooterSessionTab {
  return { title: undefined, ...input }
}

function rowOf(frame: CapturedFrame, text: string): number {
  const row = frame.lines.findIndex((line) => line.spans.some((span) => span.text.includes(text)))
  if (row === -1) {
    throw new Error(`span not found: ${text}`)
  }

  return row
}

describe("sortSessionTabs", () => {
  test("orders newest first", () => {
    const sessions = [
      session({ sessionID: "a", updated: 1 }),
      session({ sessionID: "b", updated: 3 }),
      session({ sessionID: "c", updated: 2 }),
    ]

    expect(sortSessionTabs(sessions, undefined).map((item) => item.sessionID)).toEqual(["b", "c", "a"])
  })

  test("excludes the current session", () => {
    const sessions = [session({ sessionID: "a", updated: 2 }), session({ sessionID: "b", updated: 1 })]

    expect(sortSessionTabs(sessions, "a").map((item) => item.sessionID)).toEqual(["b"])
  })

  test("excludes subagent/child sessions", () => {
    const sessions = [
      session({ sessionID: "a", updated: 2 }),
      session({ sessionID: "child", parentID: "a", updated: 3 }),
    ]

    expect(sortSessionTabs(sessions, undefined).map((item) => item.sessionID)).toEqual(["a"])
  })

  test("does not mutate the input array", () => {
    const sessions = [session({ sessionID: "a", updated: 1 }), session({ sessionID: "b", updated: 2 })]
    const original = [...sessions]

    sortSessionTabs(sessions, undefined)

    expect(sessions).toEqual(original)
  })
})

describe("canOpenSessionsMenu", () => {
  test("allows opening only when idle with nothing queued", () => {
    expect(canOpenSessionsMenu({ phase: "idle", queue: 0 })).toBe(true)
  })

  test("refuses while a turn is running", () => {
    expect(canOpenSessionsMenu({ phase: "running", queue: 0 })).toBe(false)
  })

  test("refuses while prompts are queued behind the active turn", () => {
    expect(canOpenSessionsMenu({ phase: "idle", queue: 1 })).toBe(false)
  })
})

describe("relativeTime", () => {
  test("reports just now for sub-second gaps", () => {
    expect(relativeTime(1_000, 1_500)).toBe("just now")
  })

  test("composes the shared duration formatter with an 'ago' suffix", () => {
    expect(relativeTime(0, 2 * 60_000)).toBe("2m 0s ago")
  })
})

test("resume session panel lists sessions newest first and excludes the current one", async () => {
  const [sessions] = createSignal<FooterSessionTab[]>([
    session({ sessionID: "s-1", title: "Fix the auth bug", updated: 1_000 }),
    session({ sessionID: "s-2", title: "Refactor the parser", updated: 3_000 }),
    session({ sessionID: "s-3", title: "Current session", updated: 2_000 }),
  ])
  const [current] = createSignal<string | undefined>("s-3")

  const app = await testRender(
    () => (
      <box width={100} height={16}>
        <RunSessionSelectBody
          theme={() => RUN_THEME_FALLBACK.footer}
          sessions={sessions}
          current={current}
          onClose={() => {}}
          onSelect={() => {}}
        />
      </box>
    ),
    { width: 100, height: 16 },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("Resume session")
    expect(frame).toContain("Refactor the parser")
    expect(frame).toContain("Fix the auth bug")
    expect(frame).not.toContain("Current session")

    const spans = app.captureSpans()
    expect(rowOf(spans, "Refactor the parser")).toBeLessThan(rowOf(spans, "Fix the auth bug"))
  } finally {
    app.renderer.destroy()
  }
})

test("resume session panel falls back to an untitled label and filters by query", async () => {
  const [sessions] = createSignal<FooterSessionTab[]>([
    session({ sessionID: "s-1", title: "Fix the auth bug", updated: 1_000 }),
    session({ sessionID: "s-2", title: undefined, updated: 2_000 }),
  ])
  const [current] = createSignal<string | undefined>(undefined)

  const app = await testRender(
    () => (
      <box width={100} height={16}>
        <RunSessionSelectBody
          theme={() => RUN_THEME_FALLBACK.footer}
          sessions={sessions}
          current={current}
          onClose={() => {}}
          onSelect={() => {}}
        />
      </box>
    ),
    { width: 100, height: 16 },
  )

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Untitled session")

    "auth".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()

    const frame = app.captureCharFrame()
    expect(frame).toContain("Fix the auth bug")
    expect(frame).not.toContain("Untitled session")
  } finally {
    app.renderer.destroy()
  }
})

test("resume session panel shows a distinct empty state when there is nothing to resume", async () => {
  const [sessions] = createSignal<FooterSessionTab[]>([])
  const [current] = createSignal<string | undefined>(undefined)

  const app = await testRender(
    () => (
      <box width={100} height={16}>
        <RunSessionSelectBody
          theme={() => RUN_THEME_FALLBACK.footer}
          sessions={sessions}
          current={current}
          onClose={() => {}}
          onSelect={() => {}}
        />
      </box>
    ),
    { width: 100, height: 16 },
  )

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("No other sessions")
  } finally {
    app.renderer.destroy()
  }
})
