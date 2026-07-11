import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { Judge } from "@/permission/judge"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Effect, Layer, Scope } from "effect"

// P3: read session.automode field from the session model
function isSessionAutomode(_sessionID: SessionID): Effect.Effect<boolean> {
  return Effect.succeed(false)
}

function runJudge(
  request: PermissionV1.Request,
  judge: Judge.Interface,
  permission: Permission.Interface,
  events: EventV2.Interface,
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

export const layer = Layer.effect(
  EventV2Bridge.Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const judge = yield* Judge.Service
    const session = yield* Session.Service
    const permission = yield* Permission.Service

    const scope = yield* Scope.Scope
    const unsubscribe = yield* events.listen((event) => {
      if (event.type !== Permission.Event.Asked.type) return Effect.void
      const request = event.data as PermissionV1.Request
      return Effect.gen(function* () {
        const byFlag = request.auto === true
        const byToggle = yield* isSessionAutomode(request.sessionID)
        if (!byFlag && !byToggle) return

        yield* runJudge(request, judge, permission, events).pipe(Effect.forkIn(scope))
      }).pipe(Effect.catchCause(() => Effect.void))
    })
    yield* Effect.addFinalizer(() => unsubscribe)

    return yield* EventV2Bridge.Service
  }),
)

export const node = LayerNode.make({
  service: EventV2Bridge.Service,
  layer,
  deps: [Permission.node, Judge.node, Session.node, EventV2Bridge.node],
})

export * as Watch from "./watch"
