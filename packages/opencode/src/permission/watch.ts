import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { Judge } from "@/permission/judge"
import { Session } from "@/session/session"
import { Effect, Layer, Scope } from "effect"

// Daemon that watches Event.Asked and lets the LLM judge auto-allow safe
// requests. Deny rules never reach this point (Permission.ask fails first),
// so the judge can only grant a "once" reply or leave the prompt for the user.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const judge = yield* Judge.Service
    const session = yield* Session.Service
    const permission = yield* Permission.Service
    const scope = yield* Scope.Scope

    const judgeRequest = (request: PermissionV1.Request) =>
      Effect.gen(function* () {
        const verdict = yield* judge.judge({ request })
        if (verdict.outcome === "allowed") {
          yield* permission.reply({ requestID: request.id, reply: "once" }).pipe(
            Effect.andThen(
              events.publish(Permission.Event.Judged, {
                sessionID: request.sessionID,
                requestID: request.id,
                permission: request.permission,
                patterns: request.patterns,
                outcome: "allowed",
                reason: verdict.reason,
                tool: request.tool,
              }),
            ),
            // NotFoundError means the user replied first; their answer wins.
            Effect.catchTag("Permission.NotFoundError", () => Effect.void),
          )
          return
        }

        // Judge asked — publish Judged with outcome "ask" so the TUI knows it
        // is safe to show the ask screen. The deferred stays pending so the
        // user can answer.
        yield* events.publish(Permission.Event.Judged, {
          sessionID: request.sessionID,
          requestID: request.id,
          permission: request.permission,
          patterns: request.patterns,
          outcome: "ask",
          reason: verdict.reason,
          tool: request.tool,
        })
      })

    const unsubscribe = yield* events.listen((event) => {
      if (event.type !== Permission.Event.Asked.type) return Effect.void
      const request = event.data as PermissionV1.Request
      return Effect.gen(function* () {
        const eligible =
          request.auto === true ||
          (yield* session.get(request.sessionID).pipe(
            Effect.map((info) => info.automode === true),
            Effect.catch(() => Effect.succeed(false)),
          ))
        if (!eligible) return

        yield* judgeRequest(request).pipe(Effect.forkIn(scope))
      }).pipe(Effect.catchCause(() => Effect.void))
    })
    yield* Effect.addFinalizer(() => unsubscribe)
  }),
)

export const node = LayerNode.make({
  name: "PermissionWatch",
  layer,
  deps: [Permission.node, Judge.node, Session.node, EventV2Bridge.node],
})

export * as Watch from "./watch"
