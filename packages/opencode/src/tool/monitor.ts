import * as Tool from "./tool"
import DESCRIPTION from "./monitor.txt"
import { ToolJsonSchema } from "./json-schema"
import type { TaskPromptOps } from "./task"
import { SessionID } from "../session/schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MonitorV1 } from "@opencode-ai/schema/monitor-v1"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Deferred, Effect, Option, Schema, Scope, Semaphore, Stream, Queue, Fiber, Context, Layer } from "effect"
import { ChildProcess, type ChildProcessSpawner as CPS } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const id = "monitor"

const Parameters = Schema.Struct({
  action: Schema.optional(
    Schema.Union([Schema.Literal("start"), Schema.Literal("list"), Schema.Literal("stop")]),
  ).annotate({
    description: "Action: start (default), list running monitors, or stop a monitor",
  }),
  command: Schema.optional(Schema.String).annotate({
    description: "Shell command to run (required for start)",
  }),
  description: Schema.optional(Schema.String).annotate({
    description: "Short description shown in list and notifications (required for start)",
  }),
  persistent: Schema.optional(Schema.Boolean).annotate({
    description: "If true, monitor lives for the session lifetime ignoring timeout",
  }),
  timeout_ms: Schema.optional(Schema.Number).annotate({
    description: "Timeout in milliseconds. Default 300000, max 3600000. Only for non-persistent monitors",
  }),
  monitor_id: Schema.optional(Schema.String).annotate({
    description: "Monitor ID to stop (required for stop)",
  }),
})

type MonitorEntry = {
  proc: CPS.ChildProcessHandle
  sessionID: SessionID | null
  description: string
  command: string
  persistent: boolean
  startedAt: number
  stderr: string
  agent: string
  promptOps: TaskPromptOps | null
  currentSessionID: SessionID | null
  pendingLines: string[]
  overflowWarningLogged: boolean
  semaphore: Semaphore.Semaphore // Serializes rebind/unbind/flusher mutations (Finding 2)
}

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
}

const MAX_STDERR = 4096
const DEFAULT_TIMEOUT_MS = 300_000
const MAX_TIMEOUT_MS = 3_600_000
const BATCH_WINDOW_MS = 500
const FLOOD_LIMIT = 20
const FLOOD_WINDOW_MS = 60_000
const FLOOD_BYTES = 1_048_576
const QUEUE_CAPACITY = 1_000
const MAX_PENDING_LINES = 100

function genMonitorID(): string {
  return "mon_" + Math.random().toString(36).slice(2)
}

function appendStderr(ring: string, chunk: string): string {
  const combined = ring + chunk
  if (Buffer.byteLength(combined, "utf-8") <= MAX_STDERR) return combined
  let bytes = Buffer.byteLength(combined, "utf-8")
  let idx = 0
  while (bytes > MAX_STDERR && idx < combined.length) {
    const charByte = Buffer.byteLength(combined[idx]!, "utf-8")
    bytes -= charByte
    idx++
  }
  return combined.slice(idx)
}

function makeShellEnv(sessionID: string | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(sessionID !== undefined ? { OPENCODE_SESSION_ID: sessionID } : {}),
  }
}

function killAll(entries: Map<string, MonitorEntry>): Effect.Effect<void> {
  if (entries.size === 0) return Effect.void
  return Effect.forEach(
    Array.from(entries.values()),
    (entry) => entry.proc.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.catch(() => Effect.void)),
    { discard: true },
  ).pipe(Effect.ignore)
}

function killEntry(entry: MonitorEntry): Effect.Effect<void> {
  return entry.proc.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.catch(() => Effect.void))
}

// --- MonitorAPI Service ---

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

// --- Layer ---

const layer = Layer.effect(
  MonitorAPI,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const scope = yield* Scope.Scope
    const events = yield* EventV2Bridge.Service

    const entries = new Map<string, MonitorEntry>()
    yield* Effect.addFinalizer(() => killAll(entries))

    function pushPendingLines(entry: MonitorEntry, lines: string[]): void {
      for (const line of lines) {
        if (entry.pendingLines.length >= MAX_PENDING_LINES) {
          if (!entry.overflowWarningLogged) {
            Effect.logWarning("monitor pending line buffer full, discarding oldest lines").pipe(
              Effect.ignore,
              Effect.runSync,
            )
            entry.overflowWarningLogged = true
          }
          // Discard oldest lines: shift from front
          entry.pendingLines.shift()
        }
        entry.pendingLines.push(line)
      }
    }

    const doInject = (
      monitorID: string,
      lines: string[],
    ): Effect.Effect<void> => {
      const entry = entries.get(monitorID)
      if (!entry) return Effect.void
      const ops = entry.promptOps
      const sessionID = entry.currentSessionID
      if (!ops || !sessionID) return Effect.void

      const label = `${entry.description} (${monitorID})`
      return Effect.gen(function* () {
        yield* ops
          .prompt({
            sessionID,
            agent: entry.agent,
            variant: undefined,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: `[monitor event] ${label}\n${lines.join("\n")}\n\nThis is an automated monitor notification, not user input. Act on it if needed.`,
              },
            ],
          })
          .pipe(Effect.ignore)
        yield* events
          .publish(MonitorV1.Event.Event, {
            sessionID,
            monitorID,
            description: label,
            lines,
          })
          .pipe(Effect.ignore)
      })
    }

    const doExitInject = (
      monitorID: string,
      monitorAgent: string,
      description: string,
      reason: "exit" | "timeout" | "flooded" | "stopped",
      exitCode: number | null,
    ): Effect.Effect<void> => {
      // Note: entry may have been deleted from entries map at this point.
      // Use the captured agent/promptOps/currentSessionID from the closure
      // rather than looking up from entries.
      const entry = entries.get(monitorID)
      if (!entry) return Effect.void
      const ops = entry.promptOps
      const sessionID = entry.currentSessionID
      if (!ops || !sessionID) return Effect.void

      return Effect.gen(function* () {
        yield* ops
          .prompt({
            sessionID,
            agent: monitorAgent,
            variant: undefined,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: `[monitor exited] ${description} (${monitorID}) reason=${reason} exit=${exitCode ?? "none"}`,
              },
            ],
          })
          .pipe(Effect.ignore)
      })
    }

    const startMonitor = (
      input: StartInput,
      promptOps?: TaskPromptOps,
    ): Effect.Effect<{ monitorID: string }> => {
      return Effect.gen(function* () {
        const persistent = input.persistent === true
        const timeoutMs = Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
        const monitorID = genMonitorID()
        const env = makeShellEnv(input.sessionID ?? undefined)

        const cmd = ChildProcess.make(input.command, [], {
          shell: true,
          cwd: process.cwd(),
          env,
          stdin: "ignore",
          detached: process.platform !== "win32",
        })

        const handle = yield* Scope.provide(scope)(spawner.spawn(cmd)).pipe(Effect.orDie)

        const entry: MonitorEntry = {
          proc: handle,
          sessionID: input.sessionID,
          description: input.description,
          command: input.command,
          persistent,
          startedAt: Date.now(),
          stderr: "",
          agent: input.agent,
          promptOps: promptOps ?? null,
          currentSessionID: promptOps ? (input.sessionID ?? null) : null,
          pendingLines: [],
          overflowWarningLogged: false,
          semaphore: Semaphore.makeUnsafe(1),
        }
        entries.set(monitorID, entry)

        // Background fiber: read stdout, batch, inject
        yield* Effect.gen(function* () {
          const queue = yield* Queue.dropping<string>(QUEUE_CAPACITY)
          const stamps: number[] = []
          const flooded = yield* Deferred.make<void>()

          // Reader: stdout chunks → lines → queue
          const decoder = new TextDecoder()
          let partial = ""
          let windowStart = Date.now()
          let windowBytes = 0
          let drainOnly = false

          const stdoutReader = yield* Effect.forkChild(
            Effect.gen(function* () {
              yield* Stream.runForEach(handle.stdout, (chunk) =>
                Effect.gen(function* () {
                  if (drainOnly) return
                  const now = Date.now()
                  if (now - windowStart >= FLOOD_WINDOW_MS) {
                    windowStart = now
                    windowBytes = 0
                  }
                  windowBytes += chunk.byteLength
                  if (windowBytes > FLOOD_BYTES) {
                    drainOnly = true
                    yield* Deferred.succeed(flooded, undefined)
                    return
                  }
                  partial += decoder.decode(chunk, { stream: true })
                  const lines = partial.split("\n")
                  partial = lines.pop() ?? ""
                  yield* Queue.offerAll(queue, lines).pipe(Effect.ignore)
                }),
              )
              if (partial.length > 0 && !drainOnly) yield* Queue.offer(queue, partial).pipe(Effect.ignore)
            }).pipe(Effect.ignore),
          )

          // Reader: stderr → ring buffer
          yield* Effect.forkChild(
            Stream.runForEach(Stream.decodeText(handle.stderr), (chunk) =>
              Effect.sync(() => {
                const e = entries.get(monitorID)
                if (e) e.stderr = appendStderr(e.stderr, chunk)
              }),
            ).pipe(Effect.ignore),
          )

          // Flusher: batch and inject every 500ms
          const flusher = yield* Effect.forkChild(
            Effect.gen(function* () {
              while (true) {
                yield* Effect.sleep(BATCH_WINDOW_MS)

                const items: string[] = []
                let next = yield* Queue.poll(queue)
                while (Option.isSome(next) && items.length < 10) {
                  items.push(next.value)
                  next = yield* Queue.poll(queue)
                }
                if (items.length === 0) continue

                // Flood check
                stamps.push(Date.now())
                while (stamps.length > 0 && stamps[0]! < Date.now() - FLOOD_WINDOW_MS) {
                  stamps.shift()
                }
                if (stamps.length > FLOOD_LIMIT) {
                  yield* Deferred.succeed(flooded, undefined)
                  return
                }

                // Check if bound; inject or queue (serialized via entry semaphore)
                const entry = entries.get(monitorID)
                if (entry) {
                  yield* entry.semaphore.withPermit(
                    Effect.gen(function* () {
                      const e = entries.get(monitorID)
                      if (!e) return
                      if (e.promptOps !== null) {
                        yield* doInject(monitorID, items)
                      } else {
                        pushPendingLines(e, items)
                      }
                    }),
                  )
                }
              }
            }),
          )

          // Wait for exit, timeout, or flood
          let reason: "exit" | "timeout" | "flooded" | "stopped" = "exit"
          const race: { tag: "exit"; code: number } | { tag: "timeout" } | { tag: "flooded" } = yield* Effect.raceAll([
            handle.exitCode.pipe(
              Effect.map((code): { tag: "exit"; code: number } => ({ tag: "exit", code: code as unknown as number })),
            ),
            Deferred.await(flooded).pipe(Effect.map((): { tag: "flooded" } => ({ tag: "flooded" }))),
            ...(persistent
              ? []
              : [Effect.sleep(timeoutMs).pipe(Effect.map((): { tag: "timeout" } => ({ tag: "timeout" })))]),
          ])

          let exitCode: number | null = null
          if (race.tag === "exit") exitCode = race.code
          if (race.tag === "timeout") {
            reason = "timeout"
            yield* killEntry(entry)
          }
          if (race.tag === "flooded") {
            reason = "flooded"
            yield* killEntry(entry)
          }

          yield* Fiber.interrupt(flusher).pipe(Effect.ignore)
          yield* Fiber.await(stdoutReader).pipe(Effect.ignore)

          if (!entries.has(monitorID)) return

          if (reason !== "flooded") {
            const remaining: string[] = []
            let rem = yield* Queue.poll(queue)
            while (Option.isSome(rem)) {
              remaining.push(rem.value)
              rem = yield* Queue.poll(queue)
            }
            if (remaining.length > 0) {
              const entry = entries.get(monitorID)
              if (entry) {
                yield* entry.semaphore.withPermit(
                  Effect.gen(function* () {
                    const e = entries.get(monitorID)
                    if (!e) return
                    if (e.promptOps !== null) {
                      yield* doInject(monitorID, remaining)
                    } else {
                      pushPendingLines(e, remaining)
                    }
                  }),
                )
              }
            }
          }

          const stoppedSessionID = entry.currentSessionID
          if (stoppedSessionID !== null) {
            yield* doExitInject(monitorID, entry.agent, entry.description, reason, exitCode)
            entries.delete(monitorID)
            yield* events
              .publish(MonitorV1.Event.Stopped, {
                sessionID: stoppedSessionID,
                monitorID,
                description: entry.description,
                reason,
                exitCode: exitCode ?? undefined,
              })
              .pipe(Effect.ignore)
          } else {
            entries.delete(monitorID)
            yield* Effect.logWarning(`monitor exited unbound: ${entry.description} (${monitorID})`).pipe(Effect.ignore)
          }
        }).pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))

        return { monitorID }
      })
    }

    const listMonitors = (sessionID: SessionID): Effect.Effect<MonitorEntryOutput[]> => {
      return Effect.sync(() => {
        return Array.from(entries.entries())
          .filter(([_, e]) => e.sessionID === sessionID || e.sessionID === null)
          .map(([monitorID, e]) => ({
            monitorID,
            description: e.description,
            command: e.command,
            persistent: e.persistent,
            startedAt: e.startedAt,
          }))
      })
    }

    const stopMonitor = (
      monitorID: string,
      sessionID: SessionID,
    ): Effect.Effect<{ description: string } | null> => {
      return Effect.gen(function* () {
        const entry = entries.get(monitorID)
        if (!entry || (entry.sessionID !== sessionID && entry.sessionID !== null)) {
          return null
        }
        entries.delete(monitorID)
        yield* killEntry(entry).pipe(Effect.ignore)
        yield* events
          .publish(MonitorV1.Event.Stopped, {
            sessionID,
            monitorID,
            description: entry.description,
            reason: "stopped",
            exitCode: undefined,
          })
          .pipe(Effect.ignore)
        return { description: entry.description }
      })
    }

    const rebind = (sessionID: SessionID, promptOps: TaskPromptOps): Effect.Effect<void> => {
      return Effect.forEach(
        Array.from(entries.entries()),
        ([monitorID, entry]) =>
          entry.semaphore.withPermit(
            Effect.gen(function* () {
              entry.promptOps = promptOps
              entry.currentSessionID = sessionID

              // Flush pending lines
              if (entry.pendingLines.length > 0) {
                const lines = [...entry.pendingLines]
                entry.pendingLines.length = 0
                yield* doInject(monitorID, lines)
              }
            }),
          ),
        { discard: true },
      )
    }

    const unbindForSession = (sessionID: SessionID): Effect.Effect<void> => {
      return Effect.forEach(
        Array.from(entries.entries()),
        ([_monitorID, entry]) =>
          entry.semaphore.withPermit(
            Effect.sync(() => {
              if (entry.currentSessionID === sessionID) {
                entry.promptOps = null
                entry.currentSessionID = null
              }
            }),
          ),
        { discard: true },
      )
    }

    return MonitorAPI.of({
      startMonitor,
      listMonitors,
      stopMonitor,
      rebind,
      unbindForSession,
    })
  }),
)

export const node = LayerNode.make({
  service: MonitorAPI,
  layer,
  deps: [CrossSpawnSpawner.node, EventV2Bridge.node],
})

// --- MonitorTool ---

export const MonitorTool = Tool.define(
  id,
  Effect.gen(function* () {
    const api = yield* MonitorAPI

    const run = (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ): Effect.Effect<Tool.ExecuteResult<Record<string, unknown>>> => {
      return Effect.gen(function* () {
        const action = params.action ?? "start"

        // --- list ---
        if (action === "list") {
          const entries = yield* api.listMonitors(ctx.sessionID)
          if (entries.length === 0) {
            return {
              title: "Monitor List",
              metadata: {},
              output: "no monitors running",
            }
          }
          const output = entries
            .map(
              (e) =>
                `- ${e.monitorID}: running | ${e.description} | ${e.persistent ? "persistent" : "non-persistent"} | ${new Date(e.startedAt).toISOString()} | ${e.command}`,
            )
            .join("\n")
          return {
            title: "Monitor List",
            metadata: {},
            output,
          }
        }

        // --- stop ---
        if (action === "stop") {
          if (!params.monitor_id) {
            return {
              title: "Monitor Stop",
              metadata: {},
              output: "error: monitor_id is required for stop",
            }
          }
          const result = yield* api.stopMonitor(params.monitor_id, ctx.sessionID)
          if (!result) {
            return {
              title: "Monitor Stop",
              metadata: {},
              output: `monitor ${params.monitor_id} not found`,
            }
          }
          return {
            title: `Monitor Stopped: ${result.description}`,
            metadata: { monitorID: params.monitor_id },
            output: `monitor ${params.monitor_id} (${result.description}) stopped`,
          }
        }

        // --- start (default) ---
        if (!params.command || !params.description) {
          return {
            title: "Monitor Start Error",
            metadata: {},
            output: "error: command and description are required for start",
          }
        }

        yield* ctx.ask({
          permission: id,
          patterns: [params.command],
          always: ["*"],
          metadata: {},
        })

        const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
        if (!ops) {
          return {
            title: "Monitor Start Error",
            metadata: {},
            output: "error: promptOps not available in context",
          }
        }

        const persistent = params.persistent === true
        const timeoutMs = Math.min(params.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)

        const { monitorID } = yield* api.startMonitor(
          {
            command: params.command,
            description: params.description,
            persistent,
            timeout_ms: timeoutMs,
            sessionID: ctx.sessionID,
            agent: ctx.agent,
          },
          ops, // bind immediately for LLM-started monitors
        )

        return {
          title: params.description,
          metadata: { monitorID, persistent } as Record<string, unknown>,
          output: [
            `Monitor started: ${params.description}`,
            `Monitor ID: ${monitorID}`,
            `Persistent: ${persistent}`,
            persistent ? "" : `Timeout: ${timeoutMs}ms`,
          ]
            .filter(Boolean)
            .join("\n"),
        }
      }).pipe(Effect.orDie) as any
    }

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      jsonSchema: ToolJsonSchema.fromSchema(Parameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

export * as Monitor from "./monitor"
