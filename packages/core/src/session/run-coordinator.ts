export * as SessionRunCoordinator from "./run-coordinator"

import { Cause, Deferred, Effect, Exit, Fiber, FiberSet, Scope } from "effect"

/**
 * Serializes execution for each key while allowing different keys to run
 * concurrently. `work` joins an in-flight execution on the same key (every
 * joiner observes the same completion value); `run`/`wake` drive the
 * advisory drain. `interrupt` stops the drain owner; work execution is owned
 * by its calling fiber (see CLAUDE.md "V2 Session Core").
 */
export interface Coordinator<Key, E> {
  /** Snapshots keys with an execution owned by this coordinator. */
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /** Starts execution while idle or joins the active execution. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /**
   * Runs `work` under the key's join semantics: if work is already running on
   * `key`, the caller joins it and observes the same completion value
   * (success, error, or cancel-resolved value). Otherwise the caller starts
   * the work on its own fiber. The hand-off between "join" and "start" is
   * uninterruptible; a joiner interrupted in isolation only detaches from the
   * join and never cancels the running work. Conversely, a starter interrupted
   * while joiners wait cancels only its own turn — the joiners start the work
   * again rather than inheriting a cancel that belongs to another caller.
   * Calling `work` for a key from the fiber already running that key's work
   * would join itself, so it fails as a defect instead of deadlocking.
   */
  readonly work: <A, R>(key: Key, work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** Registers one coalesced follow-up after newly recorded work. */
  readonly wake: (key: Key) => Effect.Effect<void>
  /** Stops active drain execution and waits for its cleanup. */
  readonly interrupt: (key: Key) => Effect.Effect<void>
}

type Entry<E> = {
  readonly done: Deferred.Deferred<void, E>
  owner?: Fiber.Fiber<void, never>
  pendingWake: boolean
  stopping: boolean
}

// The single in-flight `work` execution for a key. `completion` carries the
// exit as a value rather than as its own success or failure, so awaiting it can
// never fail on the joiner's behalf and a joiner can tell a real outcome from
// the starter fiber merely being interrupted. It is typed `unknown` because one
// slot is shared by every `work` call on the key while `work` stays generic in
// `A`; `starter` is the id of the fiber running it, used to reject self-joins.
type WorkSlot<E> = {
  readonly starter: number | undefined
  readonly completion: Deferred.Deferred<Exit.Exit<unknown, E>>
}

export const make = <Key, E>(options: {
  readonly drain: (key: Key, force: boolean) => Effect.Effect<void, E>
}): Effect.Effect<Coordinator<Key, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const active = new Map<Key, Entry<E>>()
    const workSlots = new Map<Key, WorkSlot<E>>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()

    const makeEntry = (): Entry<E> => ({
      done: Deferred.makeUnsafe<void, E>(),
      pendingWake: false,
      stopping: false,
    })

    const start = (key: Key, entry: Entry<E>, force: boolean, successor = false) => {
      const ready = Deferred.makeUnsafe<void>()
      const owner = fork(
        (successor ? Effect.yieldNow : Deferred.await(ready)).pipe(
          Effect.andThen(Effect.suspend(() => options.drain(key, force))),
          Effect.onExit((exit) => Effect.sync(() => settle(key, entry, exit))),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      entry.owner = owner
      if (!successor) Deferred.doneUnsafe(ready, Effect.void)
    }

    const settle = (key: Key, entry: Entry<E>, exit: Exit.Exit<void, E>) => {
      if (Exit.isSuccess(exit) && !entry.stopping && entry.pendingWake) {
        entry.pendingWake = false
        start(key, entry, false, true)
        return
      }

      const successor = entry.pendingWake ? makeEntry() : undefined
      if (successor === undefined) active.delete(key)
      else {
        active.set(key, successor)
        start(key, successor, false, true)
      }
      Deferred.doneUnsafe(entry.done, exit)
    }

    const run = (key: Key): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) => {
        const entry = active.get(key)
        if (entry !== undefined) {
          if (entry.stopping) return restore(Deferred.await(entry.done).pipe(Effect.andThen(run(key))))
          return restore(Deferred.await(entry.done))
        }

        const next = makeEntry()
        active.set(key, next)
        start(key, next, true)
        return restore(Deferred.await(next.done))
      })

    const work = <A, R>(key: Key, w: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const current = Fiber.getCurrent()?.id
          // Join: if work is already running on this key, share its completion.
          const slot = workSlots.get(key)
          if (slot !== undefined) {
            if (current !== undefined && current === slot.starter)
              return yield* Effect.die(
                `SessionRunCoordinator.work: reentrant work on key ${String(key)} would join itself; call work on a distinct key or after the current turn completes`,
              )
            const exit = yield* restore(Deferred.await(slot.completion))
            // Pure interruption is the starter fiber going away, not an outcome
            // of the work, so start it again instead of cancelling this caller.
            if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return yield* work(key, w)
            return yield* exit as Exit.Exit<A, E>
          }

          const entry = makeEntry()
          const completion = Deferred.makeUnsafe<Exit.Exit<unknown, E>>()
          active.set(key, entry)
          workSlots.set(key, { starter: current, completion })

          return yield* restore(w).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                workSlots.delete(key)
                Deferred.doneUnsafe(completion, Exit.succeed(exit))
                settle(key, entry, Exit.asVoid(exit))
              }),
            ),
          )
        }),
      )

    const wake = (key: Key) =>
      Effect.sync(() => {
        const entry = active.get(key)
        if (entry !== undefined) {
          entry.pendingWake = true
          return
        }

        const next = makeEntry()
        active.set(key, next)
        start(key, next, false)
      })

    const interrupt = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        if (entry?.owner === undefined) return Effect.void
        entry.stopping = true
        entry.pendingWake = false
        return Fiber.interrupt(entry.owner)
      })

    return { active: Effect.sync(() => new Set(active.keys())), run, work, wake, interrupt }
  })
