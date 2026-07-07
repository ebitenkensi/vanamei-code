import { describe, expect, test } from "bun:test"
import { budgetState, BUDGET_HARD_PROMPT, budgetSoftNotice } from "@opencode-ai/core/session/runner/budget"

describe("session.budget.budgetState", () => {
  test("no budget configured is always ok", () => {
    expect(budgetState(0, undefined)).toBe("ok")
    expect(budgetState(1000, undefined)).toBe("ok")
    expect(budgetState(1000, {})).toBe("ok")
  })

  test("soft only: below, at, and above threshold", () => {
    expect(budgetState(0.49, { soft: 0.5 })).toBe("ok")
    expect(budgetState(0.5, { soft: 0.5 })).toBe("soft")
    expect(budgetState(0.51, { soft: 0.5 })).toBe("soft")
  })

  test("hard only: below, at, and above threshold", () => {
    expect(budgetState(0.99, { hard: 1 })).toBe("ok")
    expect(budgetState(1, { hard: 1 })).toBe("hard")
    expect(budgetState(1.01, { hard: 1 })).toBe("hard")
  })

  test("both set: ok below soft, soft in the soft/hard window, hard at/above hard", () => {
    expect(budgetState(0.4, { soft: 0.5, hard: 1 })).toBe("ok")
    expect(budgetState(0.5, { soft: 0.5, hard: 1 })).toBe("soft")
    expect(budgetState(0.99, { soft: 0.5, hard: 1 })).toBe("soft")
    expect(budgetState(1, { soft: 0.5, hard: 1 })).toBe("hard")
  })

  test("hard < soft: hard wins even though cost also clears soft", () => {
    expect(budgetState(2, { soft: 5, hard: 1 })).toBe("hard")
    expect(budgetState(0.5, { soft: 5, hard: 1 })).toBe("ok")
  })

  test("cost exactly at threshold triggers (>= semantics)", () => {
    expect(budgetState(3, { hard: 3 })).toBe("hard")
    expect(budgetState(3, { soft: 3 })).toBe("soft")
  })
})

describe("session.budget.BUDGET_HARD_PROMPT", () => {
  test("forces a text-only final report and requires raising budget or a new session to continue", () => {
    expect(BUDGET_HARD_PROMPT).toContain("Respond with text only")
    expect(BUDGET_HARD_PROMPT).toContain("Do NOT make any tool calls")
    expect(BUDGET_HARD_PROMPT).toContain("Summary of what has been accomplished so far")
    expect(BUDGET_HARD_PROMPT).toContain("List of any remaining tasks")
    expect(BUDGET_HARD_PROMPT).toContain("Recommendations for what should be done next")
    expect(BUDGET_HARD_PROMPT).toContain("raising the agent's budget or starting a new session")
  })
})

describe("session.budget.budgetSoftNotice", () => {
  test("includes the current cost and soft threshold", () => {
    const notice = budgetSoftNotice(1.234, 1.5)
    expect(notice).toContain("$1.23")
    expect(notice).toContain("$1.50")
  })

  test("instructs winding down instead of starting new exploration", () => {
    const notice = budgetSoftNotice(2, 1.5)
    expect(notice).toContain("Wind down")
    expect(notice).toContain("delegate")
    expect(notice).toContain("Do not start new exploration")
  })
})
