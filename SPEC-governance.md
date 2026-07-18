# ガバナンス・ゲートのネイティブ化 — Spec

## 目的

~/dotfiles/config/opencode で実証済みの「安価なモデルの複合体 + 決定的ゲート」構成のうち、
**設定・プラグイン層では根治不能と実測で確定した3欠陥**を opencode 本体(このフォーク)の
コードで決定的なゲートに昇格させ、あわせてガバナンス状態をインライン UI に可視化する。

dotfiles README(v2.3.4)の運用前提は「プロンプト規則はすべて確率的。決定的なのは
ask/deny/task の構造ゲートだけ」。本 Spec はその決定的ゲートの語彙を3つ拡張する:

1. **予算** — conductor-guard の予算ブレーカーは 15 秒ポーリング + ツールエラー方式で、
   ブロックされた呼び出し自体が全文脈再送で課金される(実測: 16連打で約$0.7無進捗焼失)。
   ネイティブならコスト会計の真実の源でターン境界に強制でき、ブロック課金がゼロになる。
2. **委譲スコープ** — 委譲先の edit がブリーフ範囲外ファイルを上書きする事故
   (実測: 受理済み271行を `git checkout --` で無音破壊)は契約文でしか防げていない。
   task ツールに `files` を追加し、子セッションの edit を構造的に制限する。
3. **deny の可視化** — ルール deny はイベントを一切発行せず(permission/index.ts:75-79 が
   publish 前に return)、プラグインの deny 連打エスカレータが構造的に不能(README「既知の
   残欠陥」筆頭)。deny イベントの発行と、宣言だけされて一度も呼ばれていない
   `permission.ask` プラグインフック(packages/plugin/src/index.ts:261)の配線で根治する。

## スコープ外

- SPEC-automode.md の P2/P3(LLM permission judge)— 別 Spec として既存。本 Spec と独立
- dotfiles 側 conductor-guard.ts の新フック対応リライト — 本体側 API が先。フォローアップ
- 親セッション予算への子セッション(task)コストの合算 — 予算は**セッション自身のコストのみ**を
  数える(dotfiles の semantics を踏襲)。子は自分の agent の budget で自律的に律する
- レガシー V2 コア経路(core/src/session.ts + permission.v2.\*)— run 経路に乗っていない
- mini 以外の UI
- `maxSteps` 天井のツール送出停止(既存挙動はプロンプト注入のみ。統一は将来の別変更)
- bash 経由の書き込み(リダイレクト等)のファイルスコープ — edit/write/patch のみが対象。
  bash の統制は従来どおり permission ルールと契約文の領分
- 予算の永続ルール化(`always` 相当)や日次/週次予算 — セッション単位のみ

## 対象ファイル / インターフェース

### P1 予算(サーバーコア)

- `packages/core/src/v1/config/agent.ts` — agent config schema に
  `budget: Schema.optional(Schema.Struct({ soft: Schema.optional(Schema.Number), hard: Schema.optional(Schema.Number) }))`
  を追加(USD)。`steps` の隣。
- `packages/core/src/session/runner/budget.ts` — **新規**。純粋ロジック:
  - `type BudgetState = "ok" | "soft" | "hard"`
  - `budgetState(cost: number, budget?: { soft?: number; hard?: number }): BudgetState`
    (hard 設定済みかつ cost >= hard → "hard"、soft 設定済みかつ cost >= soft → "soft"、他 "ok"。
    hard < soft のような変則値でも hard 判定を優先)
  - `BUDGET_HARD_PROMPT` — MAX_STEPS_PROMPT と同型の強制報告文(予算超過版)
  - `budgetSoftNotice(cost, soft)` — soft 超過中に毎ステップ注入する1〜2行の縮退指示
    (現在コストと soft 値を含む。委譲かレポートへ畳めという文言)
- `packages/opencode/src/agent/agent.ts` — `Info` schema(:35-56)に `budget` を追加し、
  config agent / .md frontmatter agent から伝搬(frontmatter が ConfigAgent schema を
  通ることを確認の上)。native agent は未設定のまま。
- `packages/opencode/src/session/prompt.ts` — steps 天井(:1178-1179)の隣で enforcement:
  - セッション累計コスト = **全アシスタントメッセージの cost 合計**。projected `msgs` は
    compaction で切り詰められるため使わない — セッションの全メッセージ履歴
    (`sessions.messages(...)` 相当)か、既存のセッション集計があればそれを使う。
    毎ステップの全履歴走査が重い場合はループ外で初期合計を取り、step-finish ごとの増分
    (processor が `ctx.assistantMessage.cost` に加算する値)をループ内で累積してよい。
  - `budgetState === "hard"` → `isLastStep` と同じ経路で `BUDGET_HARD_PROMPT` を注入し、
    **さらに `tools` を空にして** llm 呼び出しへ渡す(プロンプト注入だけの maxSteps より
    一段強い決定的強制。空 tools で下流が壊れないことを確認)。
  - `budgetState === "soft"` → リクエスト messages 末尾に `budgetSoftNotice` を
    assistant ロールで注入(MAX_STEPS_PROMPT :1281 と同型)。持続的・毎ステップでよい。
  - どちらも永続メッセージには保存しない(リクエスト時注入のみ、maxSteps と同じ)。
- テスト: `packages/opencode/test/session/budget.test.ts` — budgetState の境界値
  (未設定 / soft のみ / hard のみ / 両方 / hard<soft / cost=閾値ちょうど)、
  notice/プロンプト文言の存在検査。

### P2 task ファイルスコープ

- `packages/opencode/src/tool/task.ts` — params(:43-62)に
  `files: <string配列, optional>` を追加。description は「この委譲ユニットが編集してよい
  パス(プロジェクトルート相対、glob 可)。指定時、範囲外への edit/write/patch は構造的に
  deny される。空配列は読み取り専用委譲」。
- `packages/opencode/src/agent/subagent-permissions.ts` —
  `deriveSubagentSessionPermission` の入力に `files?: string[]` と解決基準ディレクトリを追加。
  `files` 指定時、返却 ruleset の**末尾**に
  `{ permission: "edit", pattern: "*", action: "deny" }` +
  files 各要素を絶対パス化した `{ permission: "edit", pattern: <abs>, action: "allow" }`
  を追記する。評価は findLast(後勝ち)+ セッション権限はエージェント権限の後にマージ
  (`src/session/tools.ts:87`)なので、この追記が子エージェント自身の設定にも後勝ちする。
- 事前確認: edit/write/apply_patch が permission `"edit"` に渡す pattern の形
  (絶対パスか)を実装時に確認し、files の正規化(cwd 結合・`~` expand)を合わせる。
  ディレクトリ指定を許すなら `dir` と `dir/**` の両形を allow に展開する。
- 注意: `Permission.disabled()`(index.ts:204-214)は「permission に最後に合致する規則が
  `pattern:"*"` の deny」ならツールを隠す。末尾が per-file allow なら edit ツールは見え、
  `files: []` なら `*` deny だけが残り edit 系ツールが子から消える(意図された挙動)。
- テスト: `packages/opencode/test/agent/subagent-permissions.test.ts`(既存があれば追記)—
  スコープ内 allow / スコープ外 deny / 子エージェント自身の edit allow 設定より後勝ち /
  files 未指定で従来と同一 / 空配列で edit 系 disabled。

### P3 permission 可視化(deny イベント + permission.ask フック配線)

- `packages/schema/src/v1/permission.ts`(:61-66 の Asked/Replied の隣)—
  `Denied` イベントを追加。payload: `{ sessionID, permission, patterns, tool? }`。
  core/v1/permission の再エクスポート経由なら core 側も追随。
- `packages/opencode/src/permission/index.ts` — ask() の deny 経路(:75-79)で
  `DeniedError` を返す**前に** `events.publish(Event.Denied, ...)` を発行。
- `packages/opencode/src/session/tools.ts` — ctx.ask ラッパー(:82-96)で、
  `Permission.ask` を呼ぶ前に `Plugin.trigger("permission.ask", request, { status: undefined })`
  を発火(Plugin.Service は prompt.ts が SessionTools.resolve に提供済み。permission
  レイヤー本体に Plugin 依存を足すと層循環の恐れがあるため、ツール発の権限が全て通る
  この単一チョークポイントで配線する)。フック結果は**追記ルールに翻訳**する:
  `status: "allow" | "deny" | "ask"` → ruleset 末尾に
  `{ permission: request.permission, pattern: "*", action: <status> }` を追記してから
  従来どおり `Permission.ask` を呼ぶ。deny はネイティブの deny 経路(=P3 の Denied
  イベント発行を含む)に自然合流し、フック未応答(status 未設定)は完全に従来挙動。
- HttpApi / イベント schema 変更後、`packages/client` で `bun run generate`。
  生成物 diff をコミットに含める。依存方向(Schema → Core/Protocol → Server)を守る。
- テスト: deny 時に Denied イベントがバスに載ること(EventV2Bridge 購読で観測)、
  フック status→追記ルール翻訳の純関数テスト、フック deny がダイアログなしで
  DeniedError になること。

### P4 ガバナンス UI(見た目)

- `packages/opencode/src/cli/cmd/run/footer.view.tsx` — statusline のコストピル
  (:498-500)を予算対応に拡張。現在セッションの agent(state の `agents: RunAgent[]` から
  名前で引く)に budget があれば `$0.42/$1.50` 形式(分母は soft、soft 未設定なら hard)。
  色: ok=muted / soft 超過=warning / hard 超過=error(`budgetState` を core から import)。
  budget 未設定なら従来表示のまま。
- `packages/opencode/src/cli/cmd/run/subagent-data.ts` + `footer.subagent.tsx` —
  子セッションの message イベントから cost を集計し(session-data.ts:859 の抽出と同型)、
  タスク行の末尾に muted で `$0.03` を表示(cost 0 のときは非表示)。
- `packages/opencode/src/cli/cmd/run/stream.transport.ts` ほか — P3 の
  `permission.denied` イベントを購読し、scrollback に muted の1行通知
  (例: `✗ permission denied: bash "git push origin main"`)を出す。サブエージェント由来は
  該当タスク行コンテキストに畳む(scrollback 通知は自セッション分のみで可)。
- 予算閾値交差の scrollback 通知 — クライアント側で cost 信号と budget から検出し、
  soft/hard 各1回だけ `◈ budget: soft $1.50 crossed ($1.52)` 様の行を出す。
- `packages/opencode/script/ui-gallery.tsx` — 新 UI 状態をカタログへ(同一チェンジ内必須):
  1. 予算ピル ok(分数表示)
  2. 予算ピル soft 超過(warning 色)
  3. 予算ピル hard 超過(error 色)
  4. コスト付きサブエージェントタスク行
  5. permission denied 通知行
  6. 予算交差通知行
- 配色・文言は opencode のテーマトークンと既存ピルの語彙に従う。絵文字は使わず
  既存の記号語彙(◆ ✎ ☐ ◈ ✗)に揃える。

## 振る舞い

### 予算

- 予算はセッション単位・そのセッション自身のアシスタントメッセージ cost 合計に対して判定。
  compaction 後も全履歴基準で数える(projected msgs は使わない)。
- soft 超過: 以後の各ステップのリクエスト末尾に縮退指示を注入。ツールは使える
  (委譲・コミット・検証という「畳む」経路を塞がない — dotfiles v2.3.1 の教訓)。
- hard 超過: 次ステップは強制最終ステップ。BUDGET_HARD_PROMPT を注入し tools を空で送る。
  モデルはテキスト報告しかできない(無報告死・ブロック課金ループの構造的排除)。
- hard 超過後に新しいユーザープロンプトが来た場合も、コストが hard を超えている限り
  各ターンは同じ強制最終ステップになる(質問への応答は可能、ツールは不能)。継続したければ
  budget を上げるか新セッション。これは仕様(ドキュメントコメントに明記)。
- budget 未設定の agent(native 含む)は一切影響なし(完全 opt-in)。

### task files

- `task(files: ["src/foo.ts", "test/foo.test.ts"])` → 子セッションは列挙パス以外への
  edit/write/apply_patch が deny(復帰可能なツールエラーとしてモデルに返る — 委譲先は
  範囲外に触れず、必要なら報告で返す。dotfiles の「deny はルーティング信号」の思想)。
- files 未指定 → 従来挙動(スコープなし)。互換性維持。
- 空配列 → edit 系全 deny + ツール自体が子から不可視(読み取り専用委譲: verifier 型)。
- 範囲は edit permission のみ。bash は対象外(スコープ外に明記済み)。

### permission 可視化

- ルール deny・フック deny の双方で `permission.denied` イベントがバスに載る。
  プラグインは `event` フックで deny 連打を観測できるようになる(README 残欠陥①の根治)。
- `permission.ask` フックはツール発の全 permission 要求で発火。プラグインが
  status を返せば後勝ちルールとして合成され、返さなければ挙動不変。
- UI: deny は muted 通知行として見える。無言死・無言 deny の撲滅。

## フェーズ分割

- P1 budget-core | deps:- | done: agent config の budget が Info まで伝搬し、soft 超過で
  縮退指示注入・hard 超過で強制最終ステップ(tools 空)になる。budget.test.ts が境界値を
  カバー | verify: `packages/opencode` で `LANG=C LC_ALL=C bun test test/session/budget` +
  `bun typecheck`(core も)+ Agent.Info が API に載るため `packages/client` で
  `bun run generate`
- P2 task-file-scope | deps:- | done: task の files で子セッションの edit が構造的に
  スコープされ、未指定は従来どおり、空配列で edit 系不可視 | verify: `packages/opencode` で
  `LANG=C LC_ALL=C bun test test/agent/` + `bun typecheck`
- P3 permission-events | deps:- | done: ルール deny が permission.denied を発行、
  permission.ask フックが配線され status が後勝ちルールに翻訳される、client 再生成済み |
  verify: `packages/opencode` で `LANG=C LC_ALL=C bun test test/permission/`(新設)+
  `bun typecheck`(opencode/core/schema/client)+ 生成物 diff の確認
- P4 governance-ui | deps:P1,P3 | done: 予算ピル3状態・タスク行コスト・denied 通知行・
  予算交差通知行が実装され gallery カタログに6状態が追加済み | verify:
  `LANG=C LC_ALL=C bun run ui-gallery -- --check` + `LANG=C LC_ALL=C bun test test/cli/run/` +
  `--visual` PNG 目視

## 検証(完了の定義)

- [ ] `packages/opencode` で `bun typecheck` が通る(core / schema / client も触った場合は各所で)
- [ ] `packages/opencode` で `LANG=C LC_ALL=C bun test test/session/ test/agent/ test/permission/ test/cli/run/` が通る(repo root からは実行しない)
- [ ] `LANG=C LC_ALL=C bun run ui-gallery -- --check` がドリフトなしで通り、gallery diff がコミットに含まれる
- [ ] `LANG=C LC_ALL=C bun run ui-gallery -- --visual` の PNG で新6状態の配色を目視確認
- [ ] schema/HttpApi 変更後に `packages/client` で `bun run generate` 済みで、生成物 diff がコミットに含まれる
- [ ] エンドツーエンド(擬似 TTY、memory/inline-ui-verification-recipes.md の手順):
  1. budget 付き agent 設定でセッションを起動 → statusline に分数形式の予算ピルが出る
  2. task に files を渡した委譲で、範囲外 edit が deny エラーとして委譲先に返る
     (unit テストで代替可: evaluate() のスコープ判定)
  3. deny 発生時に scrollback へ通知行が出る(gallery スナップショットで代替可)
