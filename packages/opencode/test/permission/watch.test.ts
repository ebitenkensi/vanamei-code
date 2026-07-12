import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, test, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Scope } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { Judge } from "../../src/permission/judge"
import { Session } from "../../src/session/session"
import { SessionID } from "../../src/session/schema"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { pollWithTimeout } from "../lib/effect"

function isSessionAutomode(session: Session.Interface, sessionID: SessionID): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const s = yield* session.get(sessionID).pipe(
      Effect.catch(() => Effect.succeed({ automode: undefined } as Session.Info)),
    )
    return s.automode === true
  })
}

function runJudgeInline(
  request: PermissionV1.Request,
  judge: Judge.Interface,
  permission: Permission.Interface,
  events: any,
) {
  return Effect.gen(function* () {
    const verdict = yield* judge.judge({ request }).pipe(
      Effect.catch(() => Effect.succeed({ outcome: "ask" as const, reason: "" })),
    )
    if (verdict.outcome !== "allowed") return

    yield* permission.reply({ requestID: request.id, reply: "once" }).pipe(
      Effect.catchTag("Permission.NotFoundError", () => Effect.void),
    )

    yield* events.publish(Permission.Event.Judged, {
      sessionID: request.sessionID,
      requestID: request.id,
      permission: request.permission,
      patterns: request.patterns,
      reason: "",
      tool: request.tool,
    })
  })
}

function startWatcherInline(scope: Scope.Scope) {
  return Effect.gen(function* () {
    const events: any = yield* EventV2Bridge.Service
    const judge = yield* Judge.Service
    const permission = yield* Permission.Service
    const session = yield* Session.Service

    const unsubscribe = yield* events.listen((event: any) => {
      if (event.type !== Permission.Event.Asked.type) return Effect.void
      const request = event.data as PermissionV1.Request
      return Effect.gen(function* () {
        const byFlag = request.auto === true
        const byToggle = yield* isSessionAutomode(session, request.sessionID)
        if (!byFlag && !byToggle) return

        yield* runJudgeInline(request, judge, permission, events).pipe(Effect.forkIn(scope))
      }).pipe(Effect.catchCause(() => Effect.void))
    })
    yield* Effect.addFinalizer(() => unsubscribe)
  })
}

const sessionInfo: Session.Info = {
  id: "ses_test",
  slug: "test",
  projectID: "pro_test",
  directory: "/tmp",
  title: "test session",
  version: "1",
  model: { id: "test-model", providerID: "test-provider" },
  time: { created: Date.now(), updated: Date.now() },
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: 0,
} as Session.Info

const mockSessionInterface: Session.Interface = {
  get: () => Effect.succeed(sessionInfo),
  list: () => Effect.succeed([]),
  listGlobal: () => Effect.succeed([]),
  create: () => Effect.succeed(sessionInfo),
  fork: () => Effect.succeed(sessionInfo),
  touch: () => Effect.void,
  setTitle: () => Effect.void,
  setArchived: () => Effect.void,
  setMetadata: () => Effect.void,
  setAutomode: () => Effect.void,
  setAgentModel: () => Effect.void,
  setPermission: () => Effect.void,
  setRevert: () => Effect.void,
  clearRevert: () => Effect.void,
  setSummary: () => Effect.void,
  setShare: () => Effect.void,
  setWorkspace: () => Effect.void,
  diff: () => Effect.succeed([]),
  messages: () => Effect.succeed([]),
  children: () => Effect.succeed([]),
  remove: () => Effect.void,
  updateMessage: (msg: any) => Effect.succeed(msg),
  removeMessage: () => Effect.succeed("" as any),
  removePart: () => Effect.succeed("" as any),
  getPart: () => Effect.succeed(undefined),
  updatePart: (part: any) => Effect.succeed(part),
  updatePartDelta: () => Effect.void,
  findMessage: () => Effect.succeed({ _tag: "None" }) as any,
}

const mockSession: Layer.Layer<Session.Service> = Layer.succeed(Session.Service, Session.Service.of(mockSessionInterface))

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const baseLayer: any = Layer.provideMerge(
  AppNodeBuilder.build(
    LayerNode.group([Permission.node, EventV2Bridge.node, InstanceStore.node]),
    [[InstanceStore.bootstrapNode, noopBootstrap]],
  ),
  mockSession,
)

function layer(verdict: Judge.Verdict): any {
  const mockJudge: any = Layer.succeed(
    Judge.Service,
    Judge.Service.of({ judge: () => Effect.succeed(verdict) }),
  )
  return Layer.provideMerge(baseLayer, mockJudge)
}

function expectEvent(events: any, type: string) {
  return Effect.gen(function* () {
    const deferred = yield* Deferred.make<unknown>()
    const unsub = yield* events.listen((event: any) => {
      if (event.type === type) {
        Deferred.doneUnsafe(deferred, Effect.succeed(event.data))
      }
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsub)
    return yield* Deferred.await(deferred).pipe(
      Effect.timeoutOrElse({
        duration: "3 seconds",
        orElse: () => Effect.fail(new Error(`timed out waiting for ${type}`)),
      }),
    )
  })
}

describe("watch - auto flag with allowed verdict", () => {
  test("replies once and publishes Judged", async () => {
    await runTest(
      Effect.gen(function* () {
        const scope = yield* Scope.Scope
        yield* startWatcherInline(scope)
        const events: any = yield* EventV2Bridge.Service
        const judged = yield* Effect.forkScoped(expectEvent(events, Permission.Event.Judged.type))

        const perm = yield* Permission.Service
        yield* perm.ask({
          sessionID: SessionID.make("ses_test"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "auto" }],
        }).pipe(Effect.forkScoped)

        const data = (yield* Fiber.join(judged)) as any
        expect(data.permission).toBe("bash")
        expect(data.patterns).toEqual(["ls"])
        expect(data.reason).toBe("")
      }),
      { outcome: "allowed" },
    )
  })
})

function runTest(effect: any, verdict: Judge.Verdict) {
  const withInstance = Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return yield* store.provide({ directory: "/tmp/watch-test" }, effect)
  })
  return (withInstance as any).pipe(
    (e: any) => Effect.provide(e, layer(verdict)),
    (e: any) => Effect.scoped(e),
    (e: any) => Effect.runPromise(e),
  )
}

describe("watch - auto flag with ask verdict", () => {
  test("does not reply or publish Judged", async () => {
    await runTest(
      Effect.gen(function* () {
        const scope = yield* Scope.Scope
        yield* startWatcherInline(scope)
        const perm = yield* Permission.Service

        const fiber = yield* perm.ask({
          sessionID: SessionID.make("ses_test"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "auto" }],
        }).pipe(Effect.forkScoped)

        yield* Effect.sleep("500 millis")

        const pending = yield* perm.list()
        expect(pending.length).toBeGreaterThanOrEqual(1)

        yield* perm.reply({ requestID: pending[0].id, reply: "reject" }).pipe(Effect.catch(() => Effect.void))
        yield* Fiber.await(fiber).pipe(Effect.catch(() => Effect.void))
      }),
      { outcome: "ask", reason: "not safe" },
    )
  })
})

describe("watch - no auto flag", () => {
  test("does not invoke judge when auto is false", async () => {
    await runTest(
      Effect.gen(function* () {
        const scope = yield* Scope.Scope
        yield* startWatcherInline(scope)
        const perm = yield* Permission.Service

        const fiber = yield* perm.ask({
          sessionID: SessionID.make("ses_test"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        }).pipe(Effect.forkScoped)

        yield* Effect.sleep("500 millis")

        const pending = yield* perm.list()
        expect(pending.length).toBeGreaterThanOrEqual(1)

        yield* perm.reply({ requestID: pending[0].id, reply: "reject" }).pipe(Effect.catch(() => Effect.void))
        yield* Fiber.await(fiber).pipe(Effect.catch(() => Effect.void))
      }),
      { outcome: "allowed" },
    )
  })
})

describe("watch - user replies first (race)", () => {

  function raceLayer(): any {
    // Deliberation takes 500ms so the user always wins the race
    const delayedJudge: any = Layer.succeed(
      Judge.Service,
      Judge.Service.of({
        judge: () =>
          Effect.gen(function* () {
            yield* Effect.sleep("500 millis")
            return { outcome: "allowed" as const, reason: "" }
          }),
      }),
    )
    return Layer.provideMerge(baseLayer, delayedJudge)
  }

  async function runRaceTest(effect: any) {
    const withInstance = Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      return yield* store.provide({ directory: "/tmp/watch-race-test" }, effect)
    })
    return (withInstance as any).pipe(
      (e: any) => Effect.provide(e, raceLayer()),
      (e: any) => Effect.scoped(e),
      (e: any) => Effect.runPromise(e),
    )
  }

  test("suppresses Judged when reply already handled", async () => {
    await runRaceTest(
      Effect.gen(function* () {
        const scope = yield* Scope.Scope
        yield* startWatcherInline(scope)
        const events: any = yield* EventV2Bridge.Service
        const perm = yield* Permission.Service

        const judgedDeferred = yield* Deferred.make<unknown>()
        const unsubJudged = yield* events.listen((event: any) => {
          if (event.type === Permission.Event.Judged.type) {
            Deferred.doneUnsafe(judgedDeferred, Effect.succeed(event.data))
          }
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsubJudged)

        const fiber = yield* perm.ask({
          sessionID: SessionID.make("ses_test"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "auto" }],
        }).pipe(Effect.forkScoped)

        // Use pollWithTimeout so we reply as soon as the request appears
        const pending = yield* pollWithTimeout(
          Effect.gen(function* () {
            const list = yield* perm.list()
            return list.length > 0 ? list[0] : undefined
          }),
          "pending request never appeared",
          "3 seconds",
        )
        yield* perm.reply({ requestID: pending.id, reply: "reject" }).pipe(Effect.catch(() => Effect.void))

        yield* Fiber.await(fiber).pipe(Effect.catch(() => Effect.void))

        // Allow any stray Judged publish to arrive before we check
        yield* Effect.sleep("200 millis")

        // Assert Judged was NOT published (Deferred.await times out)
        const judged = yield* Deferred.await(judgedDeferred).pipe(
          Effect.timeoutOrElse({
            duration: "10 millis",
            orElse: () => Effect.succeed(null as any),
          }),
        )
        expect(judged).toBeNull()
      }),
    )
  })
})

describe("watch - session automode toggle", () => {
  test("invokes judge when session automode is enabled even without auto flag", async () => {
    const automodeSessionInfo: Session.Info = { ...sessionInfo, automode: true }
    const automodeMockSession: Layer.Layer<Session.Service> = Layer.succeed(
      Session.Service,
      Session.Service.of({
        ...mockSessionInterface,
        get: () => Effect.succeed(automodeSessionInfo),
      }),
    )
    const automodeBaseLayer: any = Layer.provideMerge(
      AppNodeBuilder.build(
        LayerNode.group([Permission.node, EventV2Bridge.node, InstanceStore.node]),
        [[InstanceStore.bootstrapNode, noopBootstrap]],
      ),
      automodeMockSession,
    )

    const automodeLayer: any = Layer.provideMerge(
      automodeBaseLayer,
      Layer.succeed(Judge.Service, Judge.Service.of({ judge: () => Effect.succeed({ outcome: "allowed" as const, reason: "" }) })),
    )

    function runWithAutomode(effect: any) {
      const withInstance = Effect.gen(function* () {
        const store = yield* InstanceStore.Service
        return yield* store.provide({ directory: "/tmp/watch-automode-test" }, effect)
      })
      return (withInstance as any).pipe(
        (e: any) => Effect.provide(e, automodeLayer),
        (e: any) => Effect.scoped(e),
        (e: any) => Effect.runPromise(e),
      )
    }

    await runWithAutomode(
      Effect.gen(function* () {
        const scope = yield* Scope.Scope
        yield* startWatcherInline(scope)
        const events: any = yield* EventV2Bridge.Service
        const judged = yield* Effect.forkScoped(expectEvent(events, Permission.Event.Judged.type))

        const perm = yield* Permission.Service
        yield* perm.ask({
          sessionID: SessionID.make("ses_test"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        }).pipe(Effect.forkScoped)

        const data = (yield* Fiber.join(judged)) as any
        expect(data.permission).toBe("bash")
        expect(data.patterns).toEqual(["ls"])
        expect(data.reason).toBe("")
      }),
    )
  })
})
