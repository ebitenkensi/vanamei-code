import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"

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

