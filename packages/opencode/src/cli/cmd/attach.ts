import { cmd } from "./cmd"
import { UI } from "@/cli/ui"
import { Discovery } from "@/server/discovery"
import { Project } from "@/project/project"
import { ServerAuth } from "@/server/auth"
import { Locale } from "@/util/locale"
import { isCancel, select } from "@clack/prompts"
import { Effect } from "effect"

export const AttachCommand = cmd({
  command: "attach [url]",
  describe: "attach to a running opencode server",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        describe: "http://localhost:4096 (omit to pick from the detached servers)",
        demandOption: false,
      })
      .option("dir", {
        type: "string",
        description: "attach to the detached server of this directory's project instead of picking one",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("new", {
        type: "boolean",
        describe: "always create a new session (skip the resume picker)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to OPENCODE_SERVER_PASSWORD)",
      })
      .option("username", {
        alias: ["u"],
        type: "string",
        describe: "basic auth username (defaults to OPENCODE_SERVER_USERNAME or 'opencode')",
      })
      .option("mini", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("replay", {
        type: "boolean",
        hidden: true,
      })
      .option("no-replay", {
        type: "boolean",
        describe: "disable mini session history replay on resume and after resize",
      })
      .option("replay-limit", {
        type: "number",
        describe: "cap visible mini replay to the newest N messages",
      }),
  handler: async (args) => {
    if (args.replay === true) {
      UI.error("--replay is not supported; replay is enabled by default")
      process.exitCode = 1
      return
    }
    const noReplay = args.replay === false || args.noReplay === true

    if (args.mini) {
      process.stderr.write("opencode: --mini is now the default and the flag is deprecated\n")
    }

    const target = await resolveTarget(args)

    // `--dir` still chdirs so relative `--file` paths resolve against it; the
    // picker path leaves the shell's cwd alone and takes the directory from
    // the chosen server's record instead.
    const directory = (() => {
      if (!args.dir) return target.directory
      try {
        process.chdir(args.dir)
        return process.cwd()
      } catch {
        return args.dir
      }
    })()

    const { runMini } = await import("./run")
    await runMini({
      attach: target.url,
      directory,
      password: args.password ?? target.password,
      username: args.username ?? target.username,
      continue: args.continue,
      session: args.session,
      fork: args.fork,
      new: args.new,
      sessionHint: target.sessionHint,
      sessionDirect: target.direct,
      replay: noReplay ? false : undefined,
      replayLimit: args.replayLimit,
    })
  },
})

type AttachTarget = {
  url: string
  password?: string
  username?: string
  sessionHint?: string
  directory?: string
  // Set when the server was chosen from the detached-server picker: the
  // choice already named a session, so the resume picker is skipped.
  direct?: boolean
}

// Precedence: an explicit url wins, then `--dir` scopes discovery to that one
// project (the pre-picker behavior), and a bare `opencode attach` picks from
// every detached server on the machine regardless of the current directory.
async function resolveTarget(args: { url?: string; dir?: string }): Promise<AttachTarget> {
  if (args.url) {
    const rec = Discovery.findByUrl(args.url)
    return {
      url: args.url,
      password: rec?.password,
      username: rec?.username,
      sessionHint: rec?.sessionID,
      directory: rec?.directory,
    }
  }

  if (args.dir) {
    const projectID = await resolveProjectID(args.dir)
    if (!projectID) {
      UI.error("Failed to resolve project ID for " + args.dir)
      process.exit(1)
    }

    const rec = await Discovery.resolve(projectID).catch((error: unknown) => {
      UI.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
    return {
      url: rec.url,
      password: rec.password,
      username: rec.username,
      sessionHint: rec.sessionID,
      directory: rec.directory,
    }
  }

  const picked = await pickDetachedServer()
  return {
    url: picked.rec.url,
    password: picked.rec.password,
    username: picked.rec.username,
    sessionHint: picked.rec.sessionID,
    directory: picked.rec.directory,
    direct: picked.direct,
  }
}

// Same @clack/prompts `select` the startup session picker uses (see
// run/session-picker.ts) -- arrow keys move, Enter confirms, Esc cancels.
// Always shown on a terminal, even for a single server, so the attach target
// is never picked invisibly.
async function pickDetachedServer(): Promise<{ rec: Discovery.Record; direct: boolean }> {
  const alive = Discovery.list().filter((rec) => Discovery.pidAlive(rec.pid))

  if (alive.length === 0) {
    UI.error("No detached opencode servers are running")
    UI.println(UI.Style.TEXT_DIM + "  Start one with: opencode, then /detach" + UI.Style.TEXT_NORMAL)
    process.exit(1)
  }

  // No picker without a terminal. Scripts keep the pre-picker behavior --
  // the only live server, else the current directory's project -- and the
  // resume picker downstream still arbitrates the session for them.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (alive.length === 1) return { rec: alive[0], direct: false }

    const projectID = await resolveProjectID(process.cwd())
    const local = projectID ? alive.find((rec) => rec.projectID === projectID) : undefined
    if (local) return { rec: local, direct: false }

    UI.error(`${alive.length} detached servers are running; pass a url or --dir to choose one`)
    alive.forEach((rec) => UI.println(UI.Style.TEXT_DIM + "  " + rec.url + "  " + rec.directory + UI.Style.TEXT_NORMAL))
    process.exit(1)
  }

  const described = await Promise.all(alive.map(async (rec) => ({ rec, title: await sessionTitle(rec) })))

  const picked = await select({
    message: "Attach to detached session",
    initialValue: alive[0].url,
    options: described.map((item) => ({
      value: item.rec.url,
      label: `${item.title ?? "No active session"} ${UI.Style.TEXT_DIM}${item.rec.directory}${UI.Style.TEXT_NORMAL}`,
      hint: `pid ${item.rec.pid} · up ${Locale.duration(Math.max(0, Date.now() - Date.parse(item.rec.startedAt)))}`,
    })),
  })

  if (isCancel(picked)) {
    UI.println(UI.Style.TEXT_DIM + "Attach cancelled." + UI.Style.TEXT_NORMAL)
    process.exit(0)
  }

  const chosen = alive.find((rec) => rec.url === picked)
  if (!chosen) {
    UI.error("Failed to resolve the selected server")
    process.exit(1)
  }
  return { rec: chosen, direct: chosen.sessionID !== undefined }
}

async function resolveProjectID(dir: string) {
  const { AppRuntime } = await import("@/effect/app-runtime")
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const project = yield* Project.Service
      const info = yield* project.fromDirectory(dir)
      return info.project.id
    }),
  ).catch(() => undefined)
}

// Best-effort label for the picker: an unreachable or slow server just loses
// its title rather than stalling the list.
async function sessionTitle(rec: Discovery.Record) {
  if (!rec.sessionID) return undefined
  const res = await fetch(`${rec.url.replace(/\/+$/, "")}/session/${rec.sessionID}`, {
    headers: {
      ...ServerAuth.headers({ password: rec.password, username: rec.username }),
      "x-opencode-directory": encodeURIComponent(rec.directory),
    },
    signal: AbortSignal.timeout(1500),
  }).catch(() => undefined)
  if (!res?.ok) return undefined
  const body = (await res.json().catch(() => undefined)) as { title?: string } | undefined
  return body?.title?.trim() || undefined
}
