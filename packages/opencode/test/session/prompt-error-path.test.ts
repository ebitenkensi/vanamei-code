import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import type { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

// ---------------------------------------------------------------------------
// Instruction 1: prompt.ts must finalize the in-flight assistant message
// (time.completed + error) when the turn dies anywhere in the create() +
// outcome window, not just on interrupt. Reproduces the 2026-07-20 shape of
// defect (a processor dying before handle.process ever starts) and asserts
// the message isn't left dangling.
// ---------------------------------------------------------------------------

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in prompt error-path tests"),
    authenticate: () => Effect.die("unexpected MCP auth in prompt error-path tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in prompt error-path tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

// Simulates the 2026-07-20 production defect shape: something dies before
// handle.process ever starts (well inside the create()+outcome window
// prompt.ts's onExit finalize must now cover, not just handle creation).
const dyingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () => Effect.die(new TypeError("undefined is not an object (evaluating 'C.name')")),
  }),
)

const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  Provider.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
])

const promptEnv = LayerNode.compile(promptRoot, [
  [SessionSummary.node, summary],
  [LSP.node, lsp],
  [MCP.node, mcp],
  [RuntimeFlags.node, runtimeFlags],
  [SessionProcessor.node, dyingProcessor],
])

const it = testEffect(promptEnv)

// Registers a "test" provider/model so getModel resolves inside the loop.
// The processor dies before any LLM call would be made, so the baseURL is
// never dialed.
const cfg: Partial<ConfigV1.Info> = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

describe("session.prompt error-path finalization", () => {
  it.instance(
    "finalizes the assistant message when the turn dies before handle.process starts",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Dying processor" })

        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })

        const exit = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.exit)

        // The defect still propagates to this caller (mirrors how an
        // interrupt used to propagate past the old onInterrupt-only
        // finalizer). The regression this test guards is that the assistant
        // message must be finalized *before* it does, not that the defect
        // disappears — matching how it previously only surfaced in
        // SessionHttpApi.promptAsync's catchCause log with the message left
        // dangling.
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(true)
        }

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const assistant = messages.findLast((m) => m.info.role === "assistant")
        expect(assistant?.info.role).toBe("assistant")
        if (assistant?.info.role !== "assistant") return
        expect(assistant.info.time.completed).toBeNumber()
        expect(assistant.info.error).toBeDefined()
        expect(assistant.info.error?.name).toBe("UnknownError")
      }),
    { config: cfg },
  )
})

// ---------------------------------------------------------------------------
// Instruction 2: LLM.run must fail with a typed error instead of dying when
// input.agent is undefined at runtime, even though StreamInput.agent is
// typed as required. Exercises the real LLM.Service implementation (no
// mocks) — only the guard's precondition (an absent agent) is synthesized,
// since that is exactly the runtime shape the 2026-07-20 defects showed a
// caller can still produce (see compaction.ts's unguarded
// `agents.get("compaction")`, reported separately).
// ---------------------------------------------------------------------------

const llmEnv = AppNodeBuilder.build(LayerNode.group([LLM.node, Provider.node]))
const itLLM = testEffect(llmEnv)

const llmRef = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const llmCfg: Partial<ConfigV1.Info> = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      // Guard must fire before any request is attempted, so this address is
      // deliberately unreachable — a network attempt would mean the guard
      // did not short-circuit.
      options: {
        apiKey: "test-key",
        baseURL: "http://127.0.0.1:1/v1",
      },
    },
  },
}

describe("session.llm.run agent guard", () => {
  itLLM.instance(
    "fails with a typed error instead of dying when agent is missing",
    () =>
      Effect.gen(function* () {
        const model = yield* Provider.use.getModel(llmRef.providerID, llmRef.modelID)
        const sessionID = SessionID.make("session-missing-agent")
        const user: SessionV1.User = {
          id: MessageID.make("msg_user-missing-agent"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: llmRef.providerID, modelID: llmRef.modelID },
        }

        const exit = yield* LLM.Service.use((svc) =>
          svc
            .stream({
              user,
              sessionID,
              model,
              // StreamInput.agent is typed as required, but the 2026-07-20
              // defects show a caller can still reach LLM.run with it
              // undefined at runtime. Force that shape to exercise the guard.
              agent: undefined as unknown as Agent.Info,
              system: [],
              messages: [{ role: "user", content: "hi" }],
              tools: {},
            })
            .pipe(Stream.runDrain),
        ).pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (!Exit.isFailure(exit)) return
        // The whole point of the guard: a typed Fail, not a Die from
        // reading .name off undefined.
        expect(Cause.hasDies(exit.cause)).toBe(false)
        expect(Cause.hasFails(exit.cause)).toBe(true)

        const error = Cause.squash(exit.cause)
        expect(NamedError.Unknown.isInstance(error)).toBe(true)
        if (!NamedError.Unknown.isInstance(error)) return
        expect(error.data.message).toContain(sessionID)
        expect(error.data.message.toLowerCase()).toContain("agent")
      }),
    { config: llmCfg },
  )
})
