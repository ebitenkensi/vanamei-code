export * as MonitorV1 from "./monitor"

import { Schema } from "effect"
import { define, inventory } from "../event"
import { optional, statics } from "../schema"
import { SessionID } from "../session-id"

const EventDef = define({
  type: "monitor.event",
  schema: {
    sessionID: SessionID,
    monitorID: Schema.String,
    description: Schema.String,
    lines: Schema.Array(Schema.String),
  },
})

const StoppedDef = define({
  type: "monitor.stopped",
  schema: {
    sessionID: SessionID,
    monitorID: Schema.String,
    description: Schema.String,
    reason: Schema.Literals(["exit", "timeout", "flooded", "stopped"]),
    exitCode: optional(Schema.Number),
  },
})

export const Event = { Event: EventDef, Stopped: StoppedDef, Definitions: inventory(EventDef, StoppedDef) }
