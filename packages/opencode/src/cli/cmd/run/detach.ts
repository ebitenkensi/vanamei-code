import fs from "fs"
import path from "path"
import crypto from "node:crypto"
import { Global } from "@opencode-ai/core/global"
import { Discovery } from "@/server/discovery"
import { DetachState } from "@/cli/detach-state"

export type DetachInput = {
  directory: string
  projectID: string
  onShutdown: () => Promise<void>
}

export async function executeDetach(input: DetachInput) {
  const password = crypto.randomBytes(24).toString("base64url")
  process.env.OPENCODE_SERVER_PASSWORD = password

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
  })

  // Register listener stop for the server-side shutdown handler
  const { registerListener } = await import(
    "@/server/routes/instance/httpapi/handlers/server"
  )
  registerListener(listener.stop, input.projectID)

  // Daemonize: redirect stdout/stderr to a log file
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

  // Ignore SIGHUP after detach
  process.on("SIGHUP", () => {})

  DetachState.activate()

  return listener
}

export * as DetachExec from "./detach"
