export * as ConfigServerV1 from "./server"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "../../schema"

export const Server = Schema.Struct({
  port: Schema.optional(PositiveInt).annotate({
    description: "Port to listen on",
  }),
  hostname: Schema.optional(Schema.String).annotate({ description: "Hostname to listen on" }),
  mdns: Schema.optional(Schema.Boolean).annotate({ description: "Enable mDNS service discovery" }),
  mdnsDomain: Schema.optional(Schema.String).annotate({
    description: "Custom domain name for mDNS service (default: opencode.local)",
  }),
  cors: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Additional domains to allow for CORS",
  }),
  idleTimeoutMinutes: Schema.optional(NonNegativeInt).annotate({
    description:
      "Minutes of inactivity (no HTTP requests and no SSE subscribers) before a detached server shuts itself down. 0 disables idle shutdown. Defaults to 240.",
  }),
}).annotate({ identifier: "ServerConfig" })
export type Server = Schema.Schema.Type<typeof Server>
