import { describe, expect, test } from "bun:test"
import {
  MAX_TODO_ROWS,
  footerPanelBudget,
  footerPanelRows,
  thinkingTailRows,
  todoPanelRowCount,
  todoPanelVisible,
} from "@/cli/cmd/run/footer.view"
import { subagentTreeRowCount, subagentTreeVisible } from "@/cli/cmd/run/footer.subagent-tree"

describe("footer panel budget", () => {
  test("scales with the terminal but never drops below four rows", () => {
    expect(footerPanelBudget(50)).toBe(25)
    expect(footerPanelBudget(24)).toBe(12)
    expect(footerPanelBudget(8)).toBe(4)
    expect(footerPanelBudget(2)).toBe(4)
  })

  test("spends the budget on live work first and the thinking tail last", () => {
    // 2 tabs (4 rows) + 8 todos (7 rows) + an 11-row thinking panel want 22.
    const wide = footerPanelRows({ budget: 25, thinking: 11, todos: 8, todoSummary: false, tabs: 2 })
    expect(wide).toEqual({ tree: 4, todos: 7, thinking: 11 })

    const tight = footerPanelRows({ budget: 12, thinking: 11, todos: 8, todoSummary: false, tabs: 2 })
    expect(tight).toEqual({ tree: 4, todos: 7, thinking: 0 })

    const tighter = footerPanelRows({ budget: 6, thinking: 11, todos: 8, todoSummary: false, tabs: 2 })
    expect(tighter).toEqual({ tree: 3, todos: 3, thinking: 0 })

    // A fleet of subagents truncates at half the budget rather than starving
    // the plan and the reasoning both.
    expect(footerPanelRows({ budget: 12, thinking: 11, todos: 8, todoSummary: false, tabs: 9 })).toEqual({
      tree: 5,
      todos: 7,
      thinking: 0,
    })
  })

  test("never leaves a thinking header with no tail under it", () => {
    expect(footerPanelRows({ budget: 5, thinking: 11, todos: 2, todoSummary: false, tabs: 1 }).thinking).toBe(0)
    expect(footerPanelRows({ budget: 6, thinking: 11, todos: 2, todoSummary: false, tabs: 1 }).thinking).toBe(2)
  })

  test("allots exactly what each panel then draws, within budget", () => {
    for (const budget of [4, 5, 6, 9, 12, 25]) {
      for (const tabs of [0, 1, 2, 5, 9]) {
        for (const todos of [0, 1, 3, 8, 20]) {
          for (const thinking of [0, 2, 6, 11]) {
            const rows = footerPanelRows({ budget, thinking, todos, todoSummary: false, tabs })
            expect(rows.tree + rows.todos + rows.thinking).toBeLessThanOrEqual(budget)

            // Each panel draws its items plus a "… +N more" row when it hides
            // any. A zero allotment means the panel is not mounted at all.
            const treeShown = subagentTreeVisible(tabs, rows.tree)
            expect(rows.tree === 0 ? 0 : treeShown * 2 + (treeShown < tabs ? 1 : 0)).toBe(rows.tree)

            const todosShown = todoPanelVisible(todos, rows.todos)
            expect(rows.todos === 0 ? 0 : todosShown + (todosShown < todos ? 1 : 0)).toBe(rows.todos)

            // The thinking panel is a header plus one row per tail line.
            const tail = thinkingTailRows("x\n".repeat(thinking), 80, rows.thinking - 1)
            expect(tail.length === 0 ? 0 : tail.length + 1).toBe(rows.thinking)
          }
        }
      }
    }
  })
})

describe("footer panel row counts", () => {
  test("todo rows keep one row for the overflow line", () => {
    expect(todoPanelRowCount(0, false, 10)).toBe(0)
    expect(todoPanelRowCount(3, false, 10)).toBe(3)
    expect(todoPanelRowCount(MAX_TODO_ROWS + 2, false, 10)).toBe(MAX_TODO_ROWS + 1)
    expect(todoPanelRowCount(3, false, 1)).toBe(0)
    expect(todoPanelRowCount(1, false, 1)).toBe(1)
    expect(todoPanelRowCount(3, true, 10)).toBe(1)
    expect(todoPanelRowCount(3, true, 0)).toBe(0)
  })

  test("tree rows are two per tab until the cap forces an overflow line", () => {
    expect(subagentTreeRowCount(0, 10)).toBe(0)
    expect(subagentTreeRowCount(3, 10)).toBe(6)
    expect(subagentTreeRowCount(3, 5)).toBe(5)
    expect(subagentTreeRowCount(3, 4)).toBe(3)
    // Too tight for even one task: the tree steps aside entirely rather than
    // leaving a bare overflow line.
    expect(subagentTreeRowCount(3, 2)).toBe(0)
    expect(subagentTreeRowCount(3, 1)).toBe(0)
  })

  test("a zero-row thinking budget yields no tail at all", () => {
    expect(thinkingTailRows("a\nb\nc", 80, 0)).toEqual([])
    expect(thinkingTailRows("a\nb\nc", 80, 2)).toEqual(["  ⎿  b", "     c"])
  })
})
