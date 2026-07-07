import { createScrollbackWriter } from "@opentui/solid"
import { TextRenderable, type ColorInput, type ScrollbackRenderContext, type ScrollbackWriter } from "@opentui/core"
import { Match, Switch, createMemo } from "solid-js"
import { entryBody, entryFlags } from "./entry.body"
import { entryColor, entryLook, entrySyntax } from "./scrollback.shared"
import { diffCounts, toolFiletype } from "./tool"
import { RUN_THEME_FALLBACK, transparent, type RunTheme } from "./theme"
import type { EntryLayout, RunEntryBody, ScrollbackOptions, StreamCommit } from "./types"

function todoGlyph(status: string): string {
  if (status === "in_progress" || status === "pending") {
    return "☐"
  }

  return "☒"
}

function todoColor(theme: RunTheme, status: string) {
  if (status === "in_progress") {
    return theme.block.highlight
  }

  return theme.block.muted
}

// Result lines hang under a tool's `⏺ ` header: the first line gets the
// "  ⎿  " marker, continuation lines are indented to the same column.
const TOOL_RESULT_TRUNCATE_LINES = 5

function hangBlock(content: string): string {
  return content
    .split("\n")
    .map((line, index) => (index === 0 ? `  ⎿  ${line}` : line ? `     ${line}` : line))
    .join("\n")
}

// Committed (non-streaming) tool text results get the ⎿ hanging-block layout
// and, for `type: "text"` bodies specifically, are cut to the first N lines
// with a muted "... +N lines" notice. Live streaming display is untouched --
// this only runs on bodies passed to entryWriter's static scrollback path.
export function toolResultBody(commit: StreamCommit, body: RunEntryBody): RunEntryBody {
  if (commit.kind !== "tool" || body.type !== "text" || entryLayout(commit, body) !== "block") {
    return body
  }

  const lines = body.content.replace(/^\n+/, "").split("\n")
  const hidden = Math.max(0, lines.length - TOOL_RESULT_TRUNCATE_LINES)
  const kept = hidden > 0 ? lines.slice(0, TOOL_RESULT_TRUNCATE_LINES) : lines
  return {
    type: "text",
    content: hangBlock(kept.join("\n")),
    truncated: hidden || undefined,
  }
}

export function entryGroupKey(commit: StreamCommit): string | undefined {
  if (!commit.partID) {
    return undefined
  }

  return `${commit.kind}:${commit.partID}`
}

export function sameEntryGroup(left: StreamCommit | undefined, right: StreamCommit): boolean {
  if (!left) {
    return false
  }

  const current = entryGroupKey(left)
  const next = entryGroupKey(right)
  return Boolean(current && next && current === next)
}

export function entryLayout(commit: StreamCommit, body: RunEntryBody = entryBody(commit)): EntryLayout {
  if (commit.kind === "tool") {
    if (body.type === "structured" || body.type === "markdown") {
      return "block"
    }

    // Every tool text body except the user-shell "$ command" echo is a
    // result hanging under the tool's `⏺ ` header, so it gets the ⎿ block
    // layout regardless of phase or line count. The shell echo keeps its
    // inline dot-prefixed look (see needsDotPrefix below).
    if (body.type === "text" && !(commit.phase === "start" && commit.shell)) {
      return "block"
    }

    return "inline"
  }

  if (commit.kind === "reasoning") {
    return "block"
  }

  if (commit.kind === "error") {
    return "block"
  }

  return "block"
}

export function needsDotPrefix(commit: StreamCommit, body: RunEntryBody): boolean {
  if (commit.kind === "assistant") {
    return body.type === "text" || body.type === "markdown"
  }

  // Tool headers already draw their own "⏺ " (see the `header` body Match in
  // RunEntryContent). Only the user-shell "$ command" echo still relies on
  // this generic dot-prefixing.
  if (commit.kind === "tool" && commit.shell) {
    return entryLayout(commit, body) === "inline"
  }

  return false
}

export function separatorRows(
  prev: StreamCommit | undefined,
  next: StreamCommit,
  body: RunEntryBody = entryBody(next),
): number {
  if (!prev || sameEntryGroup(prev, next)) {
    return 0
  }

  if (entryLayout(prev) === "inline" && entryLayout(next, body) === "inline") {
    return 0
  }

  return 1
}

export function RunEntryContent(props: {
  commit: StreamCommit
  body?: RunEntryBody
  theme?: RunTheme
  opts?: ScrollbackOptions
  width?: number
}) {
  const theme = createMemo(() => props.theme ?? RUN_THEME_FALLBACK)
  const body = createMemo(() => props.body ?? entryBody(props.commit))
  const style = createMemo(() => entryLook(props.commit, theme().entry))
  const syntax = createMemo(() => entrySyntax(props.commit, theme()))
  const color = createMemo(() => entryColor(props.commit, theme()))
  const suppressBackgrounds = createMemo(() => props.opts?.suppressBackgrounds === true)
  const diffBg = (color: ColorInput) => (suppressBackgrounds() ? transparent : color)
  const streaming = createMemo(() => props.commit.phase === "progress")
  const dotted = createMemo(() => needsDotPrefix(props.commit, body()))
  const header = createMemo(() => {
    const next = body()
    return next.type === "header" ? next : undefined
  })
  const text = createMemo(() => {
    const next = body()
    return next.type === "text" ? next : undefined
  })
  const code = createMemo(() => {
    const next = body()
    return next.type === "code" ? next : undefined
  })
  const structured = createMemo(() => {
    const next = body()
    return next.type === "structured" ? next.snapshot : undefined
  })
  const markdown = createMemo(() => {
    const next = body()
    return next.type === "markdown" ? next : undefined
  })
  const code_snapshot = createMemo(() => {
    const next = structured()
    return next?.kind === "code" ? next : undefined
  })
  const diff_snapshot = createMemo(() => {
    const next = structured()
    return next?.kind === "diff" ? next : undefined
  })
  const task_snapshot = createMemo(() => {
    const next = structured()
    return next?.kind === "task" ? next : undefined
  })
  const todo_snapshot = createMemo(() => {
    const next = structured()
    return next?.kind === "todo" ? next : undefined
  })
  const question_snapshot = createMemo(() => {
    const next = structured()
    return next?.kind === "question" ? next : undefined
  })

  return (
    <Switch fallback={null}>
      <Match when={header()}>
        <text width="100%" wrapMode="none" truncate>
          <span style={{ fg: style().fg }}>⏺ </span>
          <span style={{ fg: theme().block.text }}>{header()!.label}</span>
          {header()!.suffix ? <span style={{ fg: theme().block.muted }}>{` ${header()!.suffix}`}</span> : null}
        </text>
      </Match>
      <Match when={text() && dotted()}>
        <box width="100%" flexDirection="row">
          <text width={2} wrapMode="none" fg={style().fg}>
            ⏺{" "}
          </text>
          <text flexGrow={1} flexShrink={1} wrapMode="word" fg={style().fg} attributes={style().attrs}>
            {text()!.content}
            {text()!.truncated ? (
              <span style={{ fg: theme().block.muted }}>{`\n     … +${text()!.truncated} lines`}</span>
            ) : null}
          </text>
        </box>
      </Match>
      <Match when={text()}>
        <text width="100%" wrapMode="word" fg={style().fg} attributes={style().attrs}>
          {text()!.content}
          {text()!.truncated ? (
            <span style={{ fg: theme().block.muted }}>{`\n     … +${text()!.truncated} lines`}</span>
          ) : null}
        </text>
      </Match>
      <Match when={code()}>
        <code
          width="100%"
          wrapMode="word"
          filetype={code()!.filetype}
          drawUnstyledText={false}
          streaming={streaming()}
          syntaxStyle={syntax()}
          content={code()!.content}
          fg={color()}
        />
      </Match>
      <Match when={code_snapshot()}>
        <box width="100%" flexDirection="column" gap={1}>
          {code_snapshot()!.summary ? (
            <text width="100%" wrapMode="word" fg={theme().block.muted}>
              {`  ⎿  ${code_snapshot()!.summary}`}
            </text>
          ) : null}
          <box width="100%" paddingLeft={5}>
            <line_number width="100%" fg={theme().block.muted} minWidth={3} paddingRight={1}>
              <code
                width="100%"
                wrapMode="char"
                filetype={toolFiletype(code_snapshot()!.file)}
                streaming={false}
                syntaxStyle={syntax()}
                content={code_snapshot()!.content}
                fg={theme().block.text}
              />
            </line_number>
          </box>
        </box>
      </Match>
      <Match when={diff_snapshot()}>
        <box width="100%" flexDirection="column" gap={1}>
          {diff_snapshot()!.summary ? (
            <text width="100%" wrapMode="word" fg={theme().block.muted}>
              {`  ⎿  ${diff_snapshot()!.summary}`}
            </text>
          ) : null}
          <box width="100%" paddingLeft={5} flexDirection="column" gap={1}>
            {diff_snapshot()!.items.map((item) => {
              const counts = diffCounts(item)
              return (
                <box width="100%" flexDirection="column" gap={1}>
                  {item.title ? (
                    <text width="100%" wrapMode="word" fg={theme().block.muted}>
                      {item.title}
                    </text>
                  ) : null}
                  {diff_snapshot()!.summary ? null : (
                    <text width="100%" wrapMode="word" fg={theme().block.muted}>
                      +{counts.additions} / -{counts.deletions}
                    </text>
                  )}
                  {item.diff.trim() ? (
                    <diff
                      diff={item.diff}
                      view="unified"
                      filetype={toolFiletype(item.file)}
                      syntaxStyle={syntax()}
                      showLineNumbers={true}
                      width="100%"
                      wrapMode="word"
                      fg={theme().block.text}
                      addedBg={diffBg(theme().block.diffAddedBg)}
                      removedBg={diffBg(theme().block.diffRemovedBg)}
                      contextBg={diffBg(theme().block.diffContextBg)}
                      addedSignColor={theme().block.diffHighlightAdded}
                      removedSignColor={theme().block.diffHighlightRemoved}
                      lineNumberFg={theme().block.diffLineNumber}
                      lineNumberBg={diffBg(theme().block.diffContextBg)}
                      addedLineNumberBg={diffBg(theme().block.diffAddedLineNumberBg)}
                      removedLineNumberBg={diffBg(theme().block.diffRemovedLineNumberBg)}
                    />
                  ) : null}
                </box>
              )
            })}
          </box>
        </box>
      </Match>
      <Match when={task_snapshot()}>
        <box width="100%" flexDirection="column" gap={1}>
          {task_snapshot()!.summary ? (
            <text width="100%" wrapMode="word" fg={theme().block.muted}>
              {`  ⎿  ${task_snapshot()!.summary}`}
            </text>
          ) : null}
          <box width="100%" flexDirection="column" gap={0} paddingLeft={5}>
            {task_snapshot()!
              .rows.slice(0, TOOL_RESULT_TRUNCATE_LINES)
              .map((row) => (
                <text width="100%" wrapMode="word" fg={theme().block.text}>
                  {row}
                </text>
              ))}
            {task_snapshot()!.rows.length > TOOL_RESULT_TRUNCATE_LINES ? (
              <text width="100%" wrapMode="word" fg={theme().block.muted}>
                {`… +${task_snapshot()!.rows.length - TOOL_RESULT_TRUNCATE_LINES} lines`}
              </text>
            ) : null}
            {task_snapshot()!.tail ? (
              <text width="100%" wrapMode="word" fg={theme().block.muted}>
                {task_snapshot()!.tail}
              </text>
            ) : null}
          </box>
        </box>
      </Match>
      <Match when={todo_snapshot()}>
        <box width="100%" flexDirection="column" gap={0}>
          {todo_snapshot()!.items.map((item, index) => (
            <text width="100%" wrapMode="word">
              <span style={{ fg: theme().block.muted }}>{index === 0 ? "  ⎿  " : "     "}</span>
              <span
                style={{
                  fg: todoColor(theme(), item.status),
                  bold: item.status === "in_progress",
                  strikethrough: item.status === "completed" || item.status === "cancelled",
                }}
              >
                {todoGlyph(item.status)} {item.content}
              </span>
            </text>
          ))}
          {todo_snapshot()!.tail ? (
            <text width="100%" wrapMode="word" fg={theme().block.muted}>
              {todo_snapshot()!.tail}
            </text>
          ) : null}
        </box>
      </Match>
      <Match when={question_snapshot()}>
        <box width="100%" paddingLeft={5} flexDirection="column" gap={1}>
          {question_snapshot()!.items.map((item) => (
            <box width="100%" flexDirection="column" gap={0}>
              <text width="100%" wrapMode="word" fg={theme().block.muted}>
                {item.question}
              </text>
              <text width="100%" wrapMode="word" fg={theme().block.text}>
                {item.answer}
              </text>
            </box>
          ))}
          {question_snapshot()!.tail ? (
            <text width="100%" wrapMode="word" fg={theme().block.muted}>
              {question_snapshot()!.tail}
            </text>
          ) : null}
        </box>
      </Match>
      <Match when={markdown() && dotted()}>
        <box width="100%" flexDirection="row">
          <text width={2} wrapMode="none" fg={style().fg}>
            ⏺{" "}
          </text>
          <markdown
            flexGrow={1}
            flexShrink={1}
            syntaxStyle={syntax()}
            streaming={streaming()}
            content={markdown()!.content}
            fg={color()}
            tableOptions={{ widthMode: "content" }}
          />
        </box>
      </Match>
      <Match when={markdown()}>
        <markdown
          width="100%"
          syntaxStyle={syntax()}
          streaming={streaming()}
          content={markdown()!.content}
          fg={color()}
          tableOptions={{ widthMode: "content" }}
        />
      </Match>
    </Switch>
  )
}

export function entryWriter(input: {
  commit: StreamCommit
  body?: RunEntryBody
  theme?: RunTheme
  opts?: ScrollbackOptions
}): ScrollbackWriter {
  const resolvedBody = input.body ?? entryBody(input.commit)
  const blockBody = toolResultBody(input.commit, resolvedBody)

  return createScrollbackWriter(
    (ctx) => (
      <RunEntryContent
        commit={input.commit}
        body={blockBody}
        theme={input.theme}
        opts={{ ...input.opts, suppressBackgrounds: false }}
        width={ctx.width}
      />
    ),
    entryFlags(input.commit),
  )
}

export function spacerWriter(): ScrollbackWriter {
  return (ctx: ScrollbackRenderContext) => ({
    root: new TextRenderable(ctx.renderContext, {
      width: Math.max(1, Math.trunc(ctx.width)),
      height: 1,
      content: "",
    }),
    width: Math.max(1, Math.trunc(ctx.width)),
    height: 1,
    startOnNewLine: true,
    trailingNewline: true,
  })
}
