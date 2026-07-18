import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceStore } from "@/project/instance-store"
import { Discovery } from "@/server/discovery"
import { ServerShutdownApi } from "../groups/server"

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
