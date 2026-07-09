---
name: running-tests
description: How to run this repo's test suites and verify the inline run UI in packages/opencode. Use when running or writing tests, when a test fails and you need to know whether it predates your change, or when verifying a change to the inline run UI (packages/opencode/src/cli/cmd/run). Trigger phrases include 「テストして」「テスト実行」「UIを確認して」「run UIを検証して」.
---

# Running Tests

## Executing a suite

- Never run tests from the repo root — root `bunfig.toml` pins `[test] root`
  to a nonexistent directory (`do-not-run-tests-from-root`) specifically to
  break that. `cd` into the package first (e.g. `packages/opencode`,
  `packages/core`); its own `bunfig.toml`/preload takes over and the guard no
  longer applies.
- Use plain `bun test` (optionally scoped, e.g. `bun test test/permission/`)
  for a trustworthy full run. `bun run test` invokes the package's own
  script, which for several packages (`packages/opencode`, `packages/core`)
  adds `--only-failures` — that reruns only tests that failed last time and
  can silently omit failures you haven't triggered yet. Reach for it only
  when iterating on a fix you've already reproduced with a plain run.
- Before attributing a failing test to your change, reproduce it on a clean
  tree (`git stash -u`, or diff against `dev`) — this repo can carry
  pre-existing failures unrelated to what you're working on. Don't burn time
  chasing them as if you broke something; if you do want to fix one, treat
  it as an independent unit of work.

## Verifying the inline run UI (`packages/opencode/src/cli/cmd/run/`)

This is the SPEC.md-complete inline UI. The old full-screen TUI
(`packages/tui`) was removed; don't resurrect patterns from it.

- Launch: from the repo root, run `bun dev`, which expands to:
  ```
  bun run --cwd packages/opencode --conditions=browser src/index.ts
  ```
  `--cwd` shifts the shell's working directory to `packages/opencode` as a
  side effect. If you need the app to open relative to your actual shell
  location, use `bun dev .` instead (a relative project path resolves
  against `$PWD`, not the shifted cwd).
- Unit tests: from `packages/opencode`, `bun test test/cli/`. No locale
  pinning is required — `test/cli/help/help-snapshots.test.ts` pins
  `LANG=C`/`LC_ALL=C`/`COLUMNS=120` itself in the env of the subprocess it
  spawns (see its `SNAPSHOT_ENV` constant), so the outer shell's locale
  doesn't leak in.
- Interactive E2E via a pseudo-TTY, when you need to prove real keystrokes
  reach the running app:
  ```
  { sleep 12; printf '\x10'; <key sequence for the scenario>; } \
    | timeout 60 script -qec "bun run --conditions=browser ./src/index.ts <scratch-dir>" out.txt
  ```
  Strip ANSI before asserting: `sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g'`, then grep.
  Detect accidental alt-screen entry by the presence/absence of `\x1b[?1049h`.
- Command-palette gotcha: typing "resume" as a filter surfaces the
  operator's own custom `/resume` slash command first, which fires a real
  LLM turn if selected. Filter with a distinguishing word instead (e.g.
  "sessions", "switch agent").
- Primary visual check: the UI gallery. From `packages/opencode`:
  ```
  bun run ui-gallery          # regenerates test/cli/run/__gallery__/*.txt
  bun run ui-gallery -- --check   # fails on drift instead of rewriting
  ```
  That diff is the actual review artifact for any UI change — a delegated
  UI-edit brief should require "regenerate the gallery and attach the diff."
- Final color/emphasis judgment: `bun run ui-gallery -- --visual` renders the
  captured spans to HTML, screenshots them with headless Chrome, and writes
  ~40 PNGs plus `contact-sheet.html` to `.artifacts/ui-gallery/` (gitignored,
  not committed). Read the PNGs directly to judge color and emphasis; override
  the Chrome binary with `UI_GALLERY_CHROME` if the default isn't found.
