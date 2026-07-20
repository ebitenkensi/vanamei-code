import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    // Detach child bootstrap: write the discovery record with our own pid/url,
    // register the listener stop for the server-side shutdown handler,
    // and wake durable sessions with pending inputs the parent left behind.
    // The parent spawned us with OPENCODE_DETACH_CHILD and the project info.
    if (process.env.OPENCODE_DETACH_CHILD) {
      const { Discovery } = yield* Effect.promise(() => import("../../server/discovery"))
      const { registerListener } = yield* Effect.promise(
        () => import("../../server/routes/instance/httpapi/handlers/server"),
      )
      const password = process.env.OPENCODE_SERVER_PASSWORD ?? ""
      const directory = process.env.OPENCODE_DIRECTORY ?? ""
      const projectID = process.env.OPENCODE_PROJECT_ID ?? ""
      Discovery.write({
        url: server.url.href,
        username: "opencode",
        password,
        pid: process.pid,
        directory,
        projectID,
        startedAt: new Date().toISOString(),
      })
      registerListener(server.stop, projectID)

      // Detach-child carry-forward: wake durable sessions with eligible (non-resume:false)
      // session_input rows that the parent admitted before /detach. The parent's drain
      // stopped at a safe boundary; this advisory wake picks up the durable queue. Wake
      // is idempotent — extra wakes are no-op. resume:false admit-only rows are intentionally
      // skipped (their caller deferred wake by design).
      //
      // We approximate "eligible" as "any session in the directory with undrained inputs"
      // since the DB schema does not persist the resume flag. Wake is advisory/idempotent,
      // so over-waking is safe. The in-process coordinator discards idle sessions immediately.
      if (directory) {
        // Wake durable sessions with pending (un-promoted) session_input rows.
        // We use a separate ManagedRuntime because SessionExecution.Service is
        // not available in the serve handler's AppRuntime layer.
        // Wake is advisory/idempotent, so best-effort is safe.
        const wakeSessions = async () => {
          const { Database } = await import("@opencode-ai/core/database/database")
          const execMod = await import("@opencode-ai/core/session/execution")
          const localMod = await import("@opencode-ai/core/session/execution/local")
          const lsmMod = await import("@opencode-ai/core/location-service-map")
          const lsMod = await import("@opencode-ai/core/location-services")
          const { AppNodeBuilderV1 } = await import("../../effect/app-node-builder-v1")
          const { ManagedRuntime } = await import("effect")
          const { LayerNode } = await import("@opencode-ai/core/effect/layer-node")
          const { memoMap } = await import("@opencode-ai/core/effect/memo-map")

          const locationServiceMap = lsMod.buildLocationServiceMap()
          // Group Database.node so the runtime provides Database.Service at the
          // top level — SessionExecutionLocal.node's internal provide chain
          // consumes it and does not re-export it for downstream effects.
          const execLayer = AppNodeBuilderV1.build(
            LayerNode.group([Database.node, localMod.SessionExecutionLocal.node]),
            [[lsmMod.LocationServiceMap.node, locationServiceMap]],
          )
          const rt = ManagedRuntime.make(execLayer, { memoMap })

          // Query sessions and wake eligible ones.
          const effect = Effect.gen(function* () {
            const dbSvc = yield* Database.Service
            const exec = yield* execMod.SessionExecution.Service
            const { SessionTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
            const { SessionInput } = yield* Effect.promise(() => import("@opencode-ai/core/session/input"))
            const { SessionSchema } = yield* Effect.promise(() => import("@opencode-ai/core/session/schema"))
            const { eq } = yield* Effect.promise(() => import("drizzle-orm"))

            const rows = yield* dbSvc.db
              .select({ id: SessionTable.id })
              .from(SessionTable)
              .where(eq(SessionTable.directory, directory))
              .all()
              .pipe(Effect.orDie)
            for (const row of rows) {
              const sessionID = SessionSchema.ID.make(row.id)
              const hasSteer = yield* SessionInput.hasPending(dbSvc.db, sessionID, "steer")
              const hasQueue = yield* SessionInput.hasPending(dbSvc.db, sessionID, "queue")
              if (hasSteer || hasQueue) {
                yield* exec.wake(sessionID)
              }
            }
          })

          await rt.runPromise(effect)
        }
        wakeSessions().catch((err: unknown) => console.error("detach-child wake error:", err))
      }
    }

    yield* Effect.never
  }),
})
