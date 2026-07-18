import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { test, expect, describe } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "../lib/effect"
import { SessionID } from "../../src/session/schema"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

const rejectAll = (message?: string) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    for (const req of yield* permission.list()) {
      yield* permission.reply({
        requestID: req.id,
        reply: "reject",
        message,
      })
    }
  })

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* Effect.gen(function* () {
      while (true) {
        const list = yield* permission.list()
        if (list.length === count) return list
        yield* Effect.sleep("10 millis")
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "1 second",
        orElse: () => Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`)),
      }),
    )
  })

const fail = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* self.pipe(Effect.exit)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    throw new Error("expected permission effect to fail")
  })

const ask = (input: Parameters<Permission.Interface["ask"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input)
  })

describe("evaluate with auto", () => {
  test("returns auto when configured", () => {
    const result = Permission.evaluate("bash", "*", [{ permission: "bash", pattern: "*", action: "auto" }])
    expect(result.action).toBe("auto")
  })

  test("more-specific auto wins over generic ask via findLast", () => {
    const result = Permission.evaluate("bash", "rm", [
      { permission: "bash", pattern: "*", action: "ask" },
      { permission: "bash", pattern: "rm", action: "auto" },
    ])
    expect(result.action).toBe("auto")
  })

  test("deny wins over auto when placed later", () => {
    const result = Permission.evaluate("bash", "rm", [
      { permission: "bash", pattern: "*", action: "auto" },
      { permission: "bash", pattern: "rm", action: "deny" },
    ])
    expect(result.action).toBe("deny")
  })

  test("auto does not win over a later deny", () => {
    const result = Permission.evaluate("bash", "rm", [
      { permission: "bash", pattern: "rm", action: "auto" },
      { permission: "bash", pattern: "*", action: "deny" },
    ])
    expect(result.action).toBe("deny")
  })

  test("default returns ask when no rule matches", () => {
    const result = Permission.evaluate("bash", "rm", [])
    expect(result.action).toBe("ask")
  })

  test("default returns ask when no matching rules", () => {
    const result = Permission.evaluate("bash", "rm", [{ permission: "edit", pattern: "*", action: "auto" }])
    expect(result.action).toBe("ask")
  })
})

describe("ask with auto flag", () => {
  it.instance(
    "all patterns auto sets request.auto === true",
    () =>
      Effect.gen(function* () {
        const events = yield* EventV2Bridge.Service
        const seen = yield* Deferred.make<PermissionV1.Request>()
        const unsub = yield* events.listen((event) => {
          if (event.type === Permission.Event.Asked.type)
            Deferred.doneUnsafe(seen, Effect.succeed(event.data as PermissionV1.Request))
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)

        const fiber = yield* ask({
          sessionID: SessionID.make("session_auto_true"),
          permission: "bash",
          patterns: ["ls", "pwd"],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "bash", pattern: "*", action: "auto" },
          ],
        }).pipe(Effect.forkScoped)

        const request = yield* Deferred.await(seen).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.fail(new Error("timed out waiting for permission asked event")),
          }),
        )
        expect(request.auto).toBe(true)

        yield* rejectAll()
        yield* Fiber.await(fiber)
      }),
    { git: true },
  )

  it.instance(
    "mix of auto and ask sets request.auto === false",
    () =>
      Effect.gen(function* () {
        const events = yield* EventV2Bridge.Service
        const seen = yield* Deferred.make<PermissionV1.Request>()
        const unsub = yield* events.listen((event) => {
          if (event.type === Permission.Event.Asked.type)
            Deferred.doneUnsafe(seen, Effect.succeed(event.data as PermissionV1.Request))
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)

        const fiber = yield* ask({
          sessionID: SessionID.make("session_auto_mix"),
          permission: "bash",
          patterns: ["ls", "unknown_cmd"],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "bash", pattern: "ls", action: "auto" },
          ],
        }).pipe(Effect.forkScoped)

        const request = yield* Deferred.await(seen).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.fail(new Error("timed out waiting for permission asked event")),
          }),
        )
        // First pattern resolves to auto, second resolves to ask (default) -> auto is false
        expect(request.auto).toBe(false)

        yield* rejectAll()
        yield* Fiber.await(fiber)
      }),
    { git: true },
  )

  it.instance(
    "all ask sets request.auto === false",
    () =>
      Effect.gen(function* () {
        const events = yield* EventV2Bridge.Service
        const seen = yield* Deferred.make<PermissionV1.Request>()
        const unsub = yield* events.listen((event) => {
          if (event.type === Permission.Event.Asked.type)
            Deferred.doneUnsafe(seen, Effect.succeed(event.data as PermissionV1.Request))
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)

        const fiber = yield* ask({
          sessionID: SessionID.make("session_auto_false"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        const request = yield* Deferred.await(seen).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.fail(new Error("timed out waiting for permission asked event")),
          }),
        )
        expect(request.auto).toBe(false)

        yield* rejectAll()
        yield* Fiber.await(fiber)
      }),
    { git: true },
  )

  it.instance(
    "deny rule throws DeniedError with no Asked event",
    () =>
      Effect.gen(function* () {
        const events = yield* EventV2Bridge.Service
        const eventsSeen: unknown[] = []
        const unsub = yield* events.listen((event) => {
          eventsSeen.push(event)
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)

        const err = yield* fail(
          ask({
            sessionID: SessionID.make("session_deny"),
            permission: "bash",
            patterns: ["rm -rf /"],
            metadata: {},
            always: [],
            ruleset: [{ permission: "bash", pattern: "*", action: "deny" }],
          }),
        )
        expect(err).toBeInstanceOf(PermissionV1.DeniedError)
        const askedEvents = eventsSeen.filter((e: any) => e.type === Permission.Event.Asked.type)
        expect(askedEvents).toHaveLength(0)
      }),
    { git: true },
  )

  it.instance(
    "all allow produces no Asked event",
    () =>
      Effect.gen(function* () {
        const events = yield* EventV2Bridge.Service
        const eventsSeen: unknown[] = []
        const unsub = yield* events.listen((event) => {
          eventsSeen.push(event)
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)

        const result = yield* ask({
          sessionID: SessionID.make("session_allow"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
        })
        expect(result).toBeUndefined()
        const askedEvents = eventsSeen.filter((e: any) => e.type === Permission.Event.Asked.type)
        expect(askedEvents).toHaveLength(0)
      }),
    { git: true },
  )
})
