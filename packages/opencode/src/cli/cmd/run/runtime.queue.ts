// Serial prompt queue for direct interactive mode.
//
// Prompts arrive from the footer (user types and hits enter) and queue up
// here. The queue drains one turn at a time; ordinary prompts waiting behind
// an active ordinary turn are exposed for edit/removal until they begin.
//
// The queue also handles /exit, /quit, and /new commands, empty-prompt rejection,
// and tracks per-turn wall-clock duration for the footer status line.
//
// Resolves when the footer closes and all in-flight work finishes.
import * as Locale from "@/util/locale"
import { MessageID, PartID } from "@/session/schema"
import { isExitCommand, isNewCommand, isDetachCommand, isShutdownCommand, isCompactCommand } from "./prompt.shared"
import type { FooterApi, FooterEvent, FooterQueuedPrompt, RunPrompt } from "./types"

type Trace = {
  write(type: string, data?: unknown): void
}

type Deferred<T = void> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (error?: unknown) => void
}

export type QueueInput = {
  footer: FooterApi
  initialInput?: string
  trace?: Trace
  onSend?: (prompt: RunPrompt) => void
  onNewSession?: () => void | Promise<void>
  onDetach?: (live?: boolean, queued?: FooterQueuedPrompt[]) => Promise<void>
  // When true, /detach acts immediately: snapshots the current queue and calls
  // onDetach synchronously without waiting for the active turn to finish.
  // Used by the detachable server-first startup path where the turn lives in
  // the server process; the legacy local mode leaves this undefined/false and
  // keeps the whenIdle() deferred behavior.
  detachImmediate?: boolean
  onShutdown?: () => Promise<void>
  // Fires manual compaction for the current session. Rejected with a status
  // notice (and dropped, not queued) while a turn is active, since the
  // summarize handler drives its own V1 prompt loop server-side and must not
  // run concurrently with an ordinary turn.
  onCompact?: () => Promise<void>
  // If provided, normal exits (/exit, Ctrl+C double-press) run this before
  // closing. Only the detachable startup path sets this; plain --attach
  // leaves it undefined so exit only leaves the client.
  onExit?: () => void | Promise<void>
  run: (prompt: RunPrompt, signal: AbortSignal) => Promise<void>
}

type State = {
  queue: RunPrompt[]
  queued: FooterQueuedPrompt[]
  active?: RunPrompt
  ctrl?: AbortController
  closed: boolean
}

function defer<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })

  return { promise, resolve, reject }
}

// Runs the prompt queue until the footer closes.
//
// Subscribes to footer prompt events and drains operations through input.run().
// Ordinary prompts submitted during an ordinary active turn remain local and
// are exposed by the footer for edit/removal until their turn begins.
export async function runPromptQueue(input: QueueInput): Promise<void> {
  const stop = defer<{ type: "closed" }>()
  const done = defer()
  const state: State = {
    queue: [],
    queued: [],
    closed: input.footer.isClosed,
  }
  let draining: Promise<void> | undefined
  let detaching = false

  const emit = (next: FooterEvent, row: Record<string, unknown>) => {
    input.trace?.write("ui.patch", row)
    input.footer.event(next)
  }

  const syncQueue = () => {
    const queue = state.queue.length
    emit({ type: "queue", queue }, { queue })
    emit(
      {
        type: "queued.prompts",
        prompts: [...state.queued],
      },
      { queued: state.queued.length },
    )
  }

  const removeLocalQueued = (queued: FooterQueuedPrompt) => {
    if (!state.queued.includes(queued)) return
    state.queued = state.queued.filter((item) => item !== queued)
    syncQueue()
  }

  const finish = () => {
    if (!state.closed || draining) {
      return
    }

    done.resolve()
  }

  const close = () => {
    if (state.closed) {
      return
    }

    state.closed = true
    state.queue.length = 0
    state.queued.length = 0
    state.ctrl?.abort()
    stop.resolve({ type: "closed" })
    finish()
  }

  // Resolves when any in-flight turn finishes and no new turn will start
  // (because detaching stops promotion).
  const whenIdle = (): Promise<void> =>
    state.active === undefined
      ? Promise.resolve()
      : new Promise((resolve) => {
          const iv = setInterval(() => {
            if (state.active === undefined) {
              clearInterval(iv)
              resolve()
            }
          }, 200)
        })

  const drain = () => {
    if (draining || state.closed || state.queue.length === 0) {
      return
    }

    draining = (async () => {
      try {
        while (!state.closed && state.queue.length > 0) {
          if (detaching) {
            // set on /detach to stop promoting queued inputs; the in-flight turn
            // finishes naturally, then submit()'s /detach branch snapshots the
            // remaining queue into a handoff file the spawned child reads on
            // boot and executes itself through its own legacy prompt path.
            break
          }

          const prompt = state.queue.shift()
          if (!prompt) {
            continue
          }

          const queued = state.queued.find((item) => item.prompt === prompt)
          if (queued) removeLocalQueued(queued)

          if (prompt.mode !== "shell" && isNewCommand(prompt.text)) {
            syncQueue()
            if (!input.onNewSession) {
              emit(
                {
                  type: "stream.patch",
                  patch: {
                    status: "new sessions unavailable",
                  },
                },
                {
                  status: "new sessions unavailable",
                },
              )
              continue
            }

            emit(
              {
                type: "stream.patch",
                patch: {
                  phase: "running",
                  status: "starting new session",
                  queue: state.queue.length,
                },
              },
              {
                phase: "running",
                status: "starting new session",
                queue: state.queue.length,
              },
            )
            await input.onNewSession()
            continue
          }

          const sent =
            prompt.mode === "shell"
              ? prompt
              : {
                  ...prompt,
                  messageID: prompt.messageID ?? queued?.messageID ?? MessageID.ascending(),
                }
          state.active = sent

          emit(
            {
              type: "turn.send",
              queue: state.queue.length,
            },
            {
              phase: "running",
              status: "sending prompt",
              queue: state.queue.length,
            },
          )
          const start = Date.now()
          const ctrl = new AbortController()
          state.ctrl = ctrl

          try {
            await input.footer.idle()
            if (state.closed) {
              break
            }

            if (sent.mode !== "shell") {
              const commit = {
                kind: "user",
                text: sent.text,
                phase: "start",
                source: "system",
                messageID: sent.messageID,
              } as const
              input.trace?.write("ui.commit", commit)
              input.footer.append(commit)
            }
            input.onSend?.(sent)

            if (state.closed) {
              break
            }

            const task = input.run(sent, ctrl.signal).then(
              () => ({ type: "done" as const }),
              (error) => ({ type: "error" as const, error }),
            )

            const next = await Promise.race([task, stop.promise])
            if (next.type === "closed") {
              ctrl.abort()
              break
            }

            if (next.type === "error") {
              throw next.error
            }
          } finally {
            if (state.ctrl === ctrl) {
              state.ctrl = undefined
            }

            if (sent.mode !== "shell") {
              const duration = Locale.duration(Math.max(0, Date.now() - start))
              emit(
                {
                  type: "turn.duration",
                  duration,
                },
                {
                  duration,
                },
              )
            }
            state.active = undefined
          }
        }
      } catch (error) {
        done.reject(error)
        return
      } finally {
        draining = undefined
        emit(
          {
            type: "turn.idle",
            queue: state.queue.length,
          },
          {
            phase: "idle",
            status: "",
            queue: state.queue.length,
          },
        )
      }

      finish()
    })()
  }

  const submit = (prompt: RunPrompt) => {
    if (!prompt.text.trim() || state.closed) {
      return
    }

    if (prompt.mode !== "shell" && isExitCommand(prompt.text)) {
      if (input.onExit) {
        const fn = input.onExit
        input.onExit = undefined // guard: only one exit shutdown per session
        void Promise.resolve(fn()).finally(() => input.footer.close())
        return
      }
      input.footer.close()
      return
    }

    if (prompt.mode !== "shell" && isDetachCommand(prompt.text)) {
      if (input.onDetach) {
        const fn = input.onDetach
        input.onDetach = undefined // guard: only one detach per session
        // Stop promoting queued inputs immediately (synchronous, no await).
        detaching = true

        // Snapshot the queue in order. For the immediate path this is taken
        // synchronously; for the legacy deferred path the snapshot is taken
        // inside runDetach (after whenIdle resolves) so it reflects the queue
        // at hand-off time, matching the pre-detachImmediate behavior exactly.
        const snapshot = (): FooterQueuedPrompt[] =>
          state.queue.map(
            (item) =>
              state.queued.find((queued) => queued.prompt === item) ?? {
                messageID: MessageID.ascending(),
                partID: PartID.ascending(),
                prompt: item,
              },
          )

        const runDetach = async (queued: FooterQueuedPrompt[]) => {
          try {
            await fn(true, queued)
          } catch (error) {
            // Abort the detach: restore the pre-detach state so the local
            // queue keeps draining instead of silently losing prompts.
            detaching = false
            input.onDetach = fn
            const status = `detach failed: ${error instanceof Error ? error.message : String(error)}`
            // The status line is overwritten as soon as the drain resumes, so
            // also commit a permanent scrollback row the user can still read.
            input.footer.append({ kind: "error", text: status, phase: "start", source: "system" })
            emit({ type: "stream.patch", patch: { status } }, { status })
            drain()
            return
          }

          input.footer.close()
        }

        if (input.detachImmediate) {
          void runDetach(snapshot())
        } else {
          // Legacy local mode: the in-flight turn must finish first because the
          // turn lives in this process and the spawned child takes over. Wait
          // for idle, then snapshot and hand off.
          void whenIdle().then(() => runDetach(snapshot()))
        }
      }
      return
    }

    if (prompt.mode !== "shell" && isShutdownCommand(prompt.text)) {
      if (input.onShutdown) {
        const fn = input.onShutdown
        input.onShutdown = undefined // guard: only one shutdown per session
        void fn().then(() => input.footer.close())
      }
      return
    }

    if (prompt.mode !== "shell" && isCompactCommand(prompt.text)) {
      if (!input.onCompact) {
        const status = "compact unavailable"
        emit({ type: "stream.patch", patch: { status } }, { status })
        return
      }

      if (state.active) {
        const status = "compact: wait for the current turn to finish"
        emit({ type: "stream.patch", patch: { status } }, { status })
        return
      }

      const fn = input.onCompact
      state.active = prompt
      emit(
        { type: "stream.patch", patch: { phase: "running", status: "compacting session" } },
        { phase: "running", status: "compacting session" },
      )

      const runCompact = async () => {
        try {
          await fn()
        } catch (error) {
          const status = `compact failed: ${error instanceof Error ? error.message : String(error)}`
          input.footer.append({ kind: "error", text: status, phase: "start", source: "system" })
          emit({ type: "stream.patch", patch: { status } }, { status })
        } finally {
          state.active = undefined
          emit({ type: "stream.patch", patch: { phase: "idle", status: "" } }, { phase: "idle", status: "" })
          drain()
        }
      }

      void runCompact()
      return
    }

    const active = state.active
    if (
      active &&
      active.mode !== "shell" &&
      !active.command &&
      prompt.mode !== "shell" &&
      !prompt.command &&
      !isNewCommand(prompt.text)
    ) {
      const queued: FooterQueuedPrompt = {
        messageID: MessageID.ascending(),
        partID: PartID.ascending(),
        prompt,
      }
      state.queued = [...state.queued, queued]
      state.queue.push(prompt)
      syncQueue()
      return
    }

    state.queue.push(prompt)
    syncQueue()
    if (prompt.mode !== "shell" && isNewCommand(prompt.text)) {
      drain()
      return
    }

    emit(
      {
        type: "first",
        first: false,
      },
      {
        first: false,
      },
    )
    drain()
  }

  const offPrompt = input.footer.onPrompt((prompt) => {
    submit(prompt)
  })
  const offClose = input.footer.onClose(() => {
    close()
  })
  const offRemoveQueued = input.footer.onQueuedRemove((messageID) => {
    const queued = state.queued.find((item) => item.messageID === messageID)
    if (!queued) return false
    state.queue = state.queue.filter((prompt) => prompt !== queued.prompt)
    removeLocalQueued(queued)
    return true
  })

  try {
    if (state.closed) {
      return
    }

    submit({
      text: input.initialInput ?? "",
      parts: [],
    })
    finish()
    await done.promise
  } finally {
    offPrompt()
    offClose()
    offRemoveQueued()
    close()
    await draining?.catch(() => {})
  }
}
