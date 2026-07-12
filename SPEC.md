# Automode — LLM Permission Judge — Spec

## 目的

permission が `ask` に解決される tool call を、人間へ確認する前に LLM(judge)へ事前判定させ、安全と判断されたものは自動許可する。Claude Code の auto mode に相当する体験を opencode に導入する。ユーザーの `deny` ルールは常にハード境界であり、judge は「今回のみ許可」か「人間へエスカレーション」しか出せない advisory な存在とする。

着手済みコード: `packages/opencode/src/permission/judge.ts` と `packages/opencode/test/permission/judge.test.ts`(untracked)。`buildJudgePrompt` / `parseVerdict` とそのテストは流用し、サービス本体は本仕様に合わせてリワークする。

## 確定済みの設計判断(インタビュー結果)

1. **有効化**: 既存 permission 設定の action に `auto` を追加(`allow`/`deny`/`ask`/`auto`)。加えてセッション内トグルを設ける。
2. **両者は独立加算式**: config の `auto` ルールはトグルに関係なく常に judge 判定。セッショントグル ON のときは、通常なら `ask` になるものも全て judge 判定に回る。
3. **判定中 UX**: プロンプトは従来どおり即表示し、judge が allow したら既存の reply 経路で自動消滅する。Permission コアの待ち合わせ機構は変えない。ユーザーの先行応答は常に judge に勝つ。
4. **可視化**: 自動許可時に専用イベントを publish し、inline run UI の scrollback に一行通知を出す。エスカレーション理由のプロンプト表示はしない。
5. **judge の権限**: 「once 許可」か「エスカレーション(何もしない)」のみ。`always` 許可・`deny` は出せない。
6. **トグル初期状態**: 常に OFF。config での既定値指定は設けない。
7. **judge モデル**: 設定可能で、未指定時は small model 系へフォールバック(詳細は「振る舞い §3」)。

## スコープ外

- judge による `deny` 判定・`always` 許可(approved への蓄積)
- エスカレーション時の理由を permission プロンプトへ表示すること(将来課題)
- inline run UI 以外のクライアント(desktop / tui / sdk)の UI 対応。プロトコル上イベントは流れるが描画は追加しない
- 判定履歴の永続化・監査ログ(イベント + 既存ログのみ)
- plugin hook `permission.ask` の契約変更(`auto` を返せるようになるのは型変更の副産物として許容するが、hook 仕様は変えない)
- 会話履歴全文を judge へ渡すこと(最新の非 synthetic user メッセージ 1 件のみ)
- judge プロンプト内容の config カスタマイズ
- クラスタ / リモート placement を跨ぐ判定(watcher は process-local。V2 Session Core の方針どおり)
- 新しい top-level config キー `automode`(下記のとおり agent config で代替。着手済みコードの `cfg.automode?.model` 参照は削除する)

## 対象ファイル / インターフェース

### スキーマ・プロトコル(変更後 `packages/client` で `bun run generate` 必須)

- `packages/schema/src/v1/permission.ts`
  - `Action` を `Schema.Literals(["allow", "deny", "ask", "auto"])` に拡張
  - `Request` に `auto: Schema.optional(Schema.Boolean)` を追加(Asked イベントにも自動で載る)
  - 新イベント `Judged`(`type: "permission.judged"`)を追加し `Event.Definitions` に登録。schema: `{ sessionID, requestID: ID, permission: Schema.String, patterns: Schema.Array(Schema.String), reason: Schema.String, tool: Schema.optional(...Request の tool と同形) }`。自動許可時のみ publish
- `packages/core/src/v1/config/permission.ts` — `Action` に `"auto"` を追加(config で `"bash": {"*": "auto"}` と書けるようにする)
- `packages/schema/src/v1/session.ts` — `SessionInfo` に `automode: optional(Schema.Boolean)` を追加。session update の入力 schema(title/metadata と同じ経路)にも `automode` を追加

### サーバー側

- `packages/opencode/src/permission/index.ts` — `ask()` で pending を作る際、deny/allow 以外に解決した全パターンが `auto` だった場合に `Request.auto = true` を立てる。それ以外の挙動(Deferred 待ち・イベント publish・reply)は不変
- `packages/opencode/src/permission/judge.ts` — リワーク。`Interface.judge` は `(input: { request: PermissionV1.Request }) => Effect<Verdict>` に変更(`permission.list()` からの再検索をやめ、レースを排除)。`buildJudgePrompt` / `parseVerdict` は維持
- `packages/opencode/src/permission/watch.ts` — 新規。`Event.Asked` を購読して judge を起動し、allow なら `permission.reply({ requestID, reply: "once" })` + `Event.Judged` publish する常駐 watcher(`packages/opencode/src/project/vcs.ts` の `events.listen` パターンを踏襲)
- `packages/opencode/src/agent/agent.ts` — native 隠しエージェント `permission-judge` を追加(`title` と同型: `mode: "primary"`, `hidden: true`, `native: true`, permission は `"*": "deny"`)
- `packages/opencode/src/session/session.ts` — `setAutomode: (input: { sessionID; automode: boolean }) => Effect<void>` を `setTitle`/`setMetadata` と同様に追加
- `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` — `update` の payload に `automode` を追加し `setAutomode` へ配線
- `packages/opencode/src/event-manifest.ts` — `permission.judged` を登録
- `packages/opencode/src/effect/app-runtime.ts` — watcher の node を node リストへ追加

### inline run UI(`packages/opencode/src/cli/cmd/run/`)

- `footer.prompt.tsx` — builtin slash `/auto`(`{ kind: "slash", name: "auto", display: "/auto", description: "toggle LLM permission judge" }`)を `new`/`exit` と並べて追加
- slash dispatch 箇所(`name === "new"` / `"exit"` を処理している場所を grep で特定)— `/auto` で SDK の session update(`automode: !current`)を呼ぶ
- `footer.view.tsx` — ステータス行に `AUTO` pill を追加。`session.automode === true` のとき表示。既存 mode pill と同じ foreground 系スタイル(線ベース方針を崩さない)
- scrollback イベント処理(`stream.ts` / `scrollback.writer.tsx` — Asked/Replied を扱っている箇所に併設)— `permission.judged` 受信で muted 一行: `⏺ Auto-allowed <permission>(<patterns 先頭>) — <reason>`。字組みは既存 tool ヘッダ規約(⏺ + truncate)に従う

### テスト

- `packages/opencode/test/permission/judge.test.ts` — 既存(prompt/parse)は維持し、インターフェース変更分を追随
- `packages/opencode/test/permission/` — `evaluate` が `auto` ルールを返すこと、`ask()` が `Request.auto` を正しく立てること(全パターン auto → true、混在 → false)、watcher の自動 reply フロー(`next.test.ts` のイベント購読ハーネスを参照。judge は Layer 差し替えで決定的な Verdict を返すテスト用実装を provide し、globalThis モックは使わない)
- `packages/opencode/test/cli/run/` — AUTO pill・judged scrollback 行の gallery / assertion

## 振る舞い

### 1. ルール解決と ask フロー

- `evaluate()` の機構(findLast・既定 `ask`)は不変。ルールの action として `auto` が増えるだけ
- `Permission.ask()`:
  - いずれかのパターンが `deny` → 従来どおり `DeniedError`(judge は関与しない。ハード境界)
  - 全パターン `allow` → 従来どおり即通過
  - それ以外 → pending 作成 + `Asked` publish(従来どおり即プロンプト表示)。このとき deny/allow 以外に解決したパターンが **全て** `auto` なら `auto: true` を Request に載せる。1 つでも素の `ask` が混ざれば `auto: false`
- `disabled()` / `visibleTools()` / `appendStatusRule()` の意味論は不変(`auto` は deny ではないのでツールは隠れない)

### 2. watcher(自動判定)

- `Event.Asked` を購読。判定対象は: `event.auto === true` **または** `session.get(sessionID)` の `automode === true`(独立加算式)。どちらでもなければ何もしない
- 対象なら fiber を fork して `judge({ request })` を実行:
  - verdict `allowed` → `permission.reply({ requestID, reply: "once" })`。`NotFoundError` はユーザーが先に応答した合図なので握りつぶす。reply 成功時のみ `Event.Judged` を publish(reason 付き)
  - verdict `ask` → 何もしない(プロンプト残置。ユーザーが通常どおり応答)
- 同一セッションで複数 pending が並ぶ場合も各リクエスト独立に判定してよい(reply("once") は他の pending に波及しない)
- watcher は process-local。instance 終了時は購読解除(`Effect.addFinalizer`)

### 3. judge 本体

- agent: `agents.get("permission-judge")`。native 登録済みなので常に存在する前提でよい(取得失敗は `ask` フォールバック)
- モデル解決(`SessionPrompt.ensureTitle` と同型):
  1. `ag.model`(ユーザーは config の `agent: { "permission-judge": { model: "provider/model" } }` で指定)
  2. `provider.getSmallModel(<セッションモデルの providerID>)`
  3. セッションモデルそのもの
  4. どれも解決できなければ verdict `ask`
- 文脈: `session.findMessage` で最新の非 synthetic user メッセージを取得し、text parts を `userPrompt` としてプロンプトに埋め込む。`llm.stream` の `user` にはこのメッセージの info をそのまま渡す(title 生成と同じ。現行の `as unknown as SessionV1.User` 偽造は廃止)。user メッセージが見つからない場合は `userPrompt: ""` で判定は続行するが、`user` を渡せないため verdict `ask` でよい
- LLM 呼び出し: `llm.stream({ agent, user, system: [], small: true, tools: {}, model, sessionID, retries: 2, messages: [{ role: "user", content: prompt }] })`。judge agent は全 deny + tools 空なので再帰的な permission 要求は発生しない
- fail-closed: 20 秒タイムアウト・パース失敗・空応答・エラーは全て `ask`
- `buildJudgePrompt` の判定基準(スコープ逸脱・破壊的操作・プロジェクト外書込・不審ホスト・prompt injection 兆候・doom_loop)は現行のまま
- 現行 judge.ts のスタイル違反(`let mdl`、`(cfg as any)`、二重キャスト、不要な `automode` config 参照)は CLAUDE.md スタイルに沿って解消する

### 4. セッショントグル

- `SessionInfo.automode?: boolean`。未設定 = OFF。新規セッションは常に OFF
- server の session update 経路(`PATCH`)で `automode` を受け付け `session.setAutomode` を呼ぶ
- run UI `/auto`: 現在値を反転して update。反映は既存の session updated イベント購読に乗る
- AUTO pill: `automode === true` の間ステータス行に表示

### 5. エッジケース

- judge 判定中にユーザーが reply → watcher の reply が `NotFoundError` になるだけ。無害
- judge 判定中にセッション reject(全 pending 一括 reject)→ 同上
- `auto` ルールのみで judge が `ask` を返した場合 → プロンプトはそのまま人間待ち。追加イベントなし
- サブエージェント: config permission はエージェント permission にマージ済みなので `auto` ルールは全エージェントに効く。セッショントグルは sessionID 単位なのでサブエージェントセッションには自動では効かない(V1 の親子関係で `parentID` を辿ることはしない。judge 対象は当該セッションの flag のみ)
- instance 停止時: pending は既存 finalizer で reject される。watcher の未完 fiber は購読解除とともに中断されてよい

## フェーズ分割

- P1 スキーマ + auto 解決 | deps:- | done:`Action`/`Request.auto`/`Judged` イベント/config Action が定義され、`Permission.ask` が auto フラグを立て、client 再生成済み | verify:`packages/opencode` で `bun test test/permission/` と `bun typecheck`、`packages/client` で `bun run generate` の差分をコミット
- P2 judge リワーク + watcher | deps:P1 | done:`permission-judge` agent 登録・judge 新 Interface・watch.ts・event-manifest・app-runtime 配線が完了し、`auto` ルールの bash が自動許可される | verify:`bun test test/permission/`(watcher テスト含む)、`bun typecheck`
- P3 セッショントグル | deps:P2 | done:`SessionInfo.automode` + `setAutomode` + server update + client 再生成 | verify:session update のテスト、`bun typecheck`
- P4 run UI | deps:P3 | done:`/auto`・AUTO pill・judged scrollback 行が動作し gallery 更新済み | verify:`packages/opencode` で `LANG=C LC_ALL=C bun run ui-gallery -- --check`、`LANG=C LC_ALL=C bun test test/cli/`、擬似 TTY E2E(手順は `.claude/skills/running-tests/SKILL.md`)

## 検証(完了の定義)

- [ ] `packages/opencode` から `bun test` / `bun typecheck` が緑(既存の run UI 14 件失敗は除外 — governance-gates HEAD 由来。メモリ `preexisting-run-ui-test-failures` 参照)
- [ ] `packages/client` の `bun run generate` 実行済みで `src/generated*` に手編集がない
- [ ] E2E(実セッション): opencode.json に `"permission": { "bash": { "*": "auto" } }` を置き、安全なコマンド(`ls` 等)を依頼 → プロンプトが自動消滅し scrollback に `⏺ Auto-allowed bash(...)` が出る。`rm -rf` 相当を依頼 → プロンプトが残り人間の確認を待つ
- [ ] E2E(トグル): config に auto ルールなしで `/auto` ON → `ask` になるはずの操作が judge 判定に回る。AUTO pill が表示され、再度 `/auto` で消える
- [ ] deny ルール(例 `"bash": { "git push *": "deny" }`)が automode 下でも従来どおり `DeniedError` になる(judge を経由しない)
- [ ] judge のモデル未解決・タイムアウト時にプロンプトが人間待ちのまま残る(fail-closed の確認は judge テストの Layer 差し替えで担保)
