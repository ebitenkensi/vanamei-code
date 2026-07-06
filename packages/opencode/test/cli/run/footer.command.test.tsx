import { describe, expect, test } from "bun:test"
import { primaryAgents } from "@/cli/cmd/run/footer.command"
import type { RunAgent } from "@/cli/cmd/run/types"

function agent(input: { name: string; mode: RunAgent["mode"]; description?: string }): RunAgent {
  return {
    name: input.name,
    description: input.description,
    mode: input.mode,
    permission: [],
    options: {},
  } satisfies RunAgent
}

describe("primaryAgents", () => {
  test("keeps primary and all-mode agents", () => {
    const agents = [
      agent({ name: "build", mode: "primary" }),
      agent({ name: "plan", mode: "primary" }),
      agent({ name: "general", mode: "all" }),
    ]

    expect(primaryAgents(agents).map((item) => item.name)).toEqual(["build", "plan", "general"])
  })

  test("excludes subagent-only agents", () => {
    const agents = [agent({ name: "build", mode: "primary" }), agent({ name: "explore", mode: "subagent" })]

    expect(primaryAgents(agents).map((item) => item.name)).toEqual(["build"])
  })

  test("does not mutate the input array", () => {
    const agents = [agent({ name: "build", mode: "primary" }), agent({ name: "explore", mode: "subagent" })]
    const original = [...agents]

    primaryAgents(agents)

    expect(agents).toEqual(original)
  })
})
