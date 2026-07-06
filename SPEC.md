# フルスクリーン TUI からの脱却 — インライン UI(mini)の昇格 — Spec

## 目的

alternate screen 前提のフルスクリーン TUI(`packages/tui`)を廃し、既存の split-footer 型インライン UI(隠しフラグ `opencode --mini`、実装は `packages/opencode/src/cli/cmd/run/`)を bare `opencode` のデフォルト体験に昇格させる。claude-code と同じ「履歴はターミナルのネイティブスクロールバックに追記、下部の小さなフッター領域のみ再描画」という描画モデルへ全面移行する。

## 前提知識(調査済みの事実)

- opentui 0.3.4(フォークではない、npm 公式)は `screenMode: "alternate-screen" | "main-screen" | "split-footer"` をサポート。フル TUI がフルスクリーンなのは `packages/tui/src/app.tsx:194-206` の `createCliRenderer` に `screenMode` を渡さずデフォルト(`alternate-screen`)に落ちているだけ。
- `--mini` は `packages/opencode/src/cli/cmd/run/runtime.lifecycle.ts:181-195` で `screenMode: "split-footer"`, `footerHeight: 4`, `externalOutputMode: "capture-stdout"`, `clearOnShutdown: false` により起動。履歴は `renderer.writeToScrollback` / `createScrollbackSurface`(`scrollback.surface.ts`)で不変の追記としてコミットされる。「scrollback is immutable (append-only) and the footer is the only region that can repaint」(`footer.ts:3-5`)。
- `--mini` は対話完備: プロンプト・キュー・permission/question 応答・スラッシュメニュー・model/variant/skill ピッカー・subagent 検分・Ctrl-C 二度押し終了(`footer.*`, `runtime.queue.ts`)。
- CLI 振り分け: bare `opencode` → `TuiThreadCommand`(`$0 [project]`、`packages/opencode/src/cli/cmd/tui.ts:72-74`、worker 経由で `import("../tui/layer")`)。`opencode run <msg>` → 非対話 stdout ストリーム。`opencode --mini` → インライン対話 UI(`run.ts:220-224` の隠しフラグ、`run.ts:274` で `interactive = args.mini`)。`--mini` は TTY 必須(`run.ts:319-321`)、`--command`/`--format json` と非互換(`run.ts:292-306`)。`runMini()`(`run.ts:977-1011`)がプログラム的エントリ。
- フル TUI にあって mini に無いもの: サイドバー、モーダルダイアログ(timeline/fork/message)、セッション切替 UI、マウス、テーマカタログ(mini はターミナルパレット由来の1テーマ、`run/theme.ts`)。
- claude-code(参照: `/home/ebitenkensi/project_dir/claude-code/src`)はダイアログをフローティングにせず「ツリー最下部のインラインブロック」として描画する。サイドバーは存在しない。この語彙に合わせる。

## スコープ外

- タイムライン/fork/message ダイアログ相当の機能(ユーザー判断で P1 対象外。将来要望があれば別スペック)
- テーマカタログ(mini のターミナルパレット由来テーマのままとする)
- マウス対応(`useMouse: false` のまま)
- `opencode run <msg>`(非対話モード)の挙動変更 — 一切触らない
- インライン UI 内部での履歴スクロール機構(ネイティブスクロールバックに委ねる。claude-code と同方針)
- `packages/tui` への新規機能・スタイル投資(P4 で削除するため)
- opentui のバージョン更新・フォーク

## 対象ファイル / インターフェース

- `packages/opencode/src/index.ts` — コマンド登録。`$0` を TuiThreadCommand からインライン UI へ差し替え
- `packages/opencode/src/cli/cmd/tui.ts` — `$0 [project]` を明示サブコマンド `tui [project]` に降格(P1)、P4 で削除
- `packages/opencode/src/cli/cmd/run.ts` — `--mini` フラグの扱い(非推奨エイリアス化)、`runMini()` 相当のロジックを bare 起動へ接続
- `packages/opencode/src/cli/cmd/run/footer.command.tsx` ほか footer.\* — セッション切替メニュー(P2)、情報表示(P3)
- `packages/opencode/src/cli/cmd/run/session-data.ts`, `stream.ts`, `types.ts` — コンテキスト%・コスト・変更ファイル数のデータ配管(P3)
- `packages/opencode/src/cli/cmd/run/runtime.lifecycle.ts` — セッション再バインド時の replay(既存の replay 機構 `:373-398` を再利用)
- `packages/tui/` 全体、`packages/opencode/src/tui/`(worker layer) — P4 で削除。削除前に依存グラフを必ず実測すること(`grep -r "packages/tui\|@opencode-ai/tui\|../tui/layer" packages/`)

## 振る舞い

### P1: bare `opencode` = インライン UI

- `opencode [project]`(TTY)→ 現在の `opencode --mini` と同一のインライン UI が起動。project 引数はカレントプロジェクト指定として従来の TUI と同義に扱う
- 引き継ぐフラグ: `--model`, `--agent`, `--continue`/`-c`, `--session`/`-s`, `--fork`, `--attach`, `--port`。既存の `--mini` 用ガード(`--command`/`--format json` 非互換)は bare 起動には適用不要(そもそも受けない)
- 非 TTY で bare 起動 → エラーメッセージ(「対話 UI は TTY が必要。非対話実行は `opencode run` を使え」)+ exit 1
- `opencode tui [project]` → 従来のフル TUI(P4 まで温存する避難ハッチ)
- `opencode --mini` → 引き続き動作するが、起動時に deprecation 一行を stderr に出す(「--mini はデフォルトになった」)
- 終了時挙動は現行 mini と同一: スクロールバックに履歴が残る(`clearOnShutdown: false`、shutdown 時 `main-screen` へ遷移)

### P2: セッション切替 / resume

- スラッシュコマンド `/sessions`(エイリアス `/resume`)を footer コマンドメニューに追加
- 起動プロジェクトのセッション一覧を新しい順に表示: タイトル(truncate)+ 相対時刻。既存の footer メニュー UI(model ピッカー等)の描画様式を踏襲
- 選択時の状態遷移:
  1. 進行中ターンがある場合はメニュー起動自体を拒否し footer に注意表示(切替はアイドル時のみ)
  2. 現セッションの購読を解除し、選択セッションへ再バインド
  3. スクロールバックへ区切り(divider)を1行書き、既存 replay 機構で選択セッションの履歴を追記描画
  4. footer(todo・キュー等)は新セッションの状態を反映
- Esc でメニューを閉じて無変更

### P3: サイドバー代替の情報表示

- フル TUI の info-pills(`packages/tui/src/routes/session/footer.tsx:66-77` 参照: タイトル・`◆ ctx%`・コスト・`☐ todos`・`✎ modified`)相当を run footer の常設行に移植
- 表示位置: footer 最下段(エージェント/モデル情報行)の右端に `·` 区切りで常時表示。幅が不足する場合は優先度順(ctx% > cost > todos > modified > タイトル)に右から間引く
- 色: ctx% は 80%以上 warning / 95%以上 error、その他は muted 系。フル TUI の配色ロジックを踏襲
- データ: assistant メッセージのトークン集計(ctx%)、session cost、todo 未完了数(既存配管あり)、session diff ファイル数。session-data.ts / stream.ts に不足の配管を追加

### P4: packages/tui の削除

- `packages/tui/` ディレクトリ、`packages/opencode/src/tui/`(worker layer)、`tui.ts` サブコマンド、workspace 参照(root `package.json`)、CI・スクリプト参照を削除
- 削除前に依存を実測し、`packages/opencode` が packages/tui から import しているものが run/ 配下に存在しないことを確認(存在した場合は run/ 側へ移設してから削除)
- 単独コミットとし、revert 可能な粒度を保つ

### エッジケース

- `$EDITOR` 起動(既存 `onEditorOpen`)・外部エディタは現行 mini の挙動を維持
- リサイズ時の replay(既存 `runtime.lifecycle.ts:373-398`)は P2 のセッション切替 replay と同一経路を使うこと(二重実装禁止)
- tmux 等 DEC 2026 非対応端末での描画は opentui に委ねる(本スペックでは対処しない)

## フェーズ分割

- P1 デフォルト差し替え | deps:- | done:bare `opencode` でインライン UI が起動し、`opencode tui` でフル TUI が起動し、非 TTY で適切なエラーになる | verify:`packages/opencode` で `bun typecheck` && `bun test test/cli/`、実機で `opencode` / `opencode tui` / `echo x | opencode` の3通りを手動確認
- P2 セッション切替 | deps:P1 | done:`/sessions` メニューから別セッションへ切替でき、履歴が replay され、アイドル時以外は拒否される | verify:`bun typecheck` && `bun test test/cli/run/`、実機で2セッション間の切替と divider/replay を目視確認
- P3 情報表示 | deps:P1 | done:footer 常設行に ctx%・コスト・todo・modified が表示され、幅不足時に優先度順で間引かれる | verify:`bun test test/cli/run/`(footer.view テスト追加)、実機で長会話中の表示更新を目視確認
- P4 TUI 削除 | deps:P1,P2,P3 | done:packages/tui と worker layer が消え、リポジトリ全体のビルド・テストが通る | verify:root で `bun install` 成功、`packages/opencode` で `bun typecheck` && `bun test`、`grep -r "tui/layer\|packages/tui" packages/opencode/src` が 0 件

## 検証(完了の定義)

- [ ] `packages/opencode` で `bun typecheck` Exit 0、`bun test` 全 pass(テストは repo root から実行禁止)
- [ ] 実機 E2E: ターミナルで bare `opencode` → プロンプト入力 → 応答がスクロールバックに追記 → Ctrl-C 二度押しで終了 → **終了後もターミナルの履歴に全出力が残っている**(alternate screen に入っていない証拠)
- [ ] `/sessions` で過去セッションへ切替 → 履歴 replay → 追加プロンプトが新セッションに送られる
- [ ] footer に ctx%/コスト/todo/modified が常時表示され、ターミナル幅を狭めると優先度順に間引かれる
- [ ] P4 後: `git grep -l "opentui" packages/` が packages/opencode のみを返し、フル TUI の残骸参照が無い

## 備考(実装者への注意)

- **未コミットの packages/tui ポリッシュ差分が作業ツリーに存在する**(⏺/⎿ ガター等)。P4 で削除される運命だが、P1〜P3 の間フル TUI は避難ハッチとして生き続けるため、先にコミットしてから本スペックに着手すること(検証済み: tui 191 pass / opencode 197 pass)
- run/ 配下の設計原則を守ること: スクロールバックは不変・追記のみ、再描画してよいのは footer 領域だけ(`footer.ts:3-5`)
- `InlineToolRow` 等 packages/tui の規約は P4 削除で消えるが、run/ 側にも同種の「純粋な葉コンポーネント」規約が無いか着手時に AGENTS.md / テストを確認すること
