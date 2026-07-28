# RENOVATION-2 — 全体コードレビューと第二次改修計画

> **Status:** 🟢 裁可済 (R0-R1 着手可) — 2026-07-28 起草・同日マスター裁可 (決定 1,2,3,5)。実行者: vanamei。残決定: http-recorder (R5)・R3 スライス順 (SPEC-p3d 起草時)。全パッケージ監査 (並列 6 系統の探索 + 中核コード精読) に基づく。先行: `RENOVATION.md` (2026-07-24, 実施済)。破壊的アーキテクチャ変更を許可する前提で策定。

## 総評

Renovation 1 は当初診断の 4 大因のうち「プロセス寿命管理」「エラー経路の一部」を構造的に潰し、detach/attach を e2e で固めた。その上で現在のコードベースを一言で診断すると:

**最大の構造問題は、止まったままの V1→V2 移行が全レイヤーを二重化していること。** セッションエンジン・LLM スタック・プロバイダ記述 (3 箇所)・ツールレジストリ・権限・設定・イベント・直列化・HTTP 面・SDK・CLI のほぼ全てに「現役の V1」と「未完の V2」が並存し、相互不認識のまま同一 SQLite に書いている。重複はコピペ腐敗ではなく未完遂の移行であり、対処は「完遂」しかない (2026-07-24 裁可の V2 完遂型と整合)。

もう一つの致命的事実: **このフォークで CI が green になったことは一度もない。** 全 test/typecheck ランは blacksmith ランナー待ちのまま 24h 後に cancel されており、直近の全コミット (HEAD の attach-session-binding 含む) は自動検証ゼロで dev に入っている。約 12 万行のテスト資産が存在するのに、強制されているゲートは pre-push の typecheck のみ。

規模 (TS、生成・node_modules 除く): opencode 186k (src 89k) / core 67k (src 34k) / sdk 31k (97% 生成) / llm 20k / codemode 10k / ほか小粒。総計約 33 万行。

V2 コア (packages/core) の設計品質は監査で裏付けられた — 耐久 admission と実行の分離、Location スコープ、1 ターン 1 `llm.stream`、イベント+射影の原子コミットは実際に成立している。**V2 は「正しい骨格・未完の機能」** (機能面は V1 の約 1/3)。方針は正しく、道筋の具体化と二重期間の安全化が欠けている。

## 発見カタログ (Severity 順)

### S1 検証基盤 — CI は死んでいる

- `.github/workflows/test.yml:31,33,94,96` の `runs-on: blacksmith-*` は本フォークからアクセス不能。全ランが 24h queue 後 cancelled。**green の実績ゼロ** (検証済: 直近ランはジョブ未割当のまま失効)。
- test.yml の e2e ジョブは削除済み `packages/app` を対象にし、参照する catalog キー `@playwright/test` も存在しない — 構造的に実行不能。
- `bun run test` は `--only-failures` 付き (packages/{opencode,core}/package.json) のため既定で全数実行されない。
- `turbo test` の対象は opencode/core のみ。llm (テスト 8.3k 行)・codemode・client・httpapi-codegen・http-recorder は対象外。
- 旗艦機能 (detach/attach/handoff) を守る tmux e2e 4 本はどこからも起動されない。PLAN.md:20 の記録どおり、この層だけがユニットテスト不可視の実バグ 6 件 (OOM kill・proc.kill デッドロック含む) を検出してきた。
- `beta.yml` が 1〜2h ごとに永久 queue のゴミランを積み続けている (本日も継続を確認)。
- SDK 生成物 (30k 行、63 ファイルが型参照) に PR ゲートなし。`generate.yml` が dev へ自動コミットで後追い修正し、エラー通知分岐はコメントアウト済み — 破壊的 API 変更が「マージ後の dev 赤」として顕在化する構造。

### S2 セッションコア — V1/V2 の相互不認識

- 直列化 2 系統: V1 `session/run-state.ts:38` の Runner Map と V2 `core/src/session/run-coordinator.ts:28`。相互参照ゼロ。**同一セッションを V1 ループと V2 drain が同時実行し得る** (SPEC-v2-seam.md:42 の既知残余リスクそのもの)。
- V1 abort (`server/httpapi/handlers/session.ts:282-285`) は `SessionExecution.interrupt` を呼ばず、**V2 実行を停止できない**。
- 耐久 admission を経ずに V1 実行へ入る経路が 6 つ残存: summarize / command / shell / `tool/task.ts:196` / `github.handler.ts:895,943` / `control-plane/workspace.ts:158` (`core/src/session/input.ts:246-249` に既知として列挙)。
- HTTP セッション面が 2 つ (`/session/*` V1、`/api/session/*` V2)、同一 SQLite テーブルに書く。
- ID 採番カウンタ 2 系統: `opencode/src/id/id.ts:19-21` の手書きコピー vs `schema/identifier`。同 ms 採番の単調性が ID 族間で不成立 (両者ソートキー)。

### S3 V2 の正しさ負債 (増築前に返すべき)

- **V2 の create が V1 イベントを発行** (`core/src/session.ts:242` `SessionV1.Event.Created`)。V2 の `history()`/`events()` は自セッションの作成イベントを再生できない。projector は V1/V2 両系統を写像し (`projector.ts:216-455`)、`session/sql.ts` に両テーブル族が同居。
- wake 起動 drain の失敗 Exit は誰も await しない (`run-coordinator.ts:37-49`)。`execution/local.ts:19` の "Session not found" die はログ経路の外で完全消失。位置不一致は `Effect.interrupt` で無音離脱 (`runner/llm.ts:180-181`)。
- Txn 規律: `{behavior: "immediate"}` はイベントコミット経路のみ。`promoteSteers` / `failUnsettledTools` は N イベント N txn (クラッシュで部分昇格)。create は project 挿入と Created 発行が別 txn。
- 逆向き依存: core → `@opencode-ai/sdk/v2/types` (3 ファイル、package.json 未宣言の phantom dep。SDK はサーバから生成される側)。
- compaction の `llm.stream` (`compaction.ts:189`) は publish-llm-event を通らず usage 会計に乗らない。`Step.Ended` の cost は 0 固定 (`runner/llm.ts:331`)。
- defect を制御フローに使用 (`TurnTransitionError` を die→catchDefect、`LifecycleConflict` 同型)。
- 細目: サービスキー `"@opencode/example/LocationServiceMap"`、`drizzle.config.ts:8` の `/home/thdxr` パス、`SessionEvent.Retried`/`Compaction.Started` の projector 不在、`src/effect/dfdf` ゴミファイル。

### S4 二重化の全体像

| レイヤー           | V1 (現役)                                                                                                                                                                                                        | V2 (状態)                                                                                                                                                                              | 方針                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| セッションエンジン | `opencode/session` 8,166 行。`prompt.ts` 1,686 行が 28 サービスを 1 Layer に解決                                                                                                                                 | `core/session` 3,703 行。骨格良・shell/skill/compact/wait は `OperationUnavailableError` スタブ (`session.ts:387-424`)。subagent/task・MCP・retry・title/summary・耐久 run status なし | V2 完遂 (R3)                    |
| LLM                | AI SDK (`session/llm` + `provider/transform.ts` 1,558)                                                                                                                                                           | `packages/llm` ネイティブ 8.7k 行、`experimentalNativeLlm` 既定 off                                                                                                                    | native 一本化 (R3)              |
| プロバイダ記述     | `provider.ts:168-960` の custom() 22 分岐 792 行 + BUNDLED 20                                                                                                                                                    | `llm/providers` + `core/plugin/provider` 27 ファイル + ベンダー同梱 `core/github-copilot` 4,517 行 — **同一情報が 3 箇所**                                                             | keep-set へ縮減 (R1) 後に一本化 |
| ツール             | `opencode/tool` 5,923 行 (19 個)                                                                                                                                                                                 | `core/tool` 2,675 行 (9 ツール二重実装)                                                                                                                                                | V2 完遂 (R3)                    |
| 権限               | V1 ask/reply + LLM judge                                                                                                                                                                                         | `PermissionV2` (saved は共用で良い形)                                                                                                                                                  | V2 完遂 (R3)                    |
| 設定               | スキーマの実体は `core/v1/config` (103 ファイルが参照)、ローダは `opencode/config`                                                                                                                               | `core/config` V2 断片は未接続 (~700 行)                                                                                                                                                | v1 schema を中立化して一本 (R3) |
| イベント           | `GlobalBus` (EventEmitter)                                                                                                                                                                                       | `EventV2` (bridge 71 行は薄く適切)                                                                                                                                                     | V1 撤去時に自然解消             |
| HTTP 面            | `opencode/server/httpapi` 7,310 行 — protocol をほぼ使わず legacy 111 paths。エラー 13 クラスが `protocol/errors.ts` と同名重複、middleware 三重定義                                                             | `protocol`+`server` の 51 `/api/*` paths。**境界テストで機械強制済みの綺麗な層だがトラフィックが乗っていない**                                                                         | 清流側へ収斂 (R4)               |
| SDK                | `sdk` hey-api 生成 30k (v1 `src/gen` 6.8k は 5/12 から化石) — 63 ファイルが依存                                                                                                                                  | `client` (in-house codegen、PR ゲートあり) — 消費者は sdk-next のみ。`sdk-next` は**消費者ゼロ**                                                                                       | client 一本 (R4)                |
| CLI                | `opencode` 24 コマンド                                                                                                                                                                                           | `packages/cli` = 別バイナリ `lildax`。本体と非互換の第二 discovery を持ち、参照ゼロで CI publish される                                                                                | 削除を推奨 (裁可待ち)           |
| util 群            | `token.ts` の 1 行 re-export が正解の形。iife 同一 / lazy 分岐 (**core 側は throw 後に undefined を恒久キャッシュするバグ**) / wildcard 分岐 (match は同義、all/allStructured は opencode のみ) / error・id 分岐 |                                                                                                                                                                                        | re-export 型へ統合 (R2)         |

### S5 テスト完全性

- **monitor モック素通し**: `test/tool/monitor-autostart.test.ts:37-40` の `Layer.mergeAll(LayerNode.compile(...), mock)` は compile 時点で実 `EventV2Bridge` が焼き込まれモックが届かない (検証済)。line 265 の要断言 (`stoppedEvents).toHaveLength(0)`) は**恒真**。`monitor.test.ts:23-42` も同型で実バスへ発行。正しい API は `compile(root, [[Node, mockLayer]])` (webfetch.test.ts:14 ほかで実績)。
- 実時計 sleep + 経過時間断言 (`monitor-autostart:229` の <500ms) — CI 稼働と同時にフレーク化確実。
- 恒久 skip 15+: `test/v2/session-message-updater.test.ts` 全 3 件、`llm-native-recorded.test.ts:407` が録画行列全体を無効化、footer.view 5 件、0 バイトの `test/config/plugin.test.ts`。
- `e2e-detach-live.sh` 項目 (h) は P3b 以降の陳腐化断言で常時赤 (既知)。
- `globalThis.fetch` 差し替えが 2 ファイル (http-recorder が同居しているのに)。
- `core/test/session-runner.test.ts` 3,365 行の単一ファイル。

### S6 死蔵・腐敗 (即焼却可能)

ルート: `artifacts/` (Remotion 動画 + コミット済み mp4)・`github/` (upstream Action。`.github/` と紛らわしい)・`sdks/` (workspace 外の vscode 拡張)・`install` (存在しない releases を指す)・`STATS.md` (upstream の DL 統計)・`screenshot-uk.png`・`sst-env.d.ts`×3・`specs/` 13 本 (全て切断前。`tui-package.md` は削除済みパッケージの spec)・`HANDOFF.md` (7/17、出荷済み内容と矛盾)・`PLAN.md` (完了済。6 バグ記録は SPEC.md へ移設の価値あり)・`nix/desktop.nix` + `flake.nix:45,63`・`patches/install-korean-ime-fix.sh`・upstream 運用系 workflow 約 15 本・`script/publish.ts:51,54-55` (存在しないパスで publish 破損)・README の画像参照全滅 (`packages/console`/`web`)・CONTRIBUTING の app/desktop 記述。

コード: `sdk-next` 333 行 (embedded host ~30 行のみ client へ移植)・`sdk/js/src/gen` 6,819 行 (v1 importers 6 件を /v2 へ移行)・`cli/ui/spinner.ts` 368 行 (importer ゼロ)・`cli/ui/parsers-config.ts`+shim 386 行・`src/temporary.ts`・`storage/` 327 行 (実質 NotFoundError 1 個と ignore された write 1 個のため)・`session/message.ts` 148 行・`server/projectors.ts`+`init-projectors.ts` (no-op)・`sync/README.md` (存在しない API の記述 179 行)・core 側: `effect/dfdf`・`plugin/layer-map.example.ts`・`util/array.ts`・`data-migration.sql.ts`・死重複 `core/{patch,snapshot,id}.ts` 510 行・未接続 config 断片 ~700 行・死 config オプション (`attribution`/`watcher`/`layout`/`autoshare`)・死 export 約 40。

挙動疑義: `opencode web` — UI パッケージ消滅後もサーバを立ててブラウザを開く。

### S7 CLI / run UI の局所負債

- `run.ts:394-1444` の 1,050 行ハンドラ (ネスト 11 段)。detach/shutdown/fetch クロージャが三重複製。`runMini()` は偽 argv でハンドラへ再入し、新フラグが tui/attach 経由で無音 undefined になる構造。
- テーマエンジンの丸ごとフォーク (`cmd/run/theme.ts` vs `cli/ui/theme`、~600-800 行重複。差分は変数名程度)。
- 状態の三重保持: `RuntimeState` (24 フィールド) / `RunFooter` (約 50) / transport `State` — model/agent/variant/sessionID が三箇所に併存。
- `footer.command.tsx` に同型の選択パネル 7 連コピー (+sessions で 8)。
- boot の 5 リゾルバ全てが `.catch(() => 空)` (`runtime.boot.ts:213-245`) — **サーバ異常が「空の正常」に見える**。`server/discovery.ts` も全 fs エラーを無へ。
- `Session.remove` が try/catch で握り潰し、削除失敗でも true を返す (`session/session.ts:613-641`)。
- OAuth callback サーバのモジュールグローバル 5 複製 (xai:301 / codex:151 / snowflake:34 / digitalocean:37 / mcp/oauth-callback:9) — 同一プロセスで localhost ポートを取り合う。
- `monitor.event`/`monitor.stopped` が SDK の Event union に不在で、monitor ピルのデータ経路全体が `as string` (`stream.transport.ts:184` ほか)。
- 循環 import 2 対: provider⇄transform、agent⇄skill⇄truncate。
- `lsp/server.ts` 1,983 行・`format/formatter.ts` 404 行はデータのコード化 (34 サーバ定義・20 フォーマッタ定義)。

## 第二次改修計画

方針: V2 完遂型を継続。順序は「**検証を立てる → 燃やす → 縫い目を塞ぐ → 台帳を潰す → V1 を抜く**」。各フェーズは独立にコミット・ゲート通過可能。ゲートは Renovation 1 と同じ: 全パッケージ `bun test` + `bun typecheck` + build + e2e-detachable 7/7 (+フェーズ固有条件)。

### R0 検証基盤の復旧 (0.5-1 日) — 全ての前提

1. `test.yml`/`typecheck.yml` の runs-on を `ubuntu-latest` へ (windows 行は削除)。壊死 e2e ジョブ削除。`beta.yml` と upstream 運用系 workflow (~15 本) を削除。
2. `--only-failures` を `test:failed` へ隔離し、`test` は全数実行へ。`turbo.json` の test 対象を全テスト保有パッケージへ拡大。
3. SDK 生成ゲート: PR で `sdk/js build` + `git diff --exit-code` (R4 で生成パイプラインごと退役するまでの命綱)。`generate.yml` の dev 自動コミットを廃止。
4. monitor モック配線を `compile(root, [[EventV2Bridge.node, mock]])` へ修正。**恒真だった断言が火を吹く前提で調査時間を確保。** 実時計断言の除去、0 バイトテスト削除、e2e-detach-live 項目 (h) の陳腐化断言更新。
5. `e2e-detachable.sh` 7 項目を nightly + 手動 dispatch で CI 化 (tmux/jq/sqlite3 セットアップ込み)。
6. `.gitignore` に `*.swp`。

ゲート: **このフォーク史上初の CI green。**

### R1 焼却 (1-2 日) — 純削除

S6 の全リスト + プロバイダ縮減 (keep-set 裁可後): `custom()` 19 分岐・BUNDLED 17・`@ai-sdk/*` 17 依存・ベンダー plugin 5 本 (~2,300 行)・`core/plugin/provider` 24 本 (~1,400 行)。copilot を落とす場合は `core/github-copilot` 4,517 行も。`opencode web`・`packages/cli` は裁可に従い処理。

概算削減: TS 実装 ~15-20k 行 + 生成物/文書/バイナリ多数。

### R2 縫い目の封鎖 (3-5 日) — 二重期間を安全化

1. **直列化一本化**: `SessionRunCoordinator.make` に per-call work 口を追加し、V1 Runner を 6 契約 (busy/cancel/status/shell latch/戻り値/BusyError) のファサードへ縮退 (SPEC-v2-seam §直列化の宿題)。並走窓を閉鎖。V1 abort に `SessionExecution.interrupt` を接続。
2. **admission 完全化**: 残 6 経路 (summarize/command/shell/task/github/workspace) を耐久 admission 経由へ。
3. **V2 正しさ負債の返済**: V2 `Session.Created` イベント新設 + projector + migration (V1 Created 発行を置換 — R3 の増築前に必須)。coordinator に onSettle フックで全 drain Exit を可観測化、`local.ts` の die をログ経路内へ、force 伝播修正。Txn 方針統一 (immediate 全面化 + 複数イベント操作の外側 txn 化)。`TurnOutcome` 閉和型で defect 制御フローを排除。phantom dep 解消。
4. ID を `schema/identifier` へ一本化。util 群 (iife/lazy/wildcard/error) を re-export 型へ統合 — core `lazy.ts` の throw 後キャッシュバグを先に修正、`all`/`allStructured` は core へ移植。
5. テーブル単一書き手: todo/revert を core 委譲アダプタ化 (`background/job.ts` が手本)。
6. OAuth callback を 1 サービス化 (スコープ付きポートリース)。

ゲート: 通常ゲート + 同一セッション並走の回帰テスト新設。

### R3 パリティ完遂 (数週間・本丸) — 台帳駆動

`specs/v2/session.md` の missing 10 項目 + 監査で確定した不足 (subagent/task・MCP ツール・retry/timeout 方針・title/summary・耐久 run status・shell/skill/compact/wait 実装・tool runtime 残: formatter/LSP 診断/snapshot 連携) をスライス化して core へ実装。並行して LLM native 化: keep-set プロバイダを `packages/llm` へ移植 → `experimentalNativeLlm` 既定 on → AI-SDK 経路 (~4k 行 + 17 依存) 削除。config は `v1/config` を `core/config` へ中立化・改名 (103 ファイルの機械的追随)。

着手前に `/spec` で SPEC-p3d を起草し、スライス順を確定させること (Renovation 1 の教訓)。各スライスの受け入れ = 台帳 status 更新 + 対応テスト。

ゲート: 台帳 missing 0、native LLM 既定 on、全ゲート green + 1 日 dogfood。

### R4 V1 撤去と一本化 (1-2 週) — P3d 実行

1. TUI/CLI の実行経路を V2 (`/api`) へ切替 → `SessionPrompt.loop`/processor/`session/llm`/run-state 撤去 (~8k 行)。
2. HTTP 面の収斂: legacy 111 paths をグループ単位で `protocol` groups + `server` handlers へ移設 (httpapi-codegen が自動追随)。完了後に `matchLegacyOpenApi` 518 行・`openapi.json` 1MB・hey-api・regex patch 3 種を一括退役。`sdk` は `client` の薄い re-export → 廃止。`plugin` の型参照を client へ。エラー語彙は `protocol/errors.ts` 一本、middleware 実装は server 一本。
3. CLI 整形: `run.ts` を 3 起動戦略 + 単一 detach controller へ分割、`runMini` 廃止。テーマエンジン統合。footer 状態の単一所有化 (`FooterModel` store)。`SelectPanel` primitive 化。`httpapi-codegen` を `client/script` へ吸収。

ゲート: 全ゲート + e2e + 1 日 dogfood + タグ (`renovated-2`)。

### R5 最終衛生 (1 日)

README/README.ja/CONTRIBUTING をフォークの実態へ書き直し。SPEC 群と旧 specs/ を `specs/archive/` へ整理。バージョン/catalog 統一 (effect ハードコード 4 箇所、version 欠落 4 パッケージ)。`http-recorder` の抽出/公開判断の実行。`lsp/server.ts`/`formatter.ts` のデータファイル化。

## 最終形 (パッケージグラフ)

```
schema ──→ protocol ──→ server ←── core ←── llm ←── schema
   │            │          ↑         ↑
   │            ↓          │         │
   └──────→ client (生成物 + embedded host + codegen script)
                           │
              opencode (CLI + run UI の薄殻) ──→ plugin
              codemode / effect-drizzle-sqlite / effect-sqlite-node (独立葉)
```

- パッケージ 18 → 11。生成コード 31k → ~5k 行。**API 定義 1・codegen 1・クライアント 1・エラー語彙 1・エンジン 1・LLM スタック 1・直列化 1。**
- 総削減見込み: 実装 TS で 6〜8 万行規模 + 生成物/JSON ~6 万行 (R1 で 1/4、R3-R4 で残り)。
- 既に機械強制されている境界テスト (client の browser-bundle 検査、contract-identity) は現行のまま最終形の守りになる。

## 裁可が必要な決定

1. **プロバイダ keep-set** — ✅ 裁可 (2026-07-28): **anthropic + openai + opencode**。github-copilot も落とす → `core/github-copilot` 4,517 行を含めて削除。
2. **packages/cli (`lildax`)** — ✅ 裁可 (2026-07-28): **削除**。
3. **`opencode web`** — ✅ 裁可 (2026-07-28): **コマンド削除**。
4. **http-recorder** — 未裁可。推奨: 別リポへ抽出 or npm 公開 (低優先、R5 で再提示)。
5. **CI ランナー** — ✅ 裁可 (2026-07-28): **ubuntu-latest 即時置換** (homelab self-hosted 化は別件)。
6. **R3 スライス順** — SPEC-p3d 起草時に確定。

## リスクと緩和

- R3 が長丁場 (機能移植の実装量が支配項)。→ V1 は R4 完了まで常用のまま。R2 で二重期間を安全化してから着手し、native LLM は既存フラグで段階 cutover。
- 削除の巻き添え。→ R0 の CI 復旧を必ず先行。フェーズごと全ゲート + タグ。
- 生成 SDK 退役の互換性。→ 外部消費者ゼロ (未公開フォーク) を確認済み。`sdk` の廃止は R4 の最後。
- monitor 恒真断言の裏に実バグが隠れている可能性。→ R0 で顕在化させ、修正は独立コミットで。

## Appendix: 6 Production Bug Records (from P4 E2E, July 2026)

These bugs were found and fixed during P4 live two-agent E2E testing. Preserved
here as reference after PLAN.md was deleted in R1.

(a) monitor child tied to per-call scope died on tool return → Scope.provide(scope) + forkChild
(b) monitor.event/stopped not routed in stream.transport sid() → rows never rendered
(c) permission.replied/judged event-order race ate Auto-allowed rows and stuck the judging pill
(d) loadSkills unbounded concurrency made duplicate-name skill resolution a race → sequential
(e) run --interactive was a dead flag (handler read args.mini)
(f) flood guard OOM-killed the whole session (yes hello, systemd oom-kill 実測): unbounded stdout queue + per-line pipeline let the heap balloon before the batch guard fired, and killing from inside the stdout consumer deadlocked proc.kill → chunk-level 1MB/60s byte guard before line splitting, Queue.dropping(1000), flood teardown moved to the owner fiber via Deferred, drain-only mode after trip, double monitor.stopped publish guarded.
