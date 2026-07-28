import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { OpencodeClient } from "@opencode-ai/sdk/v2"
import { runInteractiveMode } from "@/cli/cmd/run/runtime"
import type { FooterApi, FooterEvent, RunProvider, RunPrompt } from "@/cli/cmd/run/types"

type SessionMessage = NonNullable<Awaited<ReturnType<OpencodeClient["session"]["messages"]>>["data"]>[number]

const provider: RunProvider = {
  id: "openai",
  name: "OpenAI",
  source: "api",
  env: [],
  options: {},
  models: {
    "gpt-5": {
      id: "gpt-5",
      providerID: "openai",
      api: {
        id: "openai",
        url: "https://openai.test",
        npm: "@ai-sdk/openai",
      },
      name: "Little Frank",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        output: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        interleaved: false,
      },
      cost: {
        input: 0,
        output: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
      limit: {
        context: 128000,
        output: 8192,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
    },
  },
}

const transportProviders: RunProvider[][] = []

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function ok<T>(data: T) {
  return Promise.resolve({
    data,
    error: undefined,
    request: new Request("https://opencode.test"),
    response: new Response(),
  })
}

function footer(): FooterApi {
  let closed = false
  const closes = new Set<() => void>()

  const notify = () => {
    for (const fn of closes) fn()
  }

  return {
    get isClosed() {
      return closed
    },
    queued: [],
    onPrompt: () => () => {},
    onQueuedRemove: () => () => {},
    onClose(fn) {
      if (closed) {
        fn()
        return () => {}
      }

      closes.add(fn)
      return () => {
        closes.delete(fn)
      }
    },
    event() {},
    append() {},
    idle() {
      return Promise.resolve()
    },
    setThemeByName() {
      return Promise.resolve(false)
    },
    close() {
      if (closed) {
        return
      }

      closed = true
      notify()
    },
    destroy() {
      if (closed) {
        return
      }

      closed = true
      notify()
    },
  }
}

// Like footer() above, but records emitted events and exposes the registered
// prompt handler so a test can simulate the user submitting "/new".
function recordingFooter() {
  let closed = false
  const closes = new Set<() => void>()
  const events: FooterEvent[] = []
  let promptHandler: ((input: RunPrompt) => void) | undefined

  const notify = () => {
    for (const fn of [...closes]) fn()
  }

  const api: FooterApi = {
    get isClosed() {
      return closed
    },
    queued: [],
    onPrompt(fn) {
      promptHandler = fn
      return () => {
        if (promptHandler === fn) {
          promptHandler = undefined
        }
      }
    },
    onQueuedRemove: () => () => {},
    onClose(fn) {
      if (closed) {
        fn()
        return () => {}
      }

      closes.add(fn)
      return () => {
        closes.delete(fn)
      }
    },
    event(next) {
      events.push(next)
    },
    append() {},
    idle() {
      return Promise.resolve()
    },
    setThemeByName() {
      return Promise.resolve(false)
    },
    close() {
      if (closed) {
        return
      }

      closed = true
      notify()
    },
    destroy() {
      if (closed) {
        return
      }

      closed = true
      notify()
    },
  }

  return {
    api,
    events,
    // The runtime registers its prompt handler once the queue starts, so a test
    // that submits has to wait for this before calling submit().
    accepting() {
      return promptHandler !== undefined
    },
    submit(text: string) {
      promptHandler?.({ text, parts: [] })
    },
  }
}

// What `GET /session/{id}` returns for a session that has already run a turn:
// the server stamps agent/model/variant on every turn, and "default" is how it
// spells "no variant".
function sessionRecord(agent: string, variant = "default") {
  return {
    id: "ses-1",
    slug: "ses-1",
    projectID: "prj-1",
    directory: "/tmp",
    title: "Session",
    agent,
    model: {
      id: "gpt-5",
      providerID: "openai",
      variant,
    },
    version: "0.0.0",
    time: {
      created: 1,
      updated: 1,
    },
  }
}

async function waitFor(check: () => boolean, timeout = 1_000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (check()) {
      return
    }

    await Bun.sleep(10)
  }

  throw new Error("timed out waiting for condition")
}

afterEach(() => {
  mock.restore()
  transportProviders.length = 0
})

describe("run interactive runtime", () => {
  test("waits for provider metadata before eager replay transport bootstrap", async () => {
    const providersStarted = defer<void>()
    const providers = defer<void>()

    const sdk = new OpencodeClient()
    spyOn(sdk.config, "providers").mockImplementation(async () => {
      providersStarted.resolve()
      await providers.promise
      return ok({ providers: [provider], default: {} })
    })
    spyOn(sdk.session, "messages").mockImplementation(() =>
      ok([
        {
          info: {
            id: "msg-user-1",
            sessionID: "ses-1",
            role: "user",
            time: {
              created: 1,
            },
            agent: "build",
            model: {
              providerID: "openai",
              modelID: "gpt-5",
              variant: undefined,
            },
          },
          parts: [
            {
              id: "part-user-1",
              sessionID: "ses-1",
              messageID: "msg-user-1",
              type: "text",
              text: "hello",
            },
          ],
        } satisfies SessionMessage,
      ]),
    )
    spyOn(sdk.session, "get").mockRejectedValue(new Error("not needed"))
    spyOn(sdk.app, "agents").mockImplementation(() => ok([]))
    spyOn(sdk.experimental.resource, "list").mockImplementation(() => ok({}))
    spyOn(sdk.command, "list").mockImplementation(() => ok([]))

    const task = runInteractiveMode(
      {
        sdk,
        directory: "/tmp",
        sessionID: "ses-1",
        sessionTitle: "Session",
        resume: true,
        replay: true,
        replayLimit: 100,
        agent: "build",
        model: {
          providerID: "openai",
          modelID: "gpt-5",
        },
        variant: undefined,
        files: [],
        thinking: true,
        backgroundSubagents: false,
      },
      {
        createRuntimeLifecycle: async () => ({
          footer: footer(),
          onResize: () => () => {},
          refreshTheme: () => {},
          resetForReplay: () => Promise.resolve(),
          close: () => Promise.resolve(),
        }),
        streamTransport: Promise.resolve({
          createSessionTransport: async (input: { providers?: () => RunProvider[]; footer: FooterApi }) => {
            transportProviders.push(input.providers?.() ?? [])
            setTimeout(() => {
              input.footer.close()
            }, 0)
            return {
              runPromptTurn: async () => {},
              selectSubagent: () => {},
              replayOnResize: async () => false,
              close: async () => {},
            }
          },
          formatUnknownError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
        }),
      },
    )

    await providersStarted.promise

    expect(transportProviders).toEqual([])

    providers.resolve()

    await task

    expect(transportProviders).toEqual([[provider]])
  })

  test("/new resets todos and the modified-file pill instead of keeping the old session's state", async () => {
    const ui = recordingFooter()
    let createCalls = 0

    const sdk = new OpencodeClient()
    spyOn(sdk.app, "agents").mockImplementation(() => ok([]))
    spyOn(sdk.experimental.resource, "list").mockImplementation(() => ok({}))
    spyOn(sdk.command, "list").mockImplementation(() => ok([]))
    spyOn(sdk.config, "providers").mockImplementation(() => ok({ providers: [], default: {} }))
    spyOn(sdk.session, "todo").mockImplementation(() =>
      ok([{ status: "pending", content: "old todo", priority: "low" }]),
    )
    spyOn(sdk.session, "diff").mockImplementation(() => ok([{ file: "old.ts", additions: 1, deletions: 0 }]))

    const task = runInteractiveMode(
      {
        sdk,
        directory: "/tmp",
        sessionID: "ses-1",
        sessionTitle: "Session",
        resume: false,
        agent: "build",
        model: undefined,
        variant: undefined,
        files: [],
        thinking: true,
        backgroundSubagents: false,
        createSession: async () => {
          createCalls += 1
          return { id: "ses-2", title: "New" }
        },
      },
      {
        createRuntimeLifecycle: async () => ({
          footer: ui.api,
          onResize: () => () => {},
          refreshTheme: () => {},
          resetForReplay: () => Promise.resolve(),
          close: () => Promise.resolve(),
        }),
        streamTransport: Promise.resolve({
          createSessionTransport: async (input: { providers?: () => RunProvider[]; footer: FooterApi }) => {
            transportProviders.push(input.providers?.() ?? [])
            return {
              runPromptTurn: async () => {},
              selectSubagent: () => {},
              replayOnResize: async () => false,
              close: async () => {},
            }
          },
          formatUnknownError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
        }),
      },
    )

    // Wait for the first session's eager todo/diff fetch before triggering /new.
    await waitFor(() =>
      ui.events.some(
        (event) => event.type === "stream.todo" && event.todos.some((item) => item.content === "old todo"),
      ),
    )

    ui.submit("/new")

    await waitFor(() => createCalls === 1)
    await waitFor(() => ui.events.some((event) => event.type === "stream.todo" && event.todos.length === 0))
    await waitFor(() => ui.events.some((event) => event.type === "stream.patch" && event.patch.modified === 0))

    ui.api.close()
    await task

    const todoResetIndex = ui.events.findIndex((event) => event.type === "stream.todo" && event.todos.length === 0)
    const oldTodoIndex = ui.events.findIndex(
      (event) => event.type === "stream.todo" && event.todos.some((item) => item.content === "old todo"),
    )
    expect(oldTodoIndex).toBeGreaterThanOrEqual(0)
    expect(todoResetIndex).toBeGreaterThan(oldTodoIndex)
  })

  // `opencode attach` after a /detach passes no --agent and no --model, so what
  // the session was left on has to come back from the server record -- otherwise
  // the footer shows the default agent and "Model default", the next turn runs
  // as the default agent, and variant cycling is dead for want of a model.
  test("binds to the agent, model, and variant the attached session was left on", async () => {
    const sdk = new OpencodeClient()
    spyOn(sdk.app, "agents").mockImplementation(() => ok([]))
    spyOn(sdk.experimental.resource, "list").mockImplementation(() => ok({}))
    spyOn(sdk.command, "list").mockImplementation(() => ok([]))
    spyOn(sdk.config, "providers").mockImplementation(() => ok({ providers: [], default: {} }))
    spyOn(sdk.session, "get").mockImplementation(() => ok(sessionRecord("plan", "high")))

    const bound: Array<{ agent: string | undefined; model: unknown; variant: string | undefined }> = []
    let sent: { agent: string | undefined; model: unknown; variant: string | undefined } | undefined
    const ui = recordingFooter()

    const task = runInteractiveMode(
      {
        sdk,
        directory: "/tmp",
        sessionID: "ses-1",
        sessionTitle: "Session",
        resume: false,
        agent: undefined,
        model: undefined,
        variant: undefined,
        files: [],
        thinking: true,
        backgroundSubagents: false,
      },
      {
        createRuntimeLifecycle: async (options: {
          agent: string | undefined
          model: unknown
          variant: string | undefined
        }) => {
          bound.push({ agent: options.agent, model: options.model, variant: options.variant })
          return {
            footer: ui.api,
            onResize: () => () => {},
            refreshTheme: () => {},
            resetForReplay: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }
        },
        streamTransport: Promise.resolve({
          createSessionTransport: async () => ({
            runPromptTurn: async (input: {
              agent: string | undefined
              model: unknown
              variant: string | undefined
            }) => {
              sent = { agent: input.agent, model: input.model, variant: input.variant }
            },
            selectSubagent: () => {},
            replayOnResize: async () => false,
            close: async () => {},
          }),
          formatUnknownError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
        }),
      },
    )

    await waitFor(() => ui.accepting())
    ui.submit("hello")
    await waitFor(() => sent !== undefined)

    ui.api.close()
    await task

    const expected = { agent: "plan", model: { providerID: "openai", modelID: "gpt-5" }, variant: "high" }
    expect(bound).toEqual([expected])
    expect(sent).toEqual(expected)
  })

  // "default" is the server's spelling for "no variant"; carrying it through
  // verbatim would show a bogus "default" variant in the statusline and send it
  // back as if the user had picked it.
  test("treats the record's default variant as no variant", async () => {
    const sdk = new OpencodeClient()
    spyOn(sdk.app, "agents").mockImplementation(() => ok([]))
    spyOn(sdk.experimental.resource, "list").mockImplementation(() => ok({}))
    spyOn(sdk.command, "list").mockImplementation(() => ok([]))
    spyOn(sdk.config, "providers").mockImplementation(() => ok({ providers: [], default: {} }))
    spyOn(sdk.session, "get").mockImplementation(() => ok(sessionRecord("build")))

    const bound: Array<string | undefined> = []
    const ui = recordingFooter()

    const task = runInteractiveMode(
      {
        sdk,
        directory: "/tmp",
        sessionID: "ses-1",
        sessionTitle: "Session",
        resume: false,
        agent: undefined,
        model: undefined,
        variant: undefined,
        files: [],
        thinking: true,
        backgroundSubagents: false,
      },
      {
        createRuntimeLifecycle: async (options: { variant: string | undefined }) => {
          bound.push(options.variant)
          return {
            footer: ui.api,
            onResize: () => () => {},
            refreshTheme: () => {},
            resetForReplay: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }
        },
        streamTransport: Promise.resolve({
          createSessionTransport: async () => ({
            runPromptTurn: async () => {},
            selectSubagent: () => {},
            replayOnResize: async () => false,
            close: async () => {},
          }),
          formatUnknownError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
        }),
      },
    )

    await waitFor(() => bound.length === 1)

    ui.api.close()
    await task

    expect(bound).toEqual([undefined])
  })

  test("keeps an explicit agent over the one the session was left on", async () => {
    const sdk = new OpencodeClient()
    spyOn(sdk.app, "agents").mockImplementation(() => ok([]))
    spyOn(sdk.experimental.resource, "list").mockImplementation(() => ok({}))
    spyOn(sdk.command, "list").mockImplementation(() => ok([]))
    spyOn(sdk.config, "providers").mockImplementation(() => ok({ providers: [], default: {} }))
    spyOn(sdk.session, "get").mockImplementation(() => ok(sessionRecord("plan")))

    const bound: Array<string | undefined> = []
    const ui = recordingFooter()

    const task = runInteractiveMode(
      {
        sdk,
        directory: "/tmp",
        sessionID: "ses-1",
        sessionTitle: "Session",
        resume: false,
        agent: "build",
        model: undefined,
        variant: undefined,
        files: [],
        thinking: true,
        backgroundSubagents: false,
      },
      {
        createRuntimeLifecycle: async (options: { agent: string | undefined }) => {
          bound.push(options.agent)
          return {
            footer: ui.api,
            onResize: () => () => {},
            refreshTheme: () => {},
            resetForReplay: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }
        },
        streamTransport: Promise.resolve({
          createSessionTransport: async () => ({
            runPromptTurn: async () => {},
            selectSubagent: () => {},
            replayOnResize: async () => false,
            close: async () => {},
          }),
          formatUnknownError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
        }),
      },
    )

    await waitFor(() => bound.length === 1)

    ui.api.close()
    await task

    expect(bound).toEqual(["build"])
  })
})
