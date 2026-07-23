import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Discovery } from "@/server/discovery"

const serverRoot = path.join(Global.Path.data, "server")

// Outside Linux's default pid_max (4194304), so process.kill(pid, 0) reliably
// throws ESRCH without depending on any real process's lifecycle.
const DEAD_PID = 999_999_999

function makeProjectID(label: string) {
  return `discovery_sweep_test_${label}_${crypto.randomUUID()}`
}

function makeRecord(pid: number, projectID: string): Discovery.Record {
  return {
    url: "http://127.0.0.1:0",
    username: "opencode",
    password: "",
    pid,
    directory: "/tmp/discovery-sweep-test",
    projectID,
    startedAt: new Date().toISOString(),
  }
}

const created: string[] = []
afterEach(() => {
  for (const projectID of created.splice(0)) {
    fs.rmSync(path.join(serverRoot, projectID), { recursive: true, force: true })
  }
})

describe("Discovery.sweep", () => {
  test("keeps a directory whose record has a live pid", () => {
    const projectID = makeProjectID("live")
    created.push(projectID)
    Discovery.write(makeRecord(process.pid, projectID))

    const removed = Discovery.sweep()

    expect(removed).toBe(0)
    expect(fs.existsSync(path.join(serverRoot, projectID, "server.json"))).toBe(true)
  })

  test("removes a directory whose record has a dead pid", () => {
    const projectID = makeProjectID("dead")
    created.push(projectID)
    Discovery.write(makeRecord(DEAD_PID, projectID))

    const removed = Discovery.sweep()

    expect(removed).toBe(1)
    expect(fs.existsSync(path.join(serverRoot, projectID))).toBe(false)
  })

  test("removes a directory whose server.json is unparsable", () => {
    const projectID = makeProjectID("garbage")
    created.push(projectID)
    fs.mkdirSync(path.join(serverRoot, projectID), { recursive: true })
    fs.writeFileSync(path.join(serverRoot, projectID, "server.json"), "{ not json")

    const removed = Discovery.sweep()

    expect(removed).toBe(1)
    expect(fs.existsSync(path.join(serverRoot, projectID))).toBe(false)
  })

  test("removes an empty directory with no server.json", () => {
    const projectID = makeProjectID("empty")
    created.push(projectID)
    fs.mkdirSync(path.join(serverRoot, projectID), { recursive: true })

    const removed = Discovery.sweep()

    expect(removed).toBe(1)
    expect(fs.existsSync(path.join(serverRoot, projectID))).toBe(false)
  })
})

describe("Discovery.remove", () => {
  test("deletes the whole directory, not just server.json", () => {
    const projectID = makeProjectID("remove")
    created.push(projectID)
    Discovery.write(makeRecord(process.pid, projectID))
    expect(fs.existsSync(path.join(serverRoot, projectID))).toBe(true)

    Discovery.remove(projectID)

    expect(fs.existsSync(path.join(serverRoot, projectID))).toBe(false)
  })
})
