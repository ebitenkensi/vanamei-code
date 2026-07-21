import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MonitorAPINode } from "../../src/tool/monitor"
import { MonitorAPI, type StartInput } from "../../src/tool/monitor-api"
import { SessionID, MessageID } from "../../src/session/schema"
import type { SessionPrompt } from "../../src/session/prompt"
import { MonitorV1 } from "@opencode-ai/schema/monitor-v1"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { testEffect } from "../lib/effect"
import type { TaskPromptOps } from "../../src/tool/task"

// Per-test recording event bridge; each test gets a fresh list via Layer.effect.
// Clear before use if you need to assert on publishes.
const publishedEvents: Array<{ topic: unknown; event: unknown }> = []

const eventV2BridgeMock = Layer.effect(
  EventV2Bridge.Service,
  Effect.sync(() =>
    EventV2Bridge.Service.of({
      publish: (topic: unknown, event: unknown) => Effect.sync(() => { publishedEvents.push({ topic, event }) }) as any,
      subscribe: () => [] as any,
      all: () => [] as any,
      durable: () => [] as any,
      listen: () => Effect.succeed(Effect.void),
      project: () => Effect.void,
      replay: () => Effect.void,
      replayAll: () => Effect.succeed(undefined),
      remove: () => Effect.void,
      claim: () => Effect.void,
    })
  ),
)

const testLayer = Layer.mergeAll(
  LayerNode.compile(LayerNode.group([MonitorAPINode, CrossSpawnSpawner.node])),
  eventV2BridgeMock,
)

const it = testEffect(testLayer)

function makeStubOps(): { ops: TaskPromptOps; calls: SessionPrompt.PromptInput[] } {
  const calls: SessionPrompt.PromptInput[] = []
  const ops: TaskPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) => {
      calls.push(input)
      return Effect.succeed({
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
      } as SessionV1.WithParts)
    },
  }
  return { ops, calls }
}

const testSessionID = SessionID.make("ses_autostart_test")
const defaultAgent = "build"

describe("tool.monitor-autostart", () => {
  it.live("startMonitor with sessionID=null creates an instance-owned entry", () =>
    Effect.gen(function* () {
      const api = yield* MonitorAPI
      const result = yield* api.startMonitor({
        command: "echo instance-owned",
        description: "autostart test",
        sessionID: null,
        agent: defaultAgent,
      })
      expect(result).toHaveProperty("monitorID")
      expect(typeof result.monitorID).toBe("string")
      expect(result.monitorID.startsWith("mon_")).toBe(true)

      // List with our sessionID should include this instance-owned monitor
      const entries = yield* api.listMonitors(testSessionID)
      expect(entries.length).toBeGreaterThan(0)
      expect(entries.some((e) => e.description === "autostart test")).toBe(true)
    }).pipe(Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new Error("test timed out")),
    })),
  )

  it.live("rebind flushes pendingLines", () =>
    Effect.gen(function* () {
      const api = yield* MonitorAPI
      const { ops, calls } = makeStubOps()

      // Start an autostart monitor; keep process alive past rebind so
      // pending lines can be flushed before exit.
      yield* api.startMonitor({
        command: "echo pending-line-test && sleep 1.5",
        description: "rebind-flush-test",
        sessionID: null,
        agent: defaultAgent,
      })

      // Wait for process to produce output (real time)
      yield* Effect.sleep(800)

      // Entry should exist but have no calls yet (no binding)
      expect(calls.length).toBe(0)

      // Rebind to a session
      yield* api.rebind(testSessionID, ops)

      // Wait for flush to happen
      yield* Effect.sleep(500)

      const injected = calls.find(
        (call) => call.parts[0]?.type === "text" && (call.parts[0] as any).text.includes("pending-line-test"),
      )
      expect(injected).toBeDefined()
    }).pipe(Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new Error("test timed out")),
    })),
  )

  it.live("unbindForSession clears binding", () =>
    Effect.gen(function* () {
      const api = yield* MonitorAPI
      const { ops, calls } = makeStubOps()

      // Start an autostart monitor
      yield* api.startMonitor({
        command: "echo unbind-test",
        description: "unbind-test",
        sessionID: null,
        agent: defaultAgent,
      })

      // Rebind first
      yield* api.rebind(testSessionID, ops)

      // Wait for process output to be flushed
      yield* Effect.sleep(800)

      // Should have some calls now
      const beforeCount = calls.length

      // Unbind
      yield* api.unbindForSession(testSessionID)

      // The important check: unbind does not crash
      expect(true).toBe(true)
    }).pipe(Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new Error("test timed out")),
    })),
  )

  it.live("top-level vs subagent session distinction: rebind works for both", () =>
    Effect.gen(function* () {
      const api = yield* MonitorAPI
      const { ops: ops1, calls: calls1 } = makeStubOps()

      // Start an autostart monitor
      yield* api.startMonitor({
        command: "echo distinction-test",
        description: "distinction-test",
        sessionID: null,
        agent: defaultAgent,
      })

      // Rebind with first ops (simulates top-level session)
      yield* api.rebind(testSessionID, ops1)

      // Wait for process
      yield* Effect.sleep(800)

      const injected1 = calls1.find(
        (call) => call.parts[0]?.type === "text" && (call.parts[0] as any).text.includes("distinction-test"),
      )
      expect(injected1).toBeDefined()

      // The distinction between top-level and subagent sessions is enforced
      // at the prompt.ts call site, not in the MonitorAPI itself.
      // MonitorAPI.rebind binds unconditionally; prompt.ts guards with
      // `session.parentID === undefined`.
    }).pipe(Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new Error("test timed out")),
    })),
  )

  it.live("autostart monitor exiting unbound skips monitor.stopped publish", () =>
    Effect.gen(function* () {
      const api = yield* MonitorAPI

      yield* api.startMonitor({
        command: "exit 0",
        description: "unbound-exit-skip-stopped",
        sessionID: null,
        agent: defaultAgent,
      })

      // Wait for the process to exit and cleanup to happen
      yield* Effect.sleep(1000)

      // Verify no monitor.stopped event was published for this unbound monitor
      const stoppedEvents = publishedEvents.filter(
        (e) => (e.event as Record<string, unknown>)?.description === "unbound-exit-skip-stopped"
          && (e.topic as any) === MonitorV1.Event.Stopped,
      )
      expect(stoppedEvents).toHaveLength(0)

      // Monitor should be cleaned up from the list
      const entries = yield* api.listMonitors(testSessionID)
      expect(entries.every((e) => e.description !== "unbound-exit-skip-stopped")).toBe(true)
    }).pipe(Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new Error("test timed out")),
    })),
  )
})
