import { describe, expect, test } from "bun:test"
import {
  fitStatusline,
  footerWidthPolicy,
  statuslineGap,
  statuslineWidth,
  type StatuslineSegment,
} from "@/cli/cmd/run/footer.width"

function segment(key: string, text: string, group: StatuslineSegment["group"], priority: number): StatuslineSegment {
  return { key, text, group, priority }
}

const SEGMENTS = [
  segment("ctx", "◆78%", "metrics", 8),
  segment("cost", "$1.52/1.50", "metrics", 7),
  segment("modified", "✎7", "metrics", 1),
  segment("model", "GPT-5 xhigh", "model", 5),
  segment("background", "^b background", "background", 6),
  segment("command", "^p", "command", 9),
]

describe("run footer width", () => {
  test("keeps the shared narrow-dialog breakpoint", () => {
    expect(footerWidthPolicy(79).dialog.narrow).toBe(true)
    expect(footerWidthPolicy(80).dialog.narrow).toBe(false)
  })

  test("separates groups by two columns and items within a group by one", () => {
    expect(statuslineGap(undefined, SEGMENTS[0]!)).toBe("")
    expect(statuslineGap(SEGMENTS[0], SEGMENTS[1]!)).toBe(" ")
    expect(statuslineGap(SEGMENTS[1], SEGMENTS[3]!)).toBe("  ")
  })

  test("measures the composed zone including its gaps", () => {
    // "◆78% $1.52/1.50 ✎7  GPT-5 xhigh  ^b background  ^p"
    expect(statuslineWidth(SEGMENTS)).toBe(50)
    expect(statuslineWidth([])).toBe(0)
    expect(statuslineWidth([SEGMENTS[0]!])).toBe(4)
  })

  test("drops whole segments by priority instead of truncating one mid-token", () => {
    const keys = (available: number) => fitStatusline(SEGMENTS, available).map((item) => item.key)

    expect(keys(50)).toEqual(["ctx", "cost", "modified", "model", "background", "command"])
    // Losing a single column sheds the lowest-priority segment whole.
    expect(keys(49)).toEqual(["ctx", "cost", "model", "background", "command"])
    expect(keys(46)).toEqual(["ctx", "cost", "background", "command"])
    expect(keys(33)).toEqual(["ctx", "cost", "command"])
    expect(keys(18)).toEqual(["ctx", "command"])
    expect(keys(7)).toEqual(["command"])
    expect(keys(1)).toEqual([])
  })

  test("every fitted result stays within the columns it was given", () => {
    for (let available = 0; available <= 55; available++) {
      expect(statuslineWidth(fitStatusline(SEGMENTS, available))).toBeLessThanOrEqual(available)
    }
  })
})
