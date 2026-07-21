import { Context, Effect } from "effect"
import type { TaskPromptOps } from "./task"
import { SessionID } from "../session/schema"

export type StartInput = {
  command: string
  description: string
  persistent?: boolean
  timeout_ms?: number
  oneshot?: boolean
  sessionID: SessionID | null
  agent: string
}

export type MonitorEntryOutput = {
  monitorID: string
  description: string
  command: string
  persistent: boolean
  startedAt: number
  oneshot: boolean
}

export interface MonitorAPIInterface {
  readonly startMonitor: (
    input: StartInput,
    promptOps?: TaskPromptOps,
  ) => Effect.Effect<{ monitorID: string }>
  readonly listMonitors: (sessionID: SessionID) => Effect.Effect<MonitorEntryOutput[]>
  readonly stopMonitor: (
    monitorID: string,
    sessionID: SessionID,
  ) => Effect.Effect<{ description: string } | null>
  readonly rebind: (sessionID: SessionID, promptOps: TaskPromptOps) => Effect.Effect<void>
  readonly unbindForSession: (sessionID: SessionID) => Effect.Effect<void>
}

export class MonitorAPI extends Context.Service<MonitorAPI, MonitorAPIInterface>()("@opencode/MonitorAPI") {}

export * as MonitorAPI_ from "./monitor-api"
