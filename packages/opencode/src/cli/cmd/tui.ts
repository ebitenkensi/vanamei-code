import { cmd } from "@/cli/cmd/cmd"
import path from "path"
import { UI } from "@/cli/ui"
import { Filesystem } from "@/util/filesystem"

export function resolveThreadDirectory(project?: string, envPWD = process.env.PWD, cwd = process.cwd()) {
  const root = Filesystem.resolve(envPWD ?? cwd)
  if (project) return Filesystem.resolve(path.isAbsolute(project) ? project : path.join(root, project))
  return Filesystem.resolve(cwd)
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start opencode",
  builder: (yargs) =>
    yargs
      .positional("project", {
        type: "string",
        describe: "path to start opencode in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
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
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("attach", {
        type: "string",
        describe: "attach to a running opencode server (e.g., http://localhost:4096)",
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
      .option("port", {
        type: "number",
        describe: "port for the local server (defaults to random port if no value provided)",
      })
      .option("no-replay", {
        type: "boolean",
        describe: "disable mini session history replay on resume and after resize",
      })
      .option("replay-limit", {
        type: "number",
        describe: "cap visible mini replay to the newest N messages",
      })
      .option("replay", {
        type: "boolean",
        hidden: true,
      })
      .option("demo", {
        type: "boolean",
        hidden: true,
      })
      .option("mini", {
        type: "boolean",
        hidden: true,
        default: false,
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

    if (!process.stdout.isTTY) {
      UI.error("the interactive UI requires a TTY; use `opencode run <message>` for non-interactive runs")
      process.exitCode = 1
      return
    }

    const { runMini } = await import("./run")
    await runMini({
      directory: resolveThreadDirectory(args.project),
      continue: args.continue,
      session: args.session,
      fork: args.fork,
      model: args.model,
      agent: args.agent,
      prompt: args.prompt,
      attach: args.attach,
      password: args.password,
      username: args.username,
      port: args.port,
      replay: noReplay ? false : undefined,
      replayLimit: args.replayLimit,
      demo: args.demo,
    })
  },
})
