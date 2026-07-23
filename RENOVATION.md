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

仕様の正本は `SPEC-v2-seam.md` (2026-07-24 起草)。調査の結果、V2 runner のパリティ台帳 (`specs/v2/session.md`) に plugin hooks / mention 展開など missing が10項目あり、`SessionPrompt.loop` の即時全撤去は日常運用を壊すため、「二重経路の相互不認識の解消」を本体とする:

- P3a: attach handshake 厳密化 (subscribe→connected→snapshot→drain) + 未知 message の fetch-on-miss。e2e の stale-attach RETRY を撤去して素の green を確認。
- P3b: prompt/prompt_async の実行前 耐久 admission + V1 実行の promotion bridge (可視化と同時に promoted を刻む)。defect でも受理済み入力が消えない。
- P3c: coordinator 外書き込みの busy 保護 (remove/deletePart/updatePart に assertNotBusy 追加)。Runner の coordinator ファサード化は core API 拡張が前提のため P3d へ移動 (SPEC-v2-seam.md §直列化 参照)。
- P3d (本リノベーション外・将来スペック): パリティ台帳の missing を潰してからの `SessionPrompt.loop` 撤去 + 直列化の SessionRunCoordinator 一本化。

### P4 平坦化(任意)

- server/routes/instance/httpapi/handlers 等の深い階層の整理。→ 実施済: `src/server/routes/instance/httpapi` を `src/server/httpapi` へ移動 (routes/instance は素通し2階層だった)。歴史的 specs/ 文書内の旧パス言及は記録として据え置き。
- claude-code 参照実装に倣う不変式の徹底: エラーはターンを綺麗に終える (P2 onExit finalize で実装) / 全 tool_use に tool_result (V2 runner の failUnsettledTools + V1 processor の既存処理で担保) / ユーザ入力は実行前に永続化 (P3b の耐久 admission で実装)。

## 実施記録 (2026-07-24)

- P0: dev = queue-handoff 収容、タグ `freeze-base` (7aacdf351)。
- P1: 13パッケージ + infra + sst + sst-env.d.ts×16 削除、catalog/patch 整理、Web UI 埋め込み除去。副産物: automode スキーマスナップショット欠落の修正。
- P2: serve シグナルハンドラ + Discovery dir 削除 + 起動時 sweep + idle-shutdown (`server.idleTimeoutMinutes` 既定240) / assistant の onExit finalize + LLM.run agent ガード + compaction agent ガード (7/20 C.name defect の根本原因)。
- P3: P3a attach flush 辺の修復 (stale-attach 根治、e2e RETRY 撤去) / P3b 耐久 admission + V1 promotion bridge / P3c busy 保護追加。e2e はノンス乱数化 + 低速プロバイダ延長待機で決定化。
- P4: httpapi 平坦化。全フェーズのゲート: opencode 3235 pass / core 1074 pass / build / e2e 7項目 green。
- 未了: 各フェーズ共通の「タグ付きビルドで1日 dogfood」は wall-clock 作業のため運用へ引き継ぎ (タグ `renovated-base`)。P3d は将来スペック。

## upstream 同期方針(切断後)

- 対象: 利用中プロバイダ(anthropic ほか実使用の2〜3系統)の修正、セキュリティ修正のみ。
- 手順: upstream タグを確認 → 対象コミットを cherry-pick → e2e ゲート → dev。
- 頻度: 必要時のみ(定期追走はしない)。

## リスクと緩和

- 保有面積: 減量後も約20万行。→ P2/P3 で故障クラスを構造的に減らし、保守は e2e ゲートで守る。
- V2 完遂は upstream の半端な移行を引き継ぐ作業。→ P3 は spec を切ってから着手(`/spec`)。
- provider 層の陳腐化。→ 実使用プロバイダに絞った手動追随。切断は実質一方通行である点を了承済み。
