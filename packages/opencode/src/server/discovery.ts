import fs from "fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"

export type Record = {
  url: string
  username: string
  password: string
  pid: number
  directory: string
  projectID: string
  startedAt: string
  // Detach-time active session, used by `opencode attach` to resume the
  // same session instead of always creating a new one. Optional so older
  // records (written before this field existed) still parse.
  sessionID?: string
}

function recordPath(projectID: string) {
  return path.join(Global.Path.data, "server", projectID, "server.json")
}

export function write(record: Record) {
  const file = recordPath(record.projectID)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 })
}

export function read(projectID: string): Record | undefined {
  try {
    const file = recordPath(projectID)
    const raw = fs.readFileSync(file, "utf8")
    return JSON.parse(raw) as Record
  } catch {
    return undefined
  }
}

// Every record currently written by a detached server, newest first. Callers
// that need running servers must filter with `pidAlive` -- a record survives a
// SIGKILL, so presence alone proves nothing.
export function list(): Record[] {
  try {
    return fs
      .readdirSync(path.join(Global.Path.data, "server"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => read(entry.name))
      .filter((rec): rec is Record => rec !== undefined)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  } catch {
    return []
  }
}

// Records store `listener.url.href`, which always carries a trailing slash,
// while a url typed on the command line usually does not.
export function findByUrl(url: string): Record | undefined {
  const target = url.replace(/\/+$/, "")
  return list().find((rec) => rec.url.replace(/\/+$/, "") === target)
}

export function remove(projectID: string) {
  try {
    // server/<projectID> only ever holds server.json, so removing the whole
    // directory (not just the file) prevents it from being left behind forever.
    fs.rmSync(path.dirname(recordPath(projectID)), { recursive: true, force: true })
  } catch {
    // ignore if already gone
  }
}

// Reclaims server/<projectID> directories left behind by detached servers that
// exited without cleanup (crash, SIGKILL, older builds with no signal handlers).
// A directory is stale when its record is missing, unparsable, or names a pid
// that is no longer alive. Never throws -- meant to run opportunistically on
// every detach-child startup. Returns the number of directories removed.
export function sweep(): number {
  try {
    const root = path.join(Global.Path.data, "server")
    const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    const stale = dirs.filter((entry) => {
      const rec = read(entry.name)
      return !rec || !pidAlive(rec.pid)
    })
    stale.forEach((entry) => remove(entry.name))
    return stale.length
  } catch {
    return 0
  }
}

export async function healthCheck(url: string, password: string): Promise<boolean> {
  try {
    const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
    await fetch(url, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(5000),
    })
    // Any HTTP response (including 401, 404) means the server is alive
    return true
  } catch {
    return false
  }
}

export function pidAlive(pid: number): boolean {
  try {
    return process.kill(pid, 0)
  } catch {
    return false
  }
}

export async function resolve(projectID: string): Promise<Record> {
  const rec = read(projectID)
  if (!rec) throw new Error(`No discovery record found for project ${projectID}`)
  if (!pidAlive(rec.pid)) {
    remove(projectID)
    throw new Error(`Server process ${rec.pid} is not running (stale record deleted)`)
  }
  const alive = await healthCheck(rec.url, rec.password)
  if (!alive) {
    remove(projectID)
    throw new Error(`Server at ${rec.url} is unreachable (stale record deleted)`)
  }
  return rec
}

export * as Discovery from "./discovery"
