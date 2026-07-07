# インライン UI の Claude Code 化 — Spec

## 目的

インライン UI（`packages/opencode/src/cli/cmd/run/`, `src/cli/ui/`）のスクロールバック描画・コンポーザー・todo 描画を、Claude Code の CLI UI と同じレイアウト構造に揃える。忠実度は**レイアウト構造のみ**: ⏺/⎿ の階層・インデント・ボックス形状を Claude Code に合わせ、配色（`run/theme.ts` のテーマトークン）・文言・BUILD モードラベル等の opencode 固有要素は保持する。

参照実物: Claude Code のソースは `/home/ebitenkensi/project_dir/claude-code/src` にある。描画の迷いはここ（および実際に `claude` を起動した見た目）を正とする。

## スコープ外

- permission / question ダイアログ（`footer.permission.tsx`, `footer.question.tsx`）— 現状維持
- スピナー・ステータス行のアニメーション語彙（`ui/spinner.ts`）— 現状維持
- スプラッシュ（`splash.ts`）、パネル群（model/skill/subagent/sessions/queued select）、subagent インスペクタ — 現状維持
- reasoning エントリの描画（現行の dim コードブロック形式のまま）
- ユーザー入力エコー（`❯ <text>`）の形式変更 — `❯` を保持
- 配色・テーマトークンの変更（既存トークンの割当先変更のみ可、新色の導入はしない）
- ツール出力のインタラクティブ展開（ctrl+o 相当）— inline scrollback は追記不変のため**静的切詰めのみ**
- `opencode run <msg>` 非対話モードの出力変更

## 確定済みの設計判断（インタビュー結果）

1. 対象は「スクロールバック描画」「コンポーザー」「todo 描画」の 3 面。
2. ツールヘッダは `⏺ ToolName(引数)` 形式に統一（ツール名は opencode のもの）。
3. 出力切詰めは**テキスト出力のみ・先頭 5 行 + `… +N lines`**。diff・todo・task カードは全文のまま。
4. ターン終了サマリ行 `▣ agent · model · duration` は**削除**。
5. todo はスクロールバック・フッターパネル**両方**を ☒/☐ に統一。

## 対象ファイル / インターフェース

- `src/cli/cmd/run/tool.ts` — `scroll.start/final` 各関数と `TOOL_RULES` を `⏺ ToolName(args)` ヘッダ + 結果サマリ文字列に改める
- `src/cli/cmd/run/scrollback.writer.tsx` — ⏺/⎿ の付与・ぶら下げインデント・切詰め・todo カード描画・`turnSummaryWriter` 削除
- `src/cli/cmd/run/scrollback.surface.ts` — ⏺ プレフィックス付与箇所（~L343）、turn summary 出力箇所（~L360, `appendTurnSummary` ~L428）の削除
- `src/cli/cmd/run/entry.body.ts` — `summary` 分岐の削除、tool/assistant ボディの受け渡し調整
- `src/cli/cmd/run/turn-summary.ts` — **モジュールごと削除**（`session-replay.ts` の `messageTurnSummaryCommit` 利用と `types.ts` の `StreamCommit.summary` も併せて除去）
- `src/cli/cmd/run/footer.prompt.tsx` — `RunPromptBody` を角丸ボーダーのボックスに変更、行数計算（`onRows`/`PROMPT_MAX_ROWS`）を +2 行補正
- `src/cli/cmd/run/footer.view.tsx` — ステータス行（modeLabel/spinner/pills/model/hints）をボックス外・直下の素の 1 行に変更、`RunFooterTodoPanel` のグリフを ☒/☐ に変更
- `packages/opencode/script/ui-gallery.tsx` — 変更に伴う説明文の更新（新規状態の追加は不要、既存状態が全変更をカバー）
- `packages/opencode/test/cli/run/` — 旧形式（`# Todos`, `[✓]`, `⎿ ` 全行プレフィックス, `▣` 等)を期待するテストの更新

## 振る舞い

### 1. ツールエントリ（スクロールバック）

**ヘッダ（start フェーズで 1 行）**: `⏺ ToolName(主引数)`。⏺ は既存のエントリ色トークン、引数はテキスト色、補足（作業 dir、offset/limit、provider 等）は muted の後置サフィックス。幅超過は truncate。

| ツール                             | ヘッダ                                                          | 最終結果行（⎿）                                                                        |
| ---------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| bash                               | `⏺ Bash(<command>)`（workdir が `.` 以外なら dim ` in <dir>`） | 出力本文（切詰め対象）。空出力は `⎿ (no output)`。エラー時は `⎿ Error (exit N)` + 出力 |
| read                               | `⏺ Read(<path>)`                                               | `⎿ Read N lines`（行数がメタデータに無ければ省略）                                     |
| write                              | `⏺ Write(<path>)`                                              | `⎿ Wrote N lines` + 既存のコードスナップショット（行番号付き、全文）                   |
| edit                               | `⏺ Edit(<path>)`                                               | `⎿ +A / -D` + 既存の unified diff（行番号・背景色付き、全文）                          |
| apply_patch                        | `⏺ Patch(<N files>)`                                           | 既存の per-file 行（`+ Created …` 等）を ⎿ ブロックに                                  |
| glob / grep                        | `⏺ Glob(<pattern>)` / `⏺ Grep(<pattern>)`（dim ` in <dir>`）  | `⎿ N matches`（既存 final があるもののみ）                                             |
| list                               | `⏺ List(<path>)`                                               | なし                                                                                   |
| task                               | `⏺ Task(<description>)`（dim ` <AgentType>`）                  | `⎿ Done (<duration>)` + タスク結果 markdown（既存挙動を ⎿ 下に）                       |
| todowrite                          | `⏺ Update Todos`                                               | §3 参照                                                                                |
| question                           | `⏺ Question(<N questions>)`                                    | 既存の Q/A ペアを ⎿ ブロックに                                                         |
| webfetch / websearch / skill / lsp | `⏺ WebFetch(<url>)` 等、既存 title を `Name(arg)` 形に         | なし                                                                                   |
| batch / invalid / 未知ツール       | `⏺ <既存 title>` フォールバック                                | 出力本文（切詰め対象）                                                                 |

**⎿ ブロックの字組み**: 1 行目のみ `  ⎿  `（2sp + ⎿ + 2sp）、2 行目以降は 5 スペースで揃える。現行の「全行 `⎿ ` プレフィックス」（`bashBlockContent`）はこの形式に置換し、bash 専用ではなく汎用ヘルパーにする。構造化カード（diff/code/task/todo/question）は既存の box レイアウトを流用しつつ左に同じ 5sp ガターを与え、`# Edited …` / `# Wrote …` / `# Todos` / `# Questions` の markdown 見出しタイトルは廃止（ヘッダ行が代替）。

**切詰め**: `type: "text"` のツール出力ブロックが**確定（コミット）される時点**で先頭 5 行 + muted の `… +N lines` に切る。ストリーミング中のライブ表示（フッター領域の再描画）は現行挙動のまま。diff・コードスナップショット・todo・task・question カードは切詰めない。

### 2. アシスタント本文とサマリ行

- アシスタント markdown は現行の `⏺\n<本文>`（フラッシュ左）をやめ、**2 桁ガター + ぶら下げ**にする: エントリグループの先頭コミットはガターに `⏺ `、同一グループの後続コミットはガター空白。本文は右カラム（幅 −2）で markdown 描画。グループ判定は既存の `sameEntryGroup`/`needsDotPrefix` の意味論を維持。
- ターンサマリ（`▣ agent · model · duration`）は全経路（ライブ、`session-replay.ts` の履歴再生、`demo.ts`）から削除。`StreamCommit.summary`、`entryFlags` の summary 分岐、`turnSummaryWriter`、`turn-summary.ts` を dead code ごと除去。

### 3. todo 描画

- **スクロールバック**: ヘッダ `⏺ Update Todos` + ⎿ ブロックのチェックリスト。completed → `☒`（muted + strikethrough）、in_progress → `☐`（highlight + bold）、pending → `☐`（muted）、cancelled → `☒`（muted + strikethrough、文言はそのまま）。
- **フッターパネル**（`RunFooterTodoPanel`）: グリフを ✓/●/○ から ☒/☐ に変更。色・bold・strikethrough・`… +N more` オーバーフローは現行のまま。

### 4. コンポーザー

- `RunPromptBody` を全幅の角丸ボーダー（`╭─╮ │ ╰─╯`、borderColor は muted）で囲む。内側は現行どおり `❯ `（shell 時 `$ `）+ textarea。テキストエリアの伸縮（1〜6 行）はボックスがそのまま伸びる。
- 現行の statusline 行（`│ BUILD` 左ボーダーブロック + status/spinner + pills + model + hints）は**ボックス直下の素の 1 行**に変更: 左ボーダー装飾を外し、modeLabel は bold + highlight のテキストとして左端に置く。表示内容・レスポンシブ省略ロジックは変更しない。
- 行数会計: ボーダー 2 行ぶんを `onRows`/`PROMPT_MAX_ROWS`/footer 高さ計算に反映。autocomplete メニュー・todo パネル・各種パネルの表示位置関係（コンポーザー下）は現行のまま。

## フェーズ分割

- P1 ツールヘッダ+⎿ブロック+切詰め | deps:- | done:§1 の全ツールが新形式で描画され gallery 再生成済み | verify:`packages/opencode` で `LANG=C LC_ALL=C bun run ui-gallery` → `scrollback.bash/edit/write/patch/task/question` の diff 目視、`LANG=C LC_ALL=C bun test test/cli/`、`bun typecheck`
- P2 アシスタント⏺ぶら下げ+サマリ行削除 | deps:P1 | done:§2 のとおり markdown がガター描画され `▣`/`turn-summary.ts` が全削除 | verify:同上（`scrollback.markdown/text` の diff 目視、`grep -rn "▣\|turnSummary" src/ test/` が空）
- P3 todo 描画 | deps:P1 | done:§3 のとおり両面が ☒/☐ | verify:同上（`scrollback.todo` / `footer.todos` の diff 目視）
- P4 コンポーザー枠+ステータス行 | deps:- | done:§4 のとおり角丸ボックス+素のステータス行、行数計算が正しい | verify:同上（`footer.prompt` / `footer.*` 全状態の diff 目視）+ 擬似 TTY E2E で複数行入力・autocomplete 表示時の崩れがないこと

## 検証（完了の定義）

- [ ] `packages/opencode` で `LANG=C LC_ALL=C bun run ui-gallery` を再生成し、`test/cli/run/__gallery__/` の diff を変更とともにコミット。`bun run ui-gallery -- --check` がクリーン
- [ ] `LANG=C LC_ALL=C bun run ui-gallery -- --visual` で PNG を生成し、色・強調を目視レビュー（テキストフレームだけで判定しない）
- [ ] `LANG=C LC_ALL=C bun test test/cli/` が packages/opencode から全緑、`bun typecheck` パス
- [ ] 擬似 TTY E2E（`script -qec` + キー注入、ANSI 除去後 grep — 手順は `~/.claude/projects/.../memory/inline-ui-verification-recipes.md`）で: ①bash ツール実行が `⏺ Bash(…)` + `⎿` + 6 行以上の出力で `… +N lines` になる ②コンポーザーが `╭…╮` で囲まれ入力・送信できる ③`▣` がどこにも出ない
- [ ] `grep -rn "▣" src/ test/` が空（削除の証明）
