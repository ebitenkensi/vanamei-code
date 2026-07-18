import * as Tool from "./tool"
import DESCRIPTION from "./monitor.txt"
import { ToolJsonSchema } from "./json-schema"
import type { TaskPromptOps } from "./task"
import { Session } from "@/session/session"
import { SessionID } from "../session/schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MonitorV1 } from "@opencode-ai/schema/monitor-v1"
import { Deferred, Effect, Option, Schema, Scope, Stream, Queue, Fiber } from "effect"
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
  sessionID: SessionID
  description: string
  command: string
  persistent: boolean
  startedAt: number
  stderr: string
}

const MAX_STDERR = 4096
const DEFAULT_TIMEOUT_MS = 300_000
const MAX_TIMEOUT_MS = 3_600_000
const BATCH_WINDOW_MS = 500
const FLOOD_LIMIT = 20
const FLOOD_WINDOW_MS = 60_000
const FLOOD_BYTES = 1_048_576
const QUEUE_CAPACITY = 1_000

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

function makeShellEnv(ctx: Tool.Context, extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCODE_SESSION_ID: ctx.sessionID,
    ...extraEnv,
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

export const MonitorTool = Tool.define(
  id,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const events = yield* EventV2Bridge.Service

    const entries = new Map<string, MonitorEntry>()
    yield* Effect.addFinalizer(() => killAll(entries))

    const run = (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ): Effect.Effect<Tool.ExecuteResult<Record<string, unknown>>> => {
      return Effect.gen(function* () {
        const action = params.action ?? "start"

        // --- list ---
        if (action === "list") {
          const sessionEntries = Array.from(entries.entries()).filter(([_, e]) => e.sessionID === ctx.sessionID)
          if (sessionEntries.length === 0) {
            return {
              title: "Monitor List",
              metadata: {},
              output: "no monitors running",
            }
          }
          const output = sessionEntries
            .map(
              ([monitorID, e]) =>
                `- ${monitorID}: running | ${e.description} | ${e.persistent ? "persistent" : "non-persistent"} | ${new Date(e.startedAt).toISOString()} | ${e.command}`,
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
          const entry = entries.get(params.monitor_id)
          if (!entry || entry.sessionID !== ctx.sessionID) {
            return {
              title: "Monitor Stop",
              metadata: {},
              output: `monitor ${params.monitor_id} not found`,
            }
          }
          entries.delete(params.monitor_id)
          yield* killEntry(entry)
          yield* events
            .publish(MonitorV1.Event.Stopped, {
              sessionID: ctx.sessionID,
              monitorID: params.monitor_id,
              description: entry.description,
              reason: "stopped",
              exitCode: undefined,
            })
            .pipe(Effect.ignore)
          return {
            title: `Monitor Stopped: ${entry.description}`,
            metadata: { monitorID: params.monitor_id },
            output: `monitor ${params.monitor_id} (${entry.description}) stopped`,
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

        const ops = ctx.extra?.promptOps as TaskPromptOps
        if (!ops) {
          return {
            title: "Monitor Start Error",
            metadata: {},
            output: "error: promptOps not available in context",
          }
        }

        const persistent = params.persistent === true
        const timeoutMs = Math.min(params.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
        const monitorID = genMonitorID()
        const env = makeShellEnv(ctx)

        const cmd = ChildProcess.make(params.command, [], {
          shell: true,
          cwd: process.cwd(),
          env,
          stdin: "ignore",
          detached: process.platform !== "win32",
        })

        // Tie the process to the tool-layer scope, not the per-call scope:
        // spawn's Scope requirement kills the child when its scope closes,
        // and the monitor must outlive the tool call that started it.
        const handle = yield* Scope.provide(scope)(spawner.spawn(cmd))

        const entry: MonitorEntry = {
          proc: handle,
          sessionID: ctx.sessionID,
          description: params.description,
          command: params.command,
          persistent,
          startedAt: Date.now(),
          stderr: "",
        }
        entries.set(monitorID, entry)

        // Background fiber: read stdout, batch, inject
        yield* Effect.gen(function* () {
          // Dropping queue so a flooding child (`yes hello`) cannot grow the
          // heap: the flusher drains at most 10 lines per 500ms, and an
          // unbounded queue fills memory faster than the flood guard can fire
          // (observed OOM kill). Dropped lines are fine — the guard kills a
          // flooding child anyway, and well-behaved monitors stay far below
          // capacity.
          const queue = yield* Queue.dropping<string>(QUEUE_CAPACITY)
          const stamps: number[] = []
          // Flood teardown must run in this fiber, not in the reader/flusher:
          // proc.kill waits for the stdio streams to close, so killing from
          // inside the stdout consumer deadlocks (nobody drains the pipe).
          const flooded = yield* Deferred.make<void>()

          // Readers and flusher are children of this background fiber (which
          // lives in the tool-layer scope) — forkScoped would attach them to
          // the per-call scope and interrupt them when the tool call returns.
          // Reader: stdout chunks → lines → queue, with a byte-rate guard.
          // Flood detection must happen at the chunk level, before line
          // splitting: a flooding child (`yes hello`) delivers bytes faster
          // than a per-line pipeline can process, so the heap balloons before
          // the downstream batch guard can fire (observed OOM kill).
          const decoder = new TextDecoder()
          let partial = ""
          let windowStart = Date.now()
          let windowBytes = 0
          // Once the byte guard trips, keep consuming chunks without decoding
          // so the pipe drains to EOF and the kill can complete.
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
              // Emit a final unterminated line so output without a trailing
              // newline is not lost at EOF.
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

                // Drain available lines (up to 10 per batch)
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

                // Inject batch
                yield* doInject(monitorID, items, ctx, ops, sessions)
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

          // Clean up flusher
          yield* Fiber.interrupt(flusher).pipe(Effect.ignore)

          // Let the stdout reader drain buffered output to EOF before the
          // final flush so lines written just before exit are not lost.
          yield* Fiber.await(stdoutReader).pipe(Effect.ignore)

          // The stop action already tore down the entry and published
          // monitor.stopped; don't publish a second stopped event for the
          // kill-induced exit.
          if (!entries.has(monitorID)) return

          // Flush remaining lines from queue, but not leftovers of a flood
          if (reason !== "flooded") {
            const remaining: string[] = []
            let rem = yield* Queue.poll(queue)
            while (Option.isSome(rem)) {
              remaining.push(rem.value)
              rem = yield* Queue.poll(queue)
            }
            if (remaining.length > 0) {
              yield* doInject(monitorID, remaining, ctx, ops, sessions)
            }
          }

          entries.delete(monitorID)
          yield* events
            .publish(MonitorV1.Event.Stopped, {
              sessionID: ctx.sessionID,
              monitorID,
              description: entry.description,
              reason,
              exitCode: exitCode ?? undefined,
            })
            .pipe(Effect.ignore)
          yield* doExitInject(monitorID, entry.description, reason, exitCode, ctx, ops, sessions)
        }).pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))

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

    function doInject(
      monitorID: string,
      lines: string[],
      ctx: Tool.Context,
      ops: TaskPromptOps,
      sessions: Session.Interface,
    ): Effect.Effect<void> {
      return Effect.gen(function* () {
        const session = yield* sessions.get(ctx.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined as any)))
        const agent = session?.agent ?? ctx.agent
        const entry = entries.get(monitorID)
        const label = entry ? `${entry.description} (${monitorID})` : monitorID
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent,
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
          .publish(MonitorV1.Event.Event, { sessionID: ctx.sessionID, monitorID, description: label, lines })
          .pipe(Effect.ignore)
      })
    }

    function doExitInject(
      monitorID: string,
      description: string,
      reason: "exit" | "timeout" | "flooded" | "stopped",
      exitCode: number | null,
      ctx: Tool.Context,
      ops: TaskPromptOps,
      sessions: Session.Interface,
    ): Effect.Effect<void> {
      return Effect.gen(function* () {
        const session = yield* sessions.get(ctx.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined as any)))
        const agent = session?.agent ?? ctx.agent
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent,
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

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      jsonSchema: ToolJsonSchema.fromSchema(Parameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
