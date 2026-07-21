export * as ConfigMonitorV1 from "./monitor"

import { Schema } from "effect"

export const AutostartEntry = Schema.Struct({
  command: Schema.String.annotate({ description: "Shell command to run" }),
  description: Schema.String.annotate({
    description: "Short description shown in list and notifications",
  }),
  persistent: Schema.optional(Schema.Boolean),
  timeout_ms: Schema.optional(Schema.Number),
  oneshot: Schema.optional(Schema.Boolean),
})

export const Info = Schema.Struct({
  autostart: Schema.optional(
    Schema.mutable(Schema.Array(AutostartEntry)),
  ).annotate({
    description:
      "Monitors to start deterministically at session bootstrap (no LLM in the loop)",
  }),
}).annotate({ identifier: "MonitorConfig" })
export type Info = Schema.Schema.Type<typeof Info>
