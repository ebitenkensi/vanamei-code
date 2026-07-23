# Renovation Plan — フォーク切断と大改修

決定日: 2026-07-24 / 方針: **V2完遂型** / 切断点: **queue-handoff 完了後の dev**

## 決定事項

- upstream (sst/opencode) dev の常時追走を停止する。remote は残し、以後は provider/セキュリティ修正の cherry-pick のみ。
- セッションコアは V2 (packages/core: durable inbox / SessionRunner / EventV2) に一本化し、レガシー `SessionPrompt.loop` を撤去する。detach 引き継ぎ・queue-handoff の耐久セマンティクスを土台として維持するため。
- 日常運用の `~/.local/bin/vanamei` は検証済みタグのビルドに固定する(HEAD ビルドの dogfood をやめる)。

## 背景(診断の要約)

2026-07-24 実施の不安定性診断より。詳細はセッションメモリ `instability-diagnosis` 参照。

1. プロセス寿命管理の欠落 — serve にシグナルハンドラなし、`Discovery.remove` は server.json の unlink のみ (src/server/discovery.ts)。server/ 配下に stale ディレクトリ41件。
2. エラー経路 — prompt 経路の typed→defect 洗浄 (session/prompt.ts) + promptAsync の catchCause→log のみ (handlers/session.ts)。defect 時に assistant メッセージが宙吊り。
3. V1/V2 セッションコア併存 — 直列化機構が2系統、attach の snapshot+live-only SSE にシーケンスカーソルなし (stale attach replay バグの根本原因)。
4. 増幅器 — 直近60日の入着コミット約1,100件中9割が upstream。無関係パッケージが LOC の約4割。

## フェーズ

各フェーズの完了条件: packages/opencode の e2e スイート green + タグ付きビルドで1日 dogfood。

### P0 凍結

- queue-handoff を dev へ収める(現在 3 ahead / 2 behind origin/dev)。
- `freeze-base` タグを打つ。以後 upstream の取り込みは cherry-pick のみ。

### P1 減量

- workspaces から drop-set を削除:
  - drop: app, console, ui, session-ui, stats, desktop, web, slack, enterprise, storybook, containers, function, identity
  - keep: opencode, core, llm, codemode, plugin, protocol, schema, script, sdk, sdk-next, server, client, http-recorder, httpapi-codegen, effect-drizzle-sqlite, effect-sqlite-node, cli, session-ui は依存グラフ精査後に最終判定
- ルート package.json の workspaces / catalog を keep-set に合わせて整理。
- `bun install` から `bun typecheck`・e2e まで green を確認し、ビルド/typecheck 時間の改善幅を記録。

### P2 即効安定化(小粒・独立)

- serve に SIGTERM/SIGINT/exit ハンドラ + Discovery クリーンアップ(ディレクトリ削除含む)。
- 起動時 stale レコード sweep + detached server の idle-shutdown。
- defect 時も assistant を finalize(`Effect.onInterrupt` → `onExit` 化)+ llm.ts/tools.ts の `.name` 無防備参照のガード。

### P3 本丸

- prompt_async を V2 経路 (SessionV2.prompt → SessionExecution) へ昇格し、`SessionPrompt.loop` と `SessionRunState.Runner` を撤去(直列化を SessionRunCoordinator に一本化)。
- SSE にシーケンスカーソル(after= バックフィル)を導入し、attach の snapshot/live 縫合を根治。e2e の stale-attach RETRY を撤去して素の green を確認。
- コーディネータ外の書き込み(admit / switchModel / switchAgent / revert)の直列化整理。

### P4 平坦化(任意)

- server/routes/instance/httpapi/handlers 等の深い階層の整理。
- claude-code 参照実装に倣う不変式の徹底: エラーはターンを綺麗に終える / 全 tool_use に tool_result / ユーザ入力は実行前に永続化(V2 inbox で担保済み)。

## upstream 同期方針(切断後)

- 対象: 利用中プロバイダ(anthropic ほか実使用の2〜3系統)の修正、セキュリティ修正のみ。
- 手順: upstream タグを確認 → 対象コミットを cherry-pick → e2e ゲート → dev。
- 頻度: 必要時のみ(定期追走はしない)。

## リスクと緩和

- 保有面積: 減量後も約20万行。→ P2/P3 で故障クラスを構造的に減らし、保守は e2e ゲートで守る。
- V2 完遂は upstream の半端な移行を引き継ぐ作業。→ P3 は spec を切ってから着手(`/spec`)。
- provider 層の陳腐化。→ 実使用プロバイダに絞った手動追随。切断は実質一方通行である点を了承済み。
