# Attach Session Resume + Detach Queue Handoff — Spec

## 目的

`/detach` → `opencode attach` の再接続で**元のセッションに戻れる**ようにする。
現状、素の `opencode attach` は接続には成功するが常に新規空セッションを作るため、
ユーザーには「セッション情報が失われた」ように見える。あわせて、`/detach` 時に
TUI ローカルキュー上のプロンプトが無言で消失するデータ損失バグを修正する。

## 現状の問題（調査確定事項、dev @ ab7061d1b）

1. **bare attach は常に新規セッション。** `session()`
   （`packages/opencode/src/cli/cmd/run.ts:458-535`）は `--session` / `--continue`
   がない限り無条件に `sdk.session.create(...)` を呼ぶ。発見レコード
   （`packages/opencode/src/server/discovery.ts` の `Record` 型）には sessionID
   フィールドが存在せず、attach が「detach 時のセッション」を知る手段がない。
   e2e（`packages/opencode/test/e2e-detach-live.sh`）は常に `--continue` 付きで
   しかテストしておらず、素の `attach` は未カバー。
2. **`/detach` でローカルキューのプロンプトが消失する。** ターン実行中に入力した
   プロンプトはクライアント側配列に積まれるだけでサーバーへ送られない
   （`runtime.queue.ts:331-339`）。`/detach` は `detaching` フラグで drain ループを
   dequeue **前**に break させ（同 138-141）、その後 `close()` がキューを破棄する
   （同 109-110）。139 行目のコメント「the child's bootstrap wake picks up the
   durable queue」は誤り — これらのプロンプトはサーバーに admit されていないため
   durable な行が存在せず、子の `wakeSessions()` には拾うものがない。docs
   （`packages/web/src/content/docs/tui.mdx:132` "any queued messages keep
   running"）と実挙動が矛盾している。
3. **再アタッチ案内が誤っている。** footer close 時の終了スプラッシュは
   `Continue: opencode --mini -s <id>` を提示するが、detach 後の正解は
   `opencode attach` 系である。`/detach` ハンドラ自体は何の案内も出さない。

なお以下は調査の結果**問題なし**（変更不要）: projectID は git remote/root-commit
ハッシュで決定的に解決され親→子へ env で値渡しされる。ストレージは XDG 配下の
単一 SQLite（WAL）で親子共有。実行中ターンは `whenIdle()` が完了を待つため
message/part は projector 経由で逐次永続化済み。

## スコープ外

- `opencode`（非 attach 起動）の既定動作変更。従来どおり常に新規セッション。
- クラスタ・リモート配置、post-crash 継続リカバリ。
- Protocol / Server `HttpApi` の公開スキーマ変更。調査（2026-07-21）で「legacy
  promptAsync は durable admit 不可」と確定したが、対応は下記のとおり**既存の
  V2 `session.prompt` エンドポイント**（公開済み・生成済み）を使うため、
  Protocol 変更も `PromptPayload` への delivery/resume 追加（A 案）も SDK
  再生成も不要。

## 設計判断（claude 決定済み）

- **発見レコードに `sessionID?: string` を追加**（optional、旧レコードは読み手が
  欠落を許容）。live `/detach` では親が detach 時点のアクティブセッション ID を
  `OPENCODE_DETACH_SESSION_ID` env で子へ渡し、子（`serve.ts` bootstrap）が
  server.json に含めて書く。SIGHUP in-place パスは `DetachInput` に sessionID を
  追加し `Discovery.write` に直接含める。
- **bare `opencode attach` の既定はセッションピッカー**（マスター決定 2026-07-21）:
  1. `--session <id>` — 従来どおり明示指定（ピッカーなし）。
  2. `--new`（新設フラグ）— 常に新規セッション作成（ピッカーなし、スクリプト用）。
  3. `--continue` — 従来意味を維持: プロジェクト最新の root セッションへ即復帰
     （ピッカーなし、既存 e2e・スクリプトの互換性維持）。
  4. フラグ無し＋**TTY**: セッションピッカーを表示して選択させる。
     - 一覧はプロジェクトの root セッション（`parentID` なし）を更新日時降順。
       各行にタイトル・相対時刻・ID 末尾を表示。
     - 発見レコードの `sessionID` に一致するセッションを**先頭に置き初期選択**
       とする（Enter 一発で detach 時のセッションへ復帰できること）。存在
       検証は `sdk.session.get` で行い、消えていれば単に一覧に出さない。
     - 「新規セッションを作成」を選択肢として一覧末尾に含める。
     - キャンセル（Esc / Ctrl-C）は何も作らず attach を中断して終了する。
     - UI は既存の `/sessions` パネル（`footer.command` 系 /
       `footer.sessions.tsx`）の部品を流用してよいが、セッション確定**前**の
       起動シーケンスで描画する必要がある点に注意。
  5. フラグ無し＋**非 TTY**（パイプ・スクリプト実行）: ピッカーは出せないため
     自動解決 — 発見レコードの `sessionID`（存在検証込み）→ 最新 root
     セッション → 新規作成、の順。
- `opencode attach <url>`（明示 URL、レコード無し）も同じ規則（TTY なら
  ピッカー、初期選択は最新セッション）。attach の意味論は「動いている
  サーバーの作業を見に行く」であり、黙って新規作成する現行挙動は廃止する。
- **キュー引き渡し**: `/detach` のシーケンスを以下に変更。
  1. `detaching = true`（従来どおり、以後のローカル promote 停止）。
  2. `whenIdle()` — 実行中ターンの完走を待つ（従来どおり）。
  3. **flush**: `state.queue` の各プロンプトを順序保存で durable admit する。
     実現方式（2026-07-21 確定、旧 B 案を置換）: legacy promptAsync は
     `SessionPrompt.prompt` へルーティングされ durable 行を作らないため
     使えないが、同じ HttpApi に **V2 の `session.prompt`** が既に存在する
     （`packages/protocol/src/groups/session.ts:204` 付近、
     `packages/server/src/handlers/session.ts` の "session.prompt" ハンドラが
     delivery/resume をそのまま `SessionV2.prompt` へ渡す）。run.ts が既に持つ
     `createOpencodeClient`（`@opencode-ai/sdk/v2`）の同一 sdk から
     `sdk.session.prompt({ sessionID, id, prompt, delivery: "queue",
resume: false })` を呼ぶだけで admit-only flush が成立する。in-process
     fetch 経由なので Protocol / HttpApi / SDK は一切変更しない。
     `SessionV2.Service` の直接 yield\* は不要（Effect ランタイム配管が増える
     だけで利点がない）。接続点は `onDetach` コールバックのシグネチャ拡張とし、
     runtime.queue 側は whenIdle 後に `fn(true, queuedPrompts)` のように
     キュー内容（割当済み messageID 込み）を渡すだけにして、flush は sdk と
     sessionID を既に持つ `run.ts` の onDetach 実装内で行う（runtime.queue へ
     sdk や core service を注入しない）。- messageID は `state.queued` の割当済み ID を payload の `id` として
     再利用して UI 整合を保つ。V2 の ID 再利用セマンティクス（同一
     Session+prompt+delivery の完全一致リトライのみ許容）とも整合する。- V2 `PromptInput.Prompt` は `{ text, files? }` 形で、per-message の
     agent/model/variant は載らない（V2 では switchAgent/switchModel による
     セッション状態）。flush はテキスト＋ファイル添付の写像で足り、子の
     wake がセッション現在の agent/model で実行するのは V2 の設計どおり。- `state.queue` に `/command` 系プロンプトが残っている場合、コマンドは
     TUI ローカルな意味論であり durable admit できない。その場合は detach
     を**中止**して TUI に警告を出す（無言破棄の禁止に準拠）。
  4. 子プロセス spawn（子の `wakeSessions()` が pending queue を検出して wake —
     既存実装のままで拾える）。
  5. `footer.close()`。
  - flush が失敗した場合は **detach を中止**して TUI にエラーを表示する。無言で
    破棄してはならない。中止時は `detaching` を false へ戻し、`onDetach` の
    one-shot ガード（`input.onDetach = undefined`）も復元して、キューを保持した
    まま再試行可能な状態に戻すこと。
  - リスク注記: 子の `wakeSessions()` が durable queue を実際に実行する経路は、
    これまで durable 行が一度も admit されていなかった以上**実運用で未検証**
    である（現行 e2e item (d) は緩い grep のため偽陽性で PASS していた可能性が
    高い）。legacy path で作られた履歴を持つセッションを V2 drain が正しく
    継続できるかを含め、P4 の nonce 判定 e2e を合格ゲートとすること。
  - ハザード注記: flush をターン完了**後**（step 2 の後）に行うのは、親プロセス内
    の serialized runner がドレイン継続評価で queued input を promote し、親内で
    次ターンを開始したまま親が exit する競合を避けるため。admit-only なので親内で
    wake も発生しない。この順序を変えないこと。
  - `runtime.queue.ts:139` の誤ったコメントを実挙動に合わせて修正すること。
- **案内メッセージ**: `/detach` 成功時に detach 先 URL・セッション ID・
  `Reattach: opencode attach` を表示。detach 経由の終了では splash の
  `opencode --mini -s` 案内を出さない（または attach 系に差し替える）。

## 対象ファイル

- `packages/opencode/src/server/discovery.ts` — `Record` に `sessionID?: string`。
- `packages/opencode/src/cli/cmd/run/detach.ts` — `DetachInput.sessionID`、
  `OPENCODE_DETACH_SESSION_ID` env、SIGHUP パスの `Discovery.write` 拡張。
- `packages/opencode/src/cli/cmd/serve.ts` — detach-child bootstrap で env の
  sessionID を server.json へ。
- `packages/opencode/src/cli/cmd/attach.ts` — `--new` フラグ、レコードから
  sessionID を取り出し `runMini` へ伝搬。
- `packages/opencode/src/cli/cmd/run.ts` — attach 時の `session()` を解決規則＋
  ピッカー起動に変更（P1 実装済み）、`onDetach` へのアクティブセッション ID
  受け渡し（P1 実装済み）、onDetach 実装内での v2 `sdk.session.prompt`
  admit-only flush（P2）。
- `packages/opencode/src/cli/cmd/run/session-picker.ts`（新規、P1 実装済み）—
  起動時ピッカー。footer UI 起動前のため `footer.sessions.tsx` は流用せず、
  既存依存 `@clack/prompts` の `select` を使用（`opencode account` と同じ部品）。
- `packages/opencode/src/cli/cmd/run/runtime.queue.ts` — onDetach シグネチャ
  拡張（キュー内容の受け渡し）・失敗時の状態復元・コメント修正。
- `packages/opencode/src/cli/cmd/run/runtime.lifecycle.ts` /
  `packages/opencode/src/cli/cmd/run/splash.ts` — 再アタッチ案内の修正。
- `packages/web/src/content/docs/{tui,cli}.mdx` — bare attach の新既定と `--new`
  を反映（英語版のみ、他言語は翻訳待ち慣例に従う）。
- `packages/opencode/test/e2e-detach-live.sh` — 下記 P4 の拡張。

## フェーズ分割（独立して検証・コミット可能）

- P1 Attach session picker & resume | deps:- | done: `/detach` → 素の
  `opencode attach`（TTY）でピッカーが出て初期選択の Enter で元セッションの
  会話が表示される。非 TTY では自動復帰 | verify: `bun typecheck` + e2e 新項目
- P2 Queue handoff fix | deps:- | done: ターン実行中に積んだプロンプトが detach
  後に子で実行される | verify: e2e item (d) 厳格化版
- P3 Messaging & docs | deps:P1 | done: 案内メッセージと docs が新挙動に一致 |
  verify: 手動確認
- P4 E2E 強化 | deps:P1,P2 | done: 下記検証項目が自動化されている | verify: 実行

## 検証（完了の定義）

- [ ] `bun typecheck` が `packages/opencode` で成功（リポジトリルートから実行
      しないこと）。
- [ ] e2e: `/detach` → 素の `opencode attach`（`--continue` なし、tmux/TTY）で
      ピッカーが表示され、初期選択（レコードのセッション）を Enter で確定すると
      元セッションの会話が表示される。セッション ID の一致を DB または API で
      assert する（pane テキストの緩い grep のみで判定しない）。
- [ ] e2e: 非 TTY の bare attach はピッカーを出さず、レコードのセッションへ
      自動復帰する。
- [ ] ピッカーのキャンセル（Esc）で新規セッションが作られずに終了する。
- [ ] e2e: ターン実行中に 2 個目のプロンプト投入 → `/detach` → attach 後に
      2 個目への**アシスタント応答**が存在する。応答にしか現れない nonce 変換
      （例: 指定文字列の逆順出力）で判定し、プロンプト自身の echo への誤マッチ
      を排除する（現行 item (d) の `grep "done"` はプロンプト echo に誤マッチ
      しうる欠陥がある）。
- [ ] flush 失敗時（サーバー停止を注入等）に detach が中止されキュー内容が TUI
      に残る。
- [ ] 旧形式レコード（sessionID なし）でも attach が最新セッション fallback で
      動作する。
- [ ] `opencode attach --new` で新規セッションが作られる。
- [ ] レコードの sessionID が削除済みセッションを指す場合、fallback が働く。
- [ ] `opencode`（非 attach）の既定動作は従来どおり新規セッション（リグレッション
      なし）。
