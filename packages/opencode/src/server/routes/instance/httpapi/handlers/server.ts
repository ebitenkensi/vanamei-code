import { Deferred, Effect, Option, Scope } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { HttpServerRequest } from "effect/unstable/http"
import { InstanceStore } from "@/project/instance-store"
import * as InstanceState from "@/effect/instance-state"
import { Discovery } from "@/server/discovery"
import { ServerAuth } from "@/server/auth"
import { SessionStatus } from "@/session/status"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { InstanceHttpApi } from "../api"
import { ServerShutdownApi, HandoffPayload } from "../groups/server"

let _listenerStop: ((close?: boolean) => Promise<void>) | undefined
let _projectID: string | undefined

export function registerListener(stop: (close?: boolean) => Promise<void>, projectID: string) {
  _listenerStop = stop
  _projectID = projectID
}

export const serverHandlers = HttpApiBuilder.group(ServerShutdownApi, "server", (handlers) =>
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service

    return handlers.handle("shutdown", () =>
      Effect.gen(function* () {
        // Return 204 immediately — the setImmediate callback does the work
        // after the response is sent.
        yield* Effect.sync(() => {
          setImmediate(async () => {
            await Effect.runPromise(store.disposeAll().pipe(Effect.ignore))
            // Remove the discovery record so `opencode stop`/`attach` see it gone.
            if (_projectID) {
              try {
                Discovery.remove(_projectID)
              } catch {
                // ignore — best-effort cleanup
              }
            }
            if (_listenerStop) {
              try {
                await _listenerStop(true)
              } catch {
                // ignore
              }
            }
            process.exit(0)
          })
        })
      }),
    )
  }),
)

export const serverHandoffHandlers = HttpApiBuilder.group(InstanceHttpApi, "server-handoff", (handlers) =>
  Effect.gen(function* () {
    const statusSvc = yield* SessionStatus.Service
    const events = yield* EventV2Bridge.Service
    const scope = yield* Scope.Scope
    const authHeader = ServerAuth.header()

    const waitForIdle = (sessionID: SessionID): Effect.Effect<void> =>
      Effect.gen(function* () {
        // Eager registration via events.listen BEFORE checking current value.
        // subscribe() returns a lazy Stream whose PubSub subscription is only
        // established at run time, so subscribe→get would actually be get→subscribe
        // and could miss an Idle event fired in the gap — deadlocking the drain
        // (the next Idle only fires after the handoff prompt itself runs).
        const idle = yield* Deferred.make<void>()
        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== SessionStatus.Event.Idle.type) return Effect.void
          const data = event.data as { sessionID: string }
          if (data.sessionID === sessionID) {
            return Deferred.succeed(idle, undefined)
          }
          return Effect.void
        })
        return yield* Effect.gen(function* () {
          const current = yield* statusSvc.get(sessionID)
          if (current.type === "idle") return
          yield* Deferred.await(idle)
        }).pipe(
          Effect.ensuring(unsubscribe),
        )
      })

    return handlers.handle("handoff", (ctx: { payload: typeof HandoffPayload.Type }) =>
      Effect.gen(function* () {
        const { sessionID, prompts } = ctx.payload
        const directory = (yield* InstanceState.context).directory
        // Derive the self-POST base URL from the incoming request so the
        // drain targets the same listener that received this handoff.
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = Option.getOrElse(HttpServerRequest.toURL(request), () =>
          new URL(request.url, "http://localhost"),
        )
        const selfBaseUrl = `${url.protocol}//${url.host}/`

        // Fork the idle-wait + sequential drain into the long-lived scope so
        // 204 is returned immediately and the drain survives the request.
        const drain = Effect.gen(function* () {
          yield* waitForIdle(sessionID)
          const { Handoff } = yield* Effect.promise(() => import("@/server/handoff"))
          yield* Effect.promise(() =>
            Handoff.runHandoffDrain({
              baseUrl: selfBaseUrl,
              authHeader,
              directory,
              sessionID,
              prompts: prompts.map((p) => ({ parts: [...p.parts] })),
            }),
          )
        }).pipe(Effect.catchCause((cause) => Effect.logError("handoff drain failed", { sessionID, cause })))

        yield* drain.pipe(Effect.forkIn(scope, { startImmediately: true }))
        return HttpApiSchema.NoContent.make()
      }),
    )
  }),
)
