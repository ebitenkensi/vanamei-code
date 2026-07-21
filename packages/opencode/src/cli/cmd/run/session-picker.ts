// Startup-time session picker for bare `opencode attach` (no --session,
// --new, or --continue). This runs before the interactive footer boots, so
// it cannot reuse the footer's /sessions panel (footer.sessions.tsx), which
// needs a live @opentui/solid renderer. Instead it reuses @clack/prompts'
// `select`, the same raw-mode picker already used by `opencode account` /
// `opencode auth` (see src/cli/effect/prompt.ts, src/cli/cmd/account.ts) --
// arrow keys move, Enter confirms, Esc/Ctrl-C cancel.
import { isCancel, select } from "@clack/prompts"
import { Locale } from "@/util/locale"
import { UI } from "@/cli/ui"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"

export type PickedSession = {
  id: string
  title?: string
  directory?: string
}

// Sentinel option value for the trailing "Create new session" row.
const CREATE_NEW = "__opencode_attach_create_new__"

function sessionLabel(item: { id: string; title?: string }): string {
  const title = item.title?.trim() || "Untitled session"
  return `${title} ${UI.Style.TEXT_DIM}(${item.id.slice(-6)})${UI.Style.TEXT_NORMAL}`
}

function relativeTime(updated: number): string {
  return `${Locale.duration(Math.max(0, Date.now() - updated))} ago`
}

// Lists the project's root sessions (no parentID), newest first. If
// `hintedID` is a still-valid session, it is pinned first and pre-selected
// so a bare Enter resumes the detach-time session. Returns "cancelled" on
// Esc/Ctrl-C, or undefined when "Create new session" is chosen.
export async function pickAttachSession(
  sdk: OpencodeClient,
  hintedID: string | undefined,
): Promise<PickedSession | "cancelled" | undefined> {
  const list = await sdk.session
    .list()
    .then((x) => x.data ?? [])
    .catch(() => [])
  const roots = list.filter((item) => !item.parentID).sort((a, b) => b.time.updated - a.time.updated)
  const hinted = hintedID ? roots.find((item) => item.id === hintedID) : undefined
  const ordered = hinted ? [hinted, ...roots.filter((item) => item.id !== hinted.id)] : roots

  const picked = await select({
    message: "Resume session",
    initialValue: ordered[0]?.id ?? CREATE_NEW,
    options: [
      ...ordered.map((item) => ({
        value: item.id,
        label: sessionLabel(item),
        hint: relativeTime(item.time.updated),
      })),
      { value: CREATE_NEW, label: "Create new session" },
    ],
  })

  if (isCancel(picked)) return "cancelled"
  if (picked === CREATE_NEW) return undefined

  const chosen = ordered.find((item) => item.id === picked)
  if (!chosen) return undefined
  return { id: chosen.id, title: chosen.title, directory: chosen.directory }
}

export * as SessionPicker from "./session-picker"
