// V1→V2 promotion bridge (RENOVATION P3b): a prompt accepted by the instance
// httpapi must exist as a durable session_input row BEFORE V1 execution
// starts, and be marked promoted once V1 makes the user message visible.
// These tests exercise the real POST /session/:id/message (a.k.a. "prompt")
// and /session/:id/prompt_async routes end-to-end through handlers/session.ts,
// mirroring the harness in test/server/httpapi-session.test.ts.

import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { afterEach, describe, expect } from "bun:test"
import { Config, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Database } from "@opencode-ai/core/database/database"
import { SessionInputTable } from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { eq } from "drizzle-orm"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { Workspace } from "../../src/control-plane/workspace"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { MessageID } from "../../src/session/schema"
import { Session } from "@/session/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testProviderConfig } from "../lib/test-provider"
import { testEffect } from "../lib/effect"

const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([InstanceStore.node, Project.node, Session.node, Workspace.node, Database.node, Ripgrep.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

// Local test provider config, pointed at a URL that is never actually
// contacted — every request below uses noReply: true so admission and V1
// message visibility are exercised without invoking the LLM.
const config = testProviderConfig("http://localhost:1/v1")

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function createSession(input?: Session.CreateInput) {
  return Session.use.create(input)
}

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  if (response.status !== 200) return response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(text))))
  return response.json.pipe(Effect.map((value) => value as T))
}

function admittedRow(sessionID: string, messageID: MessageID) {
  return Database.Service.use(({ db }) =>
    db
      .select()
      .from(SessionInputTable)
      .where(eq(SessionInputTable.id, SessionMessage.ID.make(messageID)))
      .get()
      .pipe(
        Effect.orDie,
        Effect.map((row) => (row?.session_id === sessionID ? row : undefined)),
      ),
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("httpapi prompt admission bridge", () => {
  it.instance(
    "admits durably before execution and promotes exactly one visible user message",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "admission bridge" })
        const messageID = MessageID.make("msg_httpadmissiontest01")

        const response = yield* request(pathFor(SessionPaths.prompt, { sessionID: session.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({
            messageID,
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
          }),
        })
        expect(response.status).toBe(200)
        yield* json(response)

        const row = yield* admittedRow(session.id, messageID)
        expect(row).toMatchObject({ id: messageID, session_id: session.id, delivery: "steer" })
        expect(row?.promoted_seq).not.toBeNull()

        const messages = yield* Session.use.messages({ sessionID: session.id })
        const userMessages = messages.filter((message) => message.info.role === "user")
        expect(userMessages).toHaveLength(1)
        expect(userMessages[0]?.info.id).toBe(messageID)
      }),
    { git: true, config },
  )

  it.instance(
    "treats an exact message-ID retry as idempotent and rejects a mismatched retry",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "admission retry" })
        const messageID = MessageID.make("msg_httpadmissionretry1")
        const body = {
          messageID,
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        }

        const first = yield* request(pathFor(SessionPaths.prompt, { sessionID: session.id }), {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })
        expect(first.status).toBe(200)
        yield* json(first)

        const retried = yield* request(pathFor(SessionPaths.prompt, { sessionID: session.id }), {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })
        expect(retried.status).toBe(200)
        yield* json(retried)

        const messagesAfterRetry = yield* Session.use.messages({ sessionID: session.id })
        expect(messagesAfterRetry.filter((message) => message.info.role === "user")).toHaveLength(1)
        const rowAfterRetry = yield* admittedRow(session.id, messageID)
        expect(rowAfterRetry?.promoted_seq).not.toBeNull()

        const conflict = yield* request(pathFor(SessionPaths.prompt, { sessionID: session.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({ ...body, parts: [{ type: "text", text: "goodbye" }] }),
        })
        expect(conflict.status).toBe(400)

        const messagesAfterConflict = yield* Session.use.messages({ sessionID: session.id })
        expect(messagesAfterConflict.filter((message) => message.info.role === "user")).toHaveLength(1)
      }),
    { git: true, config },
  )

  it.instance(
    "prompt_async only returns 204 after admission succeeds",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "admission async" })
        const messageID = MessageID.make("msg_httpadmissionasync1")

        const accepted = yield* request(pathFor(SessionPaths.promptAsync, { sessionID: session.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({
            messageID,
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
          }),
        })
        expect(accepted.status).toBe(204)

        const row = yield* admittedRow(session.id, messageID)
        expect(row).toMatchObject({ id: messageID, session_id: session.id, delivery: "steer" })

        const conflict = yield* request(pathFor(SessionPaths.promptAsync, { sessionID: session.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({
            messageID,
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            noReply: true,
            parts: [{ type: "text", text: "goodbye" }],
          }),
        })
        expect(conflict.status).toBe(400)
      }),
    { git: true, config },
  )
})
