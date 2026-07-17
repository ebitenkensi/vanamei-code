import { cmd } from "./cmd"
import { UI } from "@/cli/ui"
import { Discovery } from "@/server/discovery"
import { Project } from "@/project/project"
import { Effect } from "effect"

export const StopCommand = cmd({
  command: "stop",
  describe: "stop a detached opencode server",
  builder: (yargs) =>
    yargs.option("force", {
      alias: ["f"],
      type: "boolean",
      describe: "force kill the server (SIGKILL instead of SIGTERM)",
    }),
  handler: async (args) => {
    const dir = process.cwd()
    const { AppRuntime } = await import("@/effect/app-runtime")
    const result = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const project = yield* Project.Service
        const info = yield* project.fromDirectory(dir)
        return info.project.id
      }),
    ).catch(() => undefined)

    if (!result) {
      UI.error("Failed to resolve project ID")
      process.exit(1)
    }

    const rec = Discovery.read(result)
    if (!rec) {
      UI.error(`No running server found for this project`)
      process.exit(1)
    }

    const signal = args.force ? "SIGKILL" : "SIGTERM"
    try {
      process.kill(rec.pid, signal)
    } catch (err) {
      UI.error(`Failed to send ${signal} to process ${rec.pid}: ${err}`)
      process.exit(1)
    }

    Discovery.remove(result)
    UI.println(`Sent ${signal} to server process ${rec.pid}`)
  },
})
