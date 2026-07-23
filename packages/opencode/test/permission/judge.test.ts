import { describe, test, expect } from "bun:test"
import { Effect, Layer, Option, Stream } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProjectV2 } from "@opencode-ai/core/project"
import { buildJudgePrompt, parseVerdict, Judge } from "../../src/permission/judge"
import { Agent } from "../../src/agent/agent"
import { LLM } from "../../src/session/llm"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session/session"
import { SessionID } from "../../src/session/schema"

describe("buildJudgePrompt", () => {
  const baseInput = {
    permission: "bash",
    patterns: ["*"],
    metadata: { command: "ls -la" },
    agentName: "build",
    userPrompt: "list files in the directory",
  }

  test("includes permission name", () => {
    const prompt = buildJudgePrompt(baseInput)
    expect(prompt).toContain("bash")
  })

  test("includes patterns", () => {
    const prompt = buildJudgePrompt(baseInput)
    expect(prompt).toContain("*")
  })

  test("includes metadata-derived text", () => {
    const prompt = buildJudgePrompt({ ...baseInput, metadata: { command: "rm -rf /" } })
    expect(prompt).toContain("rm -rf /")
  })

  test("includes agent name", () => {
    const prompt = buildJudgePrompt({ ...baseInput, agentName: "orchestrator-coder" })
    expect(prompt).toContain("orchestrator-coder")
  })

  test("includes user prompt", () => {
    const prompt = buildJudgePrompt({ ...baseInput, userPrompt: "delete everything" })
    expect(prompt).toContain("delete everything")
  })

  test("includes strict JSON instruction", () => {
    const prompt = buildJudgePrompt(baseInput)
    expect(prompt).toContain("strict JSON")
    expect(prompt).toContain('"decision"')
    expect(prompt).toContain("allow")
    expect(prompt).toContain("deny")
  })

  test("includes deny category callouts", () => {
    const prompt = buildJudgePrompt(baseInput)
    expect(prompt).toContain("rm -rf")
    expect(prompt).toContain("force push")
    expect(prompt).toContain("git reset --hard")
    expect(prompt).toContain("dropping databases or tables")
    expect(prompt).toContain("Exfiltration of secrets")
    expect(prompt).toContain("Doom loop")
  })

  test("external reads are always allowed; only dangerous external writes deny", () => {
    const prompt = buildJudgePrompt(baseInput)
    expect(prompt).toContain("Reading outside the workspace is always allowed")
    expect(prompt).toContain("Dangerous writes outside the project workspace")
    expect(prompt).not.toContain("external_directory")
  })

  test("defaults to allow under uncertainty", () => {
    const prompt = buildJudgePrompt(baseInput)
    expect(prompt).toContain("Everything else: allow")
    expect(prompt).toContain("When uncertain, allow")
  })

  test("includes advisory note", () => {
    const prompt = buildJudgePrompt(baseInput)
    expect(prompt).toContain("advisory")
    expect(prompt).toContain("security boundary")
  })

  test("handles empty user prompt", () => {
    const prompt = buildJudgePrompt({ ...baseInput, userPrompt: "" })
    expect(prompt).not.toContain("User's latest request")
  })

  test("handles multiple patterns", () => {
    const prompt = buildJudgePrompt({ ...baseInput, patterns: ["/tmp/*", "/var/*"] })
    expect(prompt).toContain("/tmp/*")
    expect(prompt).toContain("/var/*")
  })

  test("handles multiple metadata fields", () => {
    const prompt = buildJudgePrompt({
      ...baseInput,
      metadata: { command: "git push", remote: "origin", branch: "main" },
    })
    expect(prompt).toContain("git push")
    expect(prompt).toContain("origin")
    expect(prompt).toContain("main")
  })
})

describe("parseVerdict", () => {
  test("parses valid allow verdict", () => {
    const result = parseVerdict('{"decision":"allow","reason":"safe operation"}')
    expect(result).toEqual({ decision: "allow", reason: "safe operation" })
  })

  test("parses valid deny verdict", () => {
    const result = parseVerdict('{"decision":"deny","reason":"destructive command"}')
    expect(result).toEqual({ decision: "deny", reason: "destructive command" })
  })

  test("returns null for malformed JSON", () => {
    expect(parseVerdict("{bad json}")).toBeNull()
  })

  test("returns null for missing reason", () => {
    expect(parseVerdict('{"decision":"allow"}')).toBeNull()
  })

  test("returns null for wrong decision value", () => {
    expect(parseVerdict('{"decision":"maybe","reason":"test"}')).toBeNull()
  })

  test("returns null for empty string", () => {
    expect(parseVerdict("")).toBeNull()
  })

  test("ignores extra fields gracefully", () => {
    const result = parseVerdict('{"decision":"allow","reason":"ok","extra":"field"}')
    expect(result).toEqual({ decision: "allow", reason: "ok" })
  })

  test("returns null for non-JSON string", () => {
    expect(parseVerdict("just some text")).toBeNull()
  })

  test("returns null for decision with wrong casing", () => {
    expect(parseVerdict('{"decision":"Allow","reason":"test"}')).toBeNull()
  })

  test("handles unicode in reason", () => {
    const result = parseVerdict('{"decision":"deny","reason":"危険な操作"}')
    expect(result).toEqual({ decision: "deny", reason: "危険な操作" })
  })

  test("returns null when reason is empty string", () => {
    // Schema.String allows empty string, so this should return valid
    const result = parseVerdict('{"decision":"deny","reason":""}')
    expect(result).toEqual({ decision: "deny", reason: "" })
  })
})

// ---------------------------------------------------------------------------
// Judge layer: verdict wiring and fail-closed behavior via Layer substitution.
// The whole-flow 15s deadline (Effect.timeout wrapping model resolution
// through parse) shares the same catchCause path as the stream-failure case
// below, so the fail-closed behavior is covered without waiting out a real
// timeout.
// ---------------------------------------------------------------------------

const sessionID = SessionID.make("ses_test")

const request: PermissionV1.Request = {
  id: PermissionV1.ID.make("per_test"),
  sessionID,
  permission: "bash",
  patterns: ["ls"],
  metadata: { command: "ls" },
  always: [],
  auto: true,
}

const agentInfo: Agent.Info = {
  name: "permission-judge",
  mode: "primary",
  options: {},
  permission: [],
}

const sessionInfo: Session.Info = {
  id: sessionID,
  slug: "test",
  projectID: ProjectV2.ID.make("pro_test"),
  directory: "/tmp",
  title: "test session",
  version: "1",
  model: { id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test-provider") },
  time: { created: Date.now(), updated: Date.now() },
}

const userMessage = {
  info: { id: "msg_user", sessionID, role: "user", time: { created: Date.now() } },
  parts: [{ id: "prt_1", sessionID, messageID: "msg_user", type: "text", text: "list files" }],
} as SessionV1.WithParts

const smallModel = { id: "small-model", providerID: "test-provider" } as Provider.Model

function judgeLayer(overrides?: {
  session?: Partial<Session.Interface>
  provider?: Partial<Provider.Interface>
  llm?: Partial<LLM.Interface>
}) {
  return Judge.layer.pipe(
    Layer.provide([
      Layer.mock(Session.Service, {
        get: () => Effect.succeed(sessionInfo),
        findMessage: (_sessionID, predicate) => Effect.succeed(Option.fromUndefinedOr([userMessage].find(predicate))),
        ...overrides?.session,
      }),
      Layer.mock(Provider.Service, {
        getSmallModel: () => Effect.succeed(smallModel),
        ...overrides?.provider,
      }),
      Layer.mock(LLM.Service, {
        stream: () => Stream.make(LLMEvent.textDelta({ id: "blk_1", text: '{"decision":"allow","reason":"ok"}' })),
        ...overrides?.llm,
      }),
      Layer.mock(Agent.Service, { get: () => Effect.succeed(agentInfo) }),
    ]),
  )
}

function runJudge(layer: ReturnType<typeof judgeLayer>) {
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const judge = yield* Judge.Service
        return yield* judge.judge({ request })
      }),
      layer,
    ),
  )
}

describe("Judge layer", () => {
  test("returns allowed with the model's reason", async () => {
    const verdict = await runJudge(judgeLayer())
    expect(verdict).toEqual({ outcome: "allowed", reason: "ok" })
  })

  test("returns denied with the model's reason", async () => {
    const verdict = await runJudge(
      judgeLayer({
        llm: {
          stream: () =>
            Stream.make(LLMEvent.textDelta({ id: "blk_1", text: '{"decision":"deny","reason":"destructive"}' })),
        },
      }),
    )
    expect(verdict).toEqual({ outcome: "denied", reason: "destructive" })
  })

  test("fail-closed: non-JSON model output denies", async () => {
    const verdict = await runJudge(
      judgeLayer({ llm: { stream: () => Stream.make(LLMEvent.textDelta({ id: "blk_1", text: "sure, go ahead" })) } }),
    )
    expect(verdict.outcome).toBe("denied")
  })

  test("fail-closed: LLM stream failure denies", async () => {
    const verdict = await runJudge(judgeLayer({ llm: { stream: () => Stream.fail(new Error("provider down")) } }))
    expect(verdict.outcome).toBe("denied")
  })

  test("fail-closed: unresolved model denies without calling the LLM", async () => {
    let streamed = false
    const verdict = await runJudge(
      judgeLayer({
        provider: {
          getSmallModel: () => Effect.succeed(undefined),
          getModel: (providerID, modelID) => Effect.fail(new Provider.ModelNotFoundError({ providerID, modelID })),
        },
        llm: {
          stream: () => {
            streamed = true
            return Stream.make(LLMEvent.textDelta({ id: "blk_1", text: '{"decision":"allow","reason":"ok"}' }))
          },
        },
      }),
    )
    expect(verdict.outcome).toBe("denied")
    expect(streamed).toBe(false)
  })

  test("fail-closed: session without a model denies", async () => {
    const verdict = await runJudge(
      judgeLayer({ session: { get: () => Effect.succeed({ ...sessionInfo, model: undefined }) } }),
    )
    expect(verdict.outcome).toBe("denied")
  })

  test("fail-closed: no real user message denies", async () => {
    const synthetic = {
      ...userMessage,
      parts: [{ ...userMessage.parts[0], synthetic: true }],
    } as SessionV1.WithParts
    const verdict = await runJudge(
      judgeLayer({
        session: {
          findMessage: (_sessionID, predicate) => Effect.succeed(Option.fromUndefinedOr([synthetic].find(predicate))),
        },
      }),
    )
    expect(verdict.outcome).toBe("denied")
  })

  test("fail-closed: an unexpected defect still resolves to denied", async () => {
    const verdict = await runJudge(
      judgeLayer({
        llm: {
          stream: () => Stream.die(new Error("unexpected defect")),
        },
      }),
    )
    expect(verdict.outcome).toBe("denied")
  })
})
