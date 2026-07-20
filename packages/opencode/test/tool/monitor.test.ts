import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Config } from "@/config/config"
import { Database } from "@opencode-ai/core/database/database"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID, MessageID } from "../../src/session/schema"
import type { SessionPrompt } from "../../src/session/prompt"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { testEffect } from "../lib/effect"
import * as Tool from "@/tool/tool"
import { MonitorTool, MonitorAPI, node as MonitorAPINode } from "../../src/tool/monitor"
import type { TaskPromptOps } from "../../src/tool/task"
import { testInstanceStoreLayer, provideInstance, tmpdirScoped } from "../fixture/fixture"

const eventV2BridgeMock = Layer.succeed(
  EventV2Bridge.Service,
  EventV2Bridge.Service.of({
    publish: () => Effect.void as any,
    subscribe: () => [] as any,
    all: () => [] as any,
    durable: () => [] as any,
    listen: () => Effect.succeed(Effect.void),
    project: () => Effect.void,
    replay: () => Effect.void,
    replayAll: () => Effect.succeed(undefined),
    remove: () => Effect.void,
    claim: () => Effect.void,
  }),
)

const monitorLayer = Layer.mergeAll(
  LayerNode.compile(LayerNode.group([MonitorAPINode, CrossSpawnSpawner.node, Session.node, Truncate.node, Agent.node])),
  eventV2BridgeMock,
  testInstanceStoreLayer,
)

const it = testEffect(monitorLayer)

function makeStubOps(): { ops: TaskPromptOps; calls: SessionPrompt.PromptInput[] } {
  const calls: SessionPrompt.PromptInput[] = []
  const ops: TaskPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) => {
      calls.push(input)
      return Effect.succeed(reply(input))
    },
  }
  return { ops, calls }
}

function reply(input: SessionPrompt.PromptInput): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as any,
      providerID: "test-provider" as any,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [],
  }
}

const baseCtx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  agent: "build",
  abort: new AbortController().signal,
  extra: {},
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const runIn = <A, E, R>(dir: string, self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(dir))

describe("tool.monitor", () => {
  it.live("start spawns a process and injects output line as event", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const { ops, calls } = makeStubOps()
      const tool = yield* MonitorTool
      const def = yield* tool.init()
      const localCtx = { ...baseCtx, extra: { promptOps: ops } }

      const result = yield* runIn(
        tmp,
        def.execute(
          {
            action: "start",
            command: "echo hello",
            description: "test monitor",
          },
          localCtx,
        ),
      )

      expect(result.metadata).toHaveProperty("monitorID")
      expect(result.output).toContain("Monitor started")
      expect(result.output).toContain("test monitor")

      // Wait for the process to finish and injection to happen
      yield* Effect.sleep(1500)

      expect(calls.length).toBeGreaterThan(0)
      const injected = calls.find(
        (call) => call.parts[0]?.type === "text" && (call.parts[0] as any).text.includes("monitor event"),
      )
      expect(injected).toBeDefined()
      if (!injected || injected.parts[0]?.type !== "text") return
      expect(injected.parts[0].text).toContain("[monitor event]")
      expect(injected.parts[0].text).toContain("hello")

      // Should also have an exit notification
      const exitInjected = calls.find(
        (call) => call.parts[0]?.type === "text" && (call.parts[0] as any).text.includes("monitor exited"),
      )
      expect(exitInjected).toBeDefined()
      if (!exitInjected || exitInjected.parts[0]?.type !== "text") return
      expect(exitInjected.parts[0].text).toContain("reason=exit")
    }).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(new Error("test timed out")),
      }),
    ),
  )

  // Regression: in production every tool call runs in its own scope that
  // closes as soon as the call returns. The monitor (process + readers) must
  // survive that closure — a scope-tied spawn killed the child at call end
  // and no event or exit injection ever happened.
  it.live("monitor survives the per-call scope closing after start returns", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const { ops, calls } = makeStubOps()
      const tool = yield* MonitorTool
      const def = yield* tool.init()
      const localCtx = { ...baseCtx, extra: { promptOps: ops } }

      const result = yield* runIn(
        tmp,
        Effect.scoped(
          def.execute(
            {
              action: "start",
              command: "sleep 1; echo delayed-line",
              description: "call-scope-test",
            },
            localCtx,
          ),
        ),
      )
      expect(result.output).toContain("Monitor started")

      // The per-call scope is closed now; the line arrives afterwards.
      yield* Effect.sleep(2500)

      const injected = calls.find(
        (call) => call.parts[0]?.type === "text" && (call.parts[0] as any).text.includes("delayed-line"),
      )
      expect(injected).toBeDefined()
      const exitInjected = calls.find(
        (call) => call.parts[0]?.type === "text" && (call.parts[0] as any).text.includes("monitor exited"),
      )
      expect(exitInjected).toBeDefined()
    }).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(new Error("test timed out")),
      }),
    ),
  )

  it.live("list shows running monitors for this session", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const { ops } = makeStubOps()
      const tool = yield* MonitorTool
      const def = yield* tool.init()
      const localCtx = { ...baseCtx, extra: { promptOps: ops } }

      yield* runIn(
        tmp,
        def.execute(
          {
            action: "start",
            command: "sleep 5",
            description: "list-test",
          },
          localCtx,
        ),
      )

      const listResult = yield* runIn(tmp, def.execute({ action: "list" }, localCtx))
      expect(listResult.output).toContain("list-test")
      expect(listResult.output).not.toContain("no monitors running")
    }).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(new Error("test timed out")),
      }),
    ),
  )

  it.live("list returns no monitors when none are running", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const tool = yield* MonitorTool
      const def = yield* tool.init()

      const result = yield* runIn(tmp, def.execute({ action: "list" }, baseCtx))
      expect(result.output).toBe("no monitors running")
    }),
  )

  it.live("stop removes a running monitor", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const { ops } = makeStubOps()
      const tool = yield* MonitorTool
      const def = yield* tool.init()
      const localCtx = { ...baseCtx, extra: { promptOps: ops } }

      const startResult = yield* runIn(
        tmp,
        def.execute(
          {
            action: "start",
            command: "sleep 10",
            description: "stop-test",
          },
          localCtx,
        ),
      )

      const monitorID = startResult.metadata.monitorID as string

      const stopResult = yield* runIn(
        tmp,
        def.execute(
          {
            action: "stop",
            monitor_id: monitorID,
          },
          localCtx,
        ),
      )

      expect(stopResult.output).toContain("stopped")

      const listResult = yield* runIn(tmp, def.execute({ action: "list" }, localCtx))
      expect(listResult.output).not.toContain("stop-test")
    }).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(new Error("test timed out")),
      }),
    ),
  )

  it.live("stop with nonexistent monitor_id returns not found", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const tool = yield* MonitorTool
      const def = yield* tool.init()

      const result = yield* runIn(
        tmp,
        def.execute(
          {
            action: "stop",
            monitor_id: "mon_nonexistent",
          },
          baseCtx,
        ),
      )

      expect(result.output).toContain("not found")
    }),
  )

  it.live("timeout fires for non-persistent monitor", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const { ops, calls } = makeStubOps()
      const tool = yield* MonitorTool
      const def = yield* tool.init()
      const localCtx = { ...baseCtx, extra: { promptOps: ops } }

      yield* runIn(
        tmp,
        def.execute(
          {
            action: "start",
            command: "sleep 30",
            description: "timeout-test",
            timeout_ms: 100,
          },
          localCtx,
        ),
      )

      // Wait for timeout to trigger
      yield* Effect.sleep(1500)

      const exitInjected = calls.find(
        (call) =>
          call.parts[0]?.type === "text" &&
          (call.parts[0] as any).text.includes("monitor exited") &&
          (call.parts[0] as any).text.includes("timeout-test"),
      )
      expect(exitInjected).toBeDefined()
      if (!exitInjected || exitInjected.parts[0]?.type !== "text") return
      expect(exitInjected.parts[0].text).toContain("reason=timeout")
    }).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(new Error("test timed out")),
      }),
    ),
  )

  it.live(
    "flood guard kills noisy monitor",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const { ops, calls } = makeStubOps()
        const tool = yield* MonitorTool
        const def = yield* tool.init()
        const localCtx = { ...baseCtx, extra: { promptOps: ops } }

        // A real flood: `yes` writes as fast as the pipe accepts. The
        // dropping queue must keep memory flat while the guard counts
        // inject batches (FLOOD_LIMIT+1 batches ≈ 10.5s) and kills the child.
        const startResult = yield* runIn(
          tmp,
          def.execute(
            {
              action: "start",
              command: "yes floodline",
              description: "flood-test",
              persistent: true,
            },
            localCtx,
          ),
        )

        const monitorID = startResult.metadata.monitorID as string

        let exitText = ""
        for (let i = 0; i < 40 && !exitText; i++) {
          yield* Effect.sleep(500)
          const exit = calls.find(
            (call) => call.parts[0]?.type === "text" && (call.parts[0] as any).text.includes("monitor exited"),
          )
          if (exit) exitText = (exit.parts[0] as any).text as string
        }

        expect(exitText).toContain("reason=flooded")

        // Monitor should be gone from list after the guard fired
        const listResult = yield* runIn(tmp, def.execute({ action: "list" }, localCtx))
        expect(listResult.output).not.toContain(monitorID)
      }),
    30_000,
  )
})
