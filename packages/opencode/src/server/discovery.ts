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

export function remove(projectID: string) {
  try {
    fs.unlinkSync(recordPath(projectID))
  } catch {
    // ignore if already gone
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
