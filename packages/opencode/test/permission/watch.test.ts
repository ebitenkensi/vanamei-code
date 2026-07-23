import { describe, test, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Scope } from "effect"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { Judge } from "../../src/permission/judge"
import { Watch } from "../../src/permission/watch"
import { Session } from "../../src/session/session"
import { SessionID } from "../../src/session/schema"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { pollWithTimeout } from "../lib/effect"

const sessionID = SessionID.make("ses_test")

function sessionInfo(automode: boolean): Session.Info {
  return {
    id: sessionID,
    slug: "test",
    projectID: ProjectV2.ID.make("pro_test"),
    directory: "/tmp",
    title: "test session",
    version: "1",
    automode,
    time: { created: Date.now(), updated: Date.now() },
  }
}

// Builds the real Watch daemon against the real Permission and event bridge,
// swapping only the Judge verdict and the Session record via node replacement.
function watchLayer(judge: Judge.Interface, automode = false) {
  return AppNodeBuilder.build(LayerNode.group([Watch.node, Permission.node, EventV2Bridge.node, InstanceStore.node]), [
    [
      InstanceStore.bootstrapNode,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
    [Judge.node, Layer.succeed(Judge.Service, Judge.Service.of(judge))],
    [Session.node, Layer.mock(Session.Service, { get: () => Effect.succeed(sessionInfo(automode)) })],
  ])
}

function runTest<A, E>(
  effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof watchLayer>> | Scope.Scope>,
  judge: Judge.Interface,
  automode = false,
) {
  const withInstance = Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return yield* store.provide({ directory: "/tmp/watch-test" }, effect)
  })
  return Effect.runPromise(Effect.scoped(Effect.provide(withInstance, watchLayer(judge, automode))))
}

function askInput(action: "auto" | "ask") {
  return {
    sessionID,
    permission: "bash",
    patterns: ["ls"],
    metadata: {},
    always: [],
    ruleset: [{ permission: "bash", pattern: "*", action }],
  }
}

type JudgedData = {
  sessionID: string
  requestID: string
  permission: string
  patterns: string[]
  outcome: "allowed" | "denied"
  reason: string
  tool?: { messageID: string; callID: string }
}

// Resolves with the first Judged event's data, or undefined after the given
// window so "must not publish" assertions don't hang the test.
function collectJudged(window: `${number} millis` = "3000 millis") {
  return Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const deferred = yield* Deferred.make<JudgedData | undefined>()
    const unsubscribe = yield* events.listen((event) => {
      if (event.type === Permission.Event.Judged.type) {
        Deferred.doneUnsafe(deferred, Effect.succeed(event.data as JudgedData))
      }
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    return Deferred.await(deferred).pipe(
      Effect.timeoutOrElse({ duration: window, orElse: () => Effect.succeed(undefined) }),
    )
  })
}

describe("watch with auto flag", () => {
  test("allowed verdict resolves the ask and publishes Judged with the reason", async () => {
    let judged = false
    await runTest(
      Effect.gen(function* () {
        const awaitJudged = yield* collectJudged()
        const permission = yield* Permission.Service

        const ask = yield* permission.ask(askInput("auto")).pipe(Effect.forkScoped)
        const data = yield* awaitJudged
        expect(data).toEqual({
          sessionID,
          requestID: expect.stringMatching(/^per/),
          permission: "bash",
          patterns: ["ls"],
          outcome: "allowed",
          reason: "safe operation",
          tool: undefined,
        })

        // The once-reply resolved the pending ask without user input.
        yield* Fiber.join(ask)
        expect(yield* permission.list()).toEqual([])
        judged = true
      }),
      { judge: () => Effect.succeed({ outcome: "allowed", reason: "safe operation" }) },
    )
    expect(judged).toBe(true)
  })

  test("denied verdict rejects the pending request and publishes Judged with outcome denied", async () => {
    await runTest(
      Effect.gen(function* () {
        const awaitJudged = yield* collectJudged()
        const permission = yield* Permission.Service

        const ask = yield* permission.ask(askInput("auto")).pipe(Effect.forkScoped)
        const data = yield* awaitJudged
        expect(data).toEqual({
          sessionID,
          requestID: expect.stringMatching(/^per/),
          permission: "bash",
          patterns: ["ls"],
          outcome: "denied",
          reason: "destructive command",
          tool: undefined,
        })

        // The reject reply resolved the pending ask without user input --
        // there is no interactive prompt left for the user to answer.
        yield* Fiber.await(ask)
        expect(yield* permission.list()).toEqual([])
      }),
      { judge: () => Effect.succeed({ outcome: "denied", reason: "destructive command" }) },
    )
  })
})

describe("watch without auto flag", () => {
  test("does not invoke the judge for a plain ask resolution", async () => {
    let invoked = false
    await runTest(
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const ask = yield* permission.ask(askInput("ask")).pipe(Effect.forkScoped)

        const pending = yield* pollWithTimeout(
          Effect.map(permission.list(), (list) => list[0]),
          "pending request never appeared",
          "3 seconds",
        )
        yield* Effect.sleep("200 millis")
        expect(invoked).toBe(false)

        yield* permission.reply({ requestID: pending.id, reply: "reject" })
        yield* Fiber.await(ask)
      }),
      {
        judge: () => {
          invoked = true
          return Effect.succeed({ outcome: "allowed", reason: "" })
        },
      },
    )
  })

  test("session automode toggle routes a plain ask through the judge", async () => {
    await runTest(
      Effect.gen(function* () {
        const awaitJudged = yield* collectJudged()
        const permission = yield* Permission.Service

        const ask = yield* permission.ask(askInput("ask")).pipe(Effect.forkScoped)
        const data = yield* awaitJudged
        expect(data?.permission).toBe("bash")
        expect(data?.reason).toBe("toggle judged")

        yield* Fiber.join(ask)
      }),
      { judge: () => Effect.succeed({ outcome: "allowed", reason: "toggle judged" }) },
      true,
    )
  })
})

describe("watch defect-proofing", () => {
  test("a defect from the judge still rejects the pending request and publishes Judged denied", async () => {
    await runTest(
      Effect.gen(function* () {
        const awaitJudged = yield* collectJudged()
        const permission = yield* Permission.Service

        const ask = yield* permission.ask(askInput("auto")).pipe(Effect.forkScoped)
        const data = yield* awaitJudged
        expect(data?.outcome).toBe("denied")

        // No prompt is left stuck on "judging" -- the catch-all in
        // watch.ts's judgeRequest rejected it despite the defect.
        yield* Fiber.await(ask)
        expect(yield* permission.list()).toEqual([])
      }),
      { judge: () => Effect.die(new Error("judge blew up")) },
    )
  })
})

describe("watch race with user reply", () => {
  test("user reply wins and Judged is not published", async () => {
    await runTest(
      Effect.gen(function* () {
        const awaitJudged = yield* collectJudged("800 millis")
        const permission = yield* Permission.Service

        const ask = yield* permission.ask(askInput("auto")).pipe(Effect.forkScoped)
        const pending = yield* pollWithTimeout(
          Effect.map(permission.list(), (list) => list[0]),
          "pending request never appeared",
          "3 seconds",
        )
        yield* permission.reply({ requestID: pending.id, reply: "reject" })
        yield* Fiber.await(ask)

        expect(yield* awaitJudged).toBeUndefined()
      }),
      {
        // Deliberation outlasts the user's immediate reply so the reply wins.
        judge: () =>
          Effect.succeed<Judge.Verdict>({ outcome: "allowed", reason: "too late" }).pipe(Effect.delay("300 millis")),
      },
    )
  })
})
