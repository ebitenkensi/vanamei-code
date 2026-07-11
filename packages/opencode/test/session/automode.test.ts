import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      SessionProjector.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

describe("Session automode", () => {
  it.instance("new session has automode undefined", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* Effect.acquireRelease(session.create({ title: "automode-test" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      expect(info.automode).toBeUndefined()

      const saved = yield* session.get(info.id)
      expect(saved.automode).toBeUndefined()
    }),
  )

  it.instance("setAutomode(true) → session.get returns automode === true", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* Effect.acquireRelease(session.create({ title: "automode-true" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      yield* session.setAutomode({ sessionID: info.id, automode: true })

      const saved = yield* session.get(info.id)
      expect(saved.automode).toBe(true)
    }),
  )

  it.instance("setAutomode(false) → automode === false", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* Effect.acquireRelease(session.create({ title: "automode-false" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      yield* session.setAutomode({ sessionID: info.id, automode: false })

      const saved = yield* session.get(info.id)
      expect(saved.automode).toBe(false)
    }),
  )

  it.instance("setAutomode toggles back to undefined", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* Effect.acquireRelease(session.create({ title: "automode-toggle" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      // Set true
      yield* session.setAutomode({ sessionID: info.id, automode: true })
      const afterTrue = yield* session.get(info.id)
      expect(afterTrue.automode).toBe(true)

      // Set false
      yield* session.setAutomode({ sessionID: info.id, automode: false })
      const afterFalse = yield* session.get(info.id)
      expect(afterFalse.automode).toBe(false)
    }),
  )
})
