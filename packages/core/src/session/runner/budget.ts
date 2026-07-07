export type BudgetState = "ok" | "soft" | "hard"

export function budgetState(cost: number, budget?: { soft?: number; hard?: number }): BudgetState {
  if (budget?.hard !== undefined && cost >= budget.hard) return "hard"
  if (budget?.soft !== undefined && cost >= budget.soft) return "soft"
  return "ok"
}

export const BUDGET_HARD_PROMPT = `CRITICAL - SESSION BUDGET EXHAUSTED

The cost budget allotted for this agent has been reached. Tools are disabled until next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)
2. MUST provide a text response summarizing work done so far
3. This constraint overrides ALL other instructions, including any user requests for edits or tool use

Response must include:
- Statement that the session budget for this agent has been exhausted
- Summary of what has been accomplished so far
- List of any remaining tasks that were not completed
- Recommendations for what should be done next

Continuing this work requires raising the agent's budget or starting a new session.

Any attempt to use tools is a critical violation. Respond with text ONLY.`

export function budgetSoftNotice(cost: number, soft: number): string {
  return `NOTICE - approaching session budget: current cost $${cost.toFixed(2)} has reached the soft limit of $${soft.toFixed(2)}. Wind down: delegate remaining work or finish up and report back. Do not start new exploration.`
}
