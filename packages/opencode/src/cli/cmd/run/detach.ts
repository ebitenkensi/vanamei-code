import fs from "fs"
import path from "path"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { Global } from "@opencode-ai/core/global"
import { Discovery } from "@/server/discovery"
import { DetachState } from "@/cli/detach-state"

export type DetachInput = {
  directory: string
  projectID: string
  // Currently-active session at detach time, carried into the discovery
  // record so `opencode attach` can resume it.
  sessionID?: string
  live?: boolean
  onShutdown: () => Promise<void>
}

async function spawnDetachChild(input: DetachInput) {
  // In bun-dev mode (running `bun run src/index.ts`) process.argv[1] is the
  // entry script; pass it as an argument to `bun` (process.execPath).
  // In the compiled binary (ELF), process.execPath IS the binary itself,
  // so we always use process.execPath + optional script arg.
  const argv1 = process.argv[1]
  const needsScript = Boolean(argv1 && process.versions.bun && (argv1.endsWith(".ts") || argv1.endsWith(".mts")))
  const binary = process.execPath
  const scriptArg = needsScript ? [argv1] : []

  const password = crypto.randomBytes(24).toString("base64url")
  const logPath = path.join(Global.Path.log, `detach-${input.projectID}.log`)
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const logFd = fs.openSync(logPath, "a")

  const env = {
    ...process.env,
    OPENCODE_DETACH_CHILD: "1",
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DIRECTORY: input.directory,
    OPENCODE_PROJECT_ID: input.projectID,
    ...(input.sessionID ? { OPENCODE_DETACH_SESSION_ID: input.sessionID } : {}),
  }

  const child = spawn(binary, [...scriptArg, "serve", "--port", "0", "--hostname", "127.0.0.1"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env,
  })
  child.unref()

  // Wait briefly for the child to start and write the discovery record.
  // If the timeout elapses, the parent still exits — bash gets its prompt
  // back and the child will write the record eventually.
  const maxWait = 10000
  const pollInterval = 500
  for (let elapsed = 0; elapsed < maxWait; elapsed += pollInterval) {
    await new Promise((r) => setTimeout(r, pollInterval))
    const rec = Discovery.read(input.projectID)
    if (rec && rec.pid !== process.pid) return
  }
}

export async function executeDetach(input: DetachInput & { live: true }): Promise<void>
export async function executeDetach(input: DetachInput & { live?: false }): Promise<import("@/server/server").Listener>
export async function executeDetach(input: DetachInput): Promise<import("@/server/server").Listener | void> {
  // Live TTY /detach: spawn a detached child server and let parent exit.
  if (input.live) {
    await spawnDetachChild(input)
    return
  }

  // SIGHUP / terminal death: daemonize in place (existing behavior).
  const password = crypto.randomBytes(24).toString("base64url")
  process.env.OPENCODE_SERVER_PASSWORD = password

  // Daemonize FIRST, before any await: redirect stdout/stderr to a log file so
  // the TUI renderer cannot crash on a disconnected terminal while the event
  // loop is yielded during the dynamic import below.
  const logPath = path.join(Global.Path.log, `detach-${input.projectID}.log`)
  const logFd = fs.openSync(logPath, "a")
  const logWrite = (chunk: unknown) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer)
    if (buf.length > 0) fs.writeSync(logFd, buf)
  }
  process.stdout.write = logWrite as unknown as typeof process.stdout.write
  process.stderr.write = logWrite as unknown as typeof process.stderr.write

  // Release stdin
  process.stdin.pause()
  process.stdin.unref()

  const { Server } = await import("@/server/server")
  const listener = await Server.listen({ port: 0, hostname: "127.0.0.1" })

  Discovery.write({
    url: listener.url.href,
    username: "opencode",
    password,
    pid: process.pid,
    directory: input.directory,
    projectID: input.projectID,
    startedAt: new Date().toISOString(),
    sessionID: input.sessionID,
  })

  // Register listener stop for the server-side shutdown handler
  const { registerListener } = await import("@/server/routes/instance/httpapi/handlers/server")
  registerListener(listener.stop, input.projectID)

  // Ignore SIGHUP after detach
  process.on("SIGHUP", () => {})

  DetachState.activate()

  return listener
}

export * as DetachExec from "./detach"
