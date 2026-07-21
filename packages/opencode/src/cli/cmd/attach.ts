import { cmd } from "./cmd"
import { UI } from "@/cli/ui"
import { Discovery } from "@/server/discovery"
import { Project } from "@/project/project"
import { Effect } from "effect"

export const AttachCommand = cmd({
  command: "attach [url]",
  describe: "attach to a running opencode server",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        describe: "http://localhost:4096 (omit for auto-discovery from discovery record)",
        demandOption: false,
      })
      .option("dir", {
        type: "string",
        description: "directory to run in",
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

    let attachUrl = args.url
    let sessionHint: string | undefined

    // When URL is omitted, discover from the project's discovery record
    if (!attachUrl) {
      const dir = args.dir ?? process.cwd()
      const { AppRuntime } = await import("@/effect/app-runtime")
      const projectID = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const project = yield* Project.Service
          const info = yield* project.fromDirectory(dir)
          return info.project.id
        }),
      ).catch(() => undefined)

      if (!projectID) {
        UI.error("Failed to resolve project ID for auto-discovery")
        process.exit(1)
      }

      const rec = await Discovery.resolve(projectID)
      attachUrl = rec.url
      sessionHint = rec.sessionID

      // Inherit password from the discovery record if not explicitly provided
      if (!args.password) {
        args.password = rec.password
      }
      if (!args.username) {
        args.username = rec.username
      }
    }

    const directory = (() => {
      if (!args.dir) return undefined
      try {
        process.chdir(args.dir)
        return process.cwd()
      } catch {
        return args.dir
      }
    })()

    const { runMini } = await import("./run")
    await runMini({
      attach: attachUrl,
      directory,
      password: args.password,
      username: args.username,
      continue: args.continue,
      session: args.session,
      fork: args.fork,
      new: args.new,
      sessionHint,
      replay: noReplay ? false : undefined,
      replayLimit: args.replayLimit,
    })
  },
})
