// Sequential handoff drain: replays queued TUI prompts through the legacy
// synchronous prompt endpoint (POST /session/{id}/message) one at a time,
// waiting for each turn to finish before sending the next. Both the
// detach-child boot consumer (cli/cmd/serve.ts) and the POST /server/handoff
// endpoint handler use this so the drain semantics stay identical.
//
// No messageID is sent: the server mints a fresh one at send time so the
// handoff user message sorts after the in-flight turn's messages in the
// ID-ordered legacy history (pre-allocated queue IDs sort before them and
// make the loop exit without replying — see SPEC-attach-resume.md).

export type HandoffPrompt = { parts: unknown[] }

export type HandoffInput = {
  baseUrl: string
  authHeader: string | undefined
  directory: string
  sessionID: string
  prompts: HandoffPrompt[]
}

export async function runHandoffDrain(input: HandoffInput): Promise<void> {
  for (const prompt of input.prompts) {
    const res = await fetch(`${input.baseUrl}session/${input.sessionID}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(input.authHeader ? { Authorization: input.authHeader } : {}),
        "x-opencode-directory": input.directory,
      },
      body: JSON.stringify({ parts: prompt.parts }),
    }).catch((err: unknown) => {
      console.error("handoff drain prompt error:", err)
      return undefined
    })
    if (res && !res.ok) {
      console.error("handoff drain prompt failed:", res.status, await res.text().catch(() => ""))
    }
  }
}

export * as Handoff from "./handoff"