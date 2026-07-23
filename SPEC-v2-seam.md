# V2 Seam Unification — Spec (RENOVATION P3)

2026-07-24 起草。RENOVATION.md P3 の実施仕様。診断 (`instability-diagnosis`) の原因 2 (エラー経路) と 3 (V1/V2 二重経路・attach 縫い目) を構造的に除去する。

## 目的

TUI の prompt 経路を「揮発 fire-and-forget」から「耐久 admission + 単一直列化」へ移し、attach の snapshot/live 縫い目をシーケンスで固定する。V1 実行ループ (`SessionPrompt.loop`) は挙動パリティの実行器として残すが、直列化と入力台帳は V2 コアに一本化し、二系統の相互不認識を解消する。

## 決定事項(調査に基づく方針確定)

1. **V1 loop の即時撤去はしない。** V2 runner のパリティ台帳 (`specs/v2/session.md` §V1 Runtime Context Parity) に missing が10項目 (plugin hooks / @mention 展開 / provider 基底指示 / per-prompt overrides / reminders 等) あり、日常運用 (agmsg plugin・skills・TUI) が依存する。撤去は本仕様の Phase 4 (別途) にステージし、本体では「二重経路の害」を先に殺す。
2. **直列化権威は core `SessionRunCoordinator` に一本化する。** `SessionRunState.Runner` は独立した直列化機構をやめ、busy 判定・cancel 連鎖・status 発火・shell latch・最終 assistant 返却という V1 専用責務だけを coordinator の上のファサードとして残す。
3. **プロンプト admission は耐久化する。** instance httpapi の `prompt`/`prompt_async` は実行前に `session_input` 相当の耐久行を書き、V1 実行が user message を可視化した時点で promoted を刻む (V1→V2 promotion bridge)。これにより defect でターンが死んでも「受理済み入力」が消えない。serve.ts の detach carry-forward wake は未 promoted 行のみを拾うため、二重実行は起きない。
4. **attach は「subscribe 確立 → snapshot → buffered drain」の順序を厳密化し、未知 message への part イベントは fetch-on-miss で解決する。** e2e の RETRY は撤去し、素の green を受け入れ条件とする。

## 対象ファイル / インターフェース

- `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` — prompt/prompt_async: 実行前 admission、defect 時も admission 行が残ることを保証。
- `packages/opencode/src/session/prompt.ts` — user message 可視化時に promotion bridge を呼ぶ。`loop` の直列化を coordinator 移譲に置換。
- `packages/opencode/src/session/run-state.ts` — Runner の serialization を `SessionRunCoordinator` へ委譲。busy/cancel/status/shell/戻り値の各契約は維持 (Q4 の 6 契約)。
- `packages/core/src/session/input.ts` — V1 実行から promoted を刻む口 (`projectPrompted` 相当) の公開。
- `packages/opencode/src/cli/cmd/run/stream.transport.ts` — attach handshake: SSE `server.connected` 受領を snapshot fetch の前提にする。part イベントの親 message 不在時は該当 message を単発 fetch して合流。
- `packages/opencode/test/e2e-detachable.sh` — `attach_and_wait_for_nonce` の RETRY 分岐を撤去。

## 振る舞い

### admission (Phase 2)

- `POST /session/:id/prompt_async` は 204 を返す前に耐久 admission 行を書く。実行 fiber が defect で死んだ場合: (a) P2 の onExit finalize が assistant を閉じ、(b) admission 行は pending のまま残り、(c) `Session.Event.Error` が飛ぶ。再 wake (detach carry-forward / 明示 resume) は pending 行から再開できる。
- V1 実行が prompt を可視化 (user message insert) した同一論理ステップで promoted を刻む。可視化済みプロンプトの行が pending に留まることはない。
- messageID 再利用の意味論は `SessionV2.prompt` と同一 (exact retry 合流 / 齟齬は conflict)。

### 直列化 (Phase 3)

実装調査の結果 (2026-07-24)、core の `SessionRunCoordinator.make({drain})` は構築時固定 drain の汎用ファクトリで、V1 の任意 work を per-call で受ける口がない。V1 Runner を coordinator ファサードへ縮退させるには core API の拡張 (per-call work) と V1 の queueing/BusyError/status/shell 契約の再実装が必要で、V1 実行器が現役のまま行う変更としては過大 — Runner 縮退は P3d (V1 撤去) と同時に行う。

本リノベーションでの P3c 実施分:

- coordinator 外の Session 書き込みの busy 保護監査: `remove` (セッション削除)・`deletePart`・`updatePart` が無防備だったため `assertNotBusy` を追加 (deleteMessage と同一契約)。revert/unrevert/shell/deleteMessage は既存保護を確認。
- 残余リスクの記録: /api 経由の V2 admission (wake あり) と V1 ターンが同一 Session で並走する窓は upstream 由来のまま残る。TUI 経路は P3b の即時 promote により実質的に閉じている。carry-forward wake は child boot 時のみで V1 ターン開始前。完全な単一飛行化は P3d で。

### attach (Phase 1)

- attach クライアントは (1) SSE subscribe、(2) `server.connected` 受領、(3) snapshot fetch (`session.messages`)、(4) buffered drain (dedup 維持) の順を保証する。
- drain/live 中に親 message 不明の part/message 更新が来たら、その messageID を単発 fetch して状態へ合流させる (取りこぼしの自己修復)。
- 受け入れ: e2e-detachable.sh item (b) を RETRY なしで 5 連続 green。

## フェーズ分割

各フェーズ独立に検証・コミット可能。ゲート: packages/opencode `bun test` + `bun typecheck` + build + e2e-detachable 7/7。

1. **P3a attach 縫合** — stream.transport の handshake 厳密化 + fetch-on-miss + e2e RETRY 撤去。
2. **P3b 耐久 admission + promotion bridge** — handlers/session.ts と prompt.ts と input.ts。二重実行なきことを e2e (e) (queue handoff) で確認。
3. **P3c 直列化一本化** — run-state.ts の coordinator 委譲 + busy/cancel/status/shell 契約テスト維持。
4. **P3d V1 loop 撤去 (将来・別スペック)** — パリティ台帳の missing を潰し切ってから。本リノベーションでは着手しない。RENOVATION.md にこの旨を反映する。

## スコープ外

- V2 runner への plugin hooks / mention 展開 / provider 基底指示の追加 (P3d の前提作業)。
- クラスタリング・複数ノード所有権。
- 公開 `/api` 面の変更 (既存の `v2.session.events?after=` はそのまま)。
