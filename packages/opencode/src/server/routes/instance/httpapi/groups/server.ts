import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { SessionID } from "@/session/schema"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

export const ServerShutdownApi = HttpApi.make("server-shutdown")
  .add(
    HttpApiGroup.make("server")
      .add(
        HttpApiEndpoint.post("shutdown", "/server/shutdown", {
          success: Schema.Void,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "server.shutdown",
            summary: "Shutdown the server",
            description: "Gracefully shutdown the detached server, disposing all instances and stopping the listener.",
          }),
        ),
      )
      .middleware(Authorization),
  )

// Instance-scoped handoff: accepts queued TUI prompts and replays them
// through the legacy prompt endpoint after the active turn finishes.
// 204 is returned immediately; the drain runs in a long-lived scope fiber.
export const HandoffPayload = Schema.Struct({
  sessionID: SessionID,
  prompts: Schema.Array(
    Schema.Struct({
      parts: Schema.Array(Schema.Unknown),
    }),
  ),
})

export const ServerHandoffApi = HttpApi.make("server-handoff")
  .add(
    HttpApiGroup.make("server-handoff")
      .add(
        HttpApiEndpoint.post("handoff", "/server/handoff", {
          query: WorkspaceRoutingQuery,
          payload: HandoffPayload,
          success: described(HttpApiSchema.NoContent, "Handoff accepted"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "server.handoff",
            summary: "Queue handoff",
            description:
              "Accept queued prompts from a detaching TUI client and replay them through the legacy prompt endpoint after the active turn finishes. Returns 204 immediately; the drain runs in the background.",
          }),
        ),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )

