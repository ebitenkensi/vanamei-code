import { describe, expect, test } from "bun:test"
import { footerWidthPolicy } from "@/cli/cmd/run/footer.width"

describe("run footer width", () => {
  test("preserves shared dialog and statusline breakpoints", () => {
    const narrow = footerWidthPolicy(79)
    expect(narrow.dialog.narrow).toBe(true)
    expect(narrow.statusline.showPills).toBe(false)
    expect(narrow.statusline.showCommandHint).toBe(true)
    expect(narrow.statusline.showContextHints).toBe(false)
    expect(narrow.statusline.contextHintLimit).toBe(0)
    expect(narrow.statusline.showModel).toBe(false)

    const command = footerWidthPolicy(65)
    expect(command.statusline.showCommandHint).toBe(false)

    const commandHint = footerWidthPolicy(66)
    expect(commandHint.statusline.showCommandHint).toBe(true)

    const compact = footerWidthPolicy(80)
    expect(compact.dialog.narrow).toBe(false)
    expect(compact.statusline.showPills).toBe(true)
    expect(compact.statusline.showContextHints).toBe(true)
    expect(compact.statusline.contextHintLimit).toBe(1)
    expect(compact.statusline.showModel).toBe(false)

    const model = footerWidthPolicy(120)
    expect(model.statusline.contextHintLimit).toBe(2)
    expect(model.statusline.showModel).toBe(true)

    const spacious = footerWidthPolicy(150)
    expect(spacious.statusline.contextHintLimit).toBeUndefined()
    expect(spacious.statusline.showModel).toBe(true)
  })

  test("drops info pills by priority (modified -> todos -> cost) as width shrinks", () => {
    const wide = footerWidthPolicy(120)
    expect(wide.statusline.pills.cost).toBe(true)
    expect(wide.statusline.pills.todos).toBe(true)
    expect(wide.statusline.pills.modified).toBe(true)

    const noModified = footerWidthPolicy(119)
    expect(noModified.statusline.pills.cost).toBe(true)
    expect(noModified.statusline.pills.todos).toBe(true)
    expect(noModified.statusline.pills.modified).toBe(false)

    const noTodos = footerWidthPolicy(104)
    expect(noTodos.statusline.pills.cost).toBe(true)
    expect(noTodos.statusline.pills.todos).toBe(false)
    expect(noTodos.statusline.pills.modified).toBe(false)

    const noCost = footerWidthPolicy(89)
    expect(noCost.statusline.pills.cost).toBe(false)
    expect(noCost.statusline.pills.todos).toBe(false)
    expect(noCost.statusline.pills.modified).toBe(false)
    // ctx% still shows -- the whole row is gated only by `showPills`.
    expect(noCost.statusline.showPills).toBe(true)

    const hidden = footerWidthPolicy(79)
    expect(hidden.statusline.showPills).toBe(false)
  })

  test("shows the full context form once spacious", () => {
    expect(footerWidthPolicy(149).statusline.pills.ctxFull).toBe(false)
    expect(footerWidthPolicy(150).statusline.pills.ctxFull).toBe(true)
  })
})
