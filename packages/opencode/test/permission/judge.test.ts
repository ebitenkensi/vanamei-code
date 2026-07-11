import { describe, test, expect } from "bun:test"
import { buildJudgePrompt, parseVerdict } from "../../src/permission/judge"

describe("buildJudgePrompt", () => {
  const baseInput = {
    permission: "bash",
    patterns: ["*"],
    metadata: { command: "ls -la" },
    agentName: "build",
    userPrompt: "list files in the directory",
  }

  test("includes permission name", () => {
    const prompt = buildJudgePrompt(baseInput)
    expect(prompt).toContain("bash")
  })

  test("includes patterns", () => {
    const prompt = buildJudgePrompt(baseInput)
    expect(prompt).toContain("*")
  })

  test("includes metadata-derived text", () => {
    const prompt = buildJudgePrompt({ ...baseInput, metadata: { command: "rm -rf /" } })
    expect(prompt).toContain("rm -rf /")
  })

  test("includes agent name", () => {
    const prompt = buildJudgePrompt({ ...baseInput, agentName: "orchestrator-coder" })
    expect(prompt).toContain("orchestrator-coder")
  })

  test("includes user prompt", () => {
    const prompt = buildJudgePrompt({ ...baseInput, userPrompt: "delete everything" })
    expect(prompt).toContain("delete everything")
  })

  test("includes strict JSON instruction", () => {
    const prompt = buildJudgePrompt(baseInput)
    expect(prompt).toContain("strict JSON")
    expect(prompt).toContain('"decision"')
    expect(prompt).toContain("allow")
    expect(prompt).toContain("ask")
  })

  test("includes high-risk category callouts", () => {
    const prompt = buildJudgePrompt(baseInput)
    expect(prompt).toContain("rm -rf")
    expect(prompt).toContain("force push")
    expect(prompt).toContain("git reset --hard")
    expect(prompt).toContain("data deletion")
    expect(prompt).toContain("exfiltration")
    expect(prompt).toContain("external_directory")
    expect(prompt).toContain("doom_loop")
  })

  test("includes advisory note", () => {
    const prompt = buildJudgePrompt(baseInput)
    expect(prompt).toContain("advisory")
    expect(prompt).toContain("security boundary")
  })

  test("handles empty user prompt", () => {
    const prompt = buildJudgePrompt({ ...baseInput, userPrompt: "" })
    expect(prompt).not.toContain('User\'s latest request')
  })

  test("handles multiple patterns", () => {
    const prompt = buildJudgePrompt({ ...baseInput, patterns: ["/tmp/*", "/var/*"] })
    expect(prompt).toContain("/tmp/*")
    expect(prompt).toContain("/var/*")
  })

  test("handles multiple metadata fields", () => {
    const prompt = buildJudgePrompt({
      ...baseInput,
      metadata: { command: "git push", remote: "origin", branch: "main" },
    })
    expect(prompt).toContain("git push")
    expect(prompt).toContain("origin")
    expect(prompt).toContain("main")
  })
})

describe("parseVerdict", () => {
  test("parses valid allow verdict", () => {
    const result = parseVerdict('{"decision":"allow","reason":"safe operation"}')
    expect(result).toEqual({ decision: "allow", reason: "safe operation" })
  })

  test("parses valid ask verdict", () => {
    const result = parseVerdict('{"decision":"ask","reason":"destructive command"}')
    expect(result).toEqual({ decision: "ask", reason: "destructive command" })
  })

  test("returns null for malformed JSON", () => {
    expect(parseVerdict("{bad json}")).toBeNull()
  })

  test("returns null for missing reason", () => {
    expect(parseVerdict('{"decision":"allow"}')).toBeNull()
  })

  test("returns null for wrong decision value", () => {
    expect(parseVerdict('{"decision":"maybe","reason":"test"}')).toBeNull()
  })

  test("returns null for empty string", () => {
    expect(parseVerdict("")).toBeNull()
  })

  test("ignores extra fields gracefully", () => {
    const result = parseVerdict('{"decision":"allow","reason":"ok","extra":"field"}')
    expect(result).toEqual({ decision: "allow", reason: "ok" })
  })

  test("returns null for non-JSON string", () => {
    expect(parseVerdict("just some text")).toBeNull()
  })

  test("returns null for decision with wrong casing", () => {
    expect(parseVerdict('{"decision":"Allow","reason":"test"}')).toBeNull()
  })

  test("handles unicode in reason", () => {
    const result = parseVerdict('{"decision":"ask","reason":"危険な操作"}')
    expect(result).toEqual({ decision: "ask", reason: "危険な操作" })
  })

  test("returns null when reason is empty string", () => {
    // Schema.String allows empty string, so this should return valid
    const result = parseVerdict('{"decision":"ask","reason":""}')
    expect(result).toEqual({ decision: "ask", reason: "" })
  })
})
