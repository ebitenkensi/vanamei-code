# Attach Session Resume + Detach Queue Handoff — Spec

> **Status:** ✅ Shipped — P1–P4 完了(2026-07-21, `4e3aa7d8a`)。設計判断は `SPEC-detachable-default.md` に踏襲されている。

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
- Protocol / Server `HttpApi` の公開スキーマ変更。キュー引き渡しは下記のとおり
  handoff ファイル＋子の legacy 経路実行（D 案）で行うため、Protocol 変更も
  `PromptPayload` への delivery/resume 追加（A 案）も SDK 再生成も不要。
- V2 durable inbox（`session_input`）経由の引き渡し（旧 B/C 案）。**実測で棄却**
  （2026-07-21）: projector は V1 イベント→legacy `message`/`part`、V2 イベント→
  `session_message` を**別系統で射影**し相互橋渡しがなく、V2 runner の履歴読み
  （`packages/core/src/session/history.ts`）は `session_message` のみを見る。
  そのため V2 admit した引き渡しプロンプトは (a) 子の V2 drain が legacy 履歴を
  一切見えないまま実行し（文脈喪失）、(b) 応答は `session_message` 側にのみ
  書かれ attach リプレイ（legacy `sdk.session.messages`）に表示されない。
  この統合（射影の一本化）は本 SPEC のスコープ外の V2 移行課題とする。

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
  3. **flush（D 案・handoff ファイル方式、2026-07-21 実測により確定）**:
     親は `state.queue` の各プロンプトを検証したうえで、順序保存の handoff
     ファイル `<Global.Path.data>/server/<projectID>/handoff.json`（0600）に
     書き出す。内容は `{ sessionID, prompts: [{ parts }] }`（parts は先頭
     テキスト part＋添付 part の legacy PromptInput parts 写像）。
     **messageID は含めない**（実測 2026-07-21）: 親で先行採番した ID は実行中
     ターンの後続メッセージより小さく、ID 順で読む legacy 履歴では handoff の
     user メッセージが完了済みアシスタントの**前**に並ぶため、子の loop が
     「未応答入力なし」と誤認して 1ms で即終了する。送信時にサーバーへ採番
     させれば正しく末尾に並ぶ（`PromptPayload.messageID` は optional）。
     親 TUI は終了するので採番済み ID の UI 整合は不要。
     接続点は従来決定どおり `onDetach` コールバックのシグネチャ拡張:
     runtime.queue 側は whenIdle 後に `fn(true, queuedPrompts)` を渡すだけ、
     ファイル書き出しと検証は `run.ts` の onDetach 実装内で行う
     （runtime.queue へ sdk や core service を注入しない）。
     - `state.queue` に `/command` 系（`/new` のテキスト形式含む）・shell
       プロンプトが残っている場合、それらは TUI ローカルな意味論であり
       引き渡せない。その場合は detach を**中止**して TUI に警告を出す
       （無言破棄の禁止に準拠）。
  4. 子プロセス spawn。親は `OPENCODE_DETACH_HANDOFF=<path>` env を子へ渡す
     （handoff ファイルを書いた場合のみ）。子（serve.ts detach bootstrap）は
     サーバー起動・server.json 書き出し後に handoff ファイルを読み、即座に
     削除してから、各プロンプトを**逐次**（前のターンの完走を待って次を送る）
     自分自身の legacy 同期 prompt エンドポイントへ self-POST（basic auth＋
     `x-opencode-directory` ヘッダ、in-process instance ロード機構を再利用）
     して実行する。legacy 経路で実行するため、履歴は legacy テーブルに書かれ、
     attach リプレイ・文脈継続・ライブストリームのすべてが従来セッションと
     一貫する。失敗したプロンプトは detach ログへ記録し後続は継続する
     （読み取り直後にファイルを消すのは、実行途中クラッシュ時の重複再生を
     避けるため。クラッシュ耐性は legacy 経路の従来水準と同等の best-effort）。
  5. `footer.close()`。
  - flush が失敗した場合は **detach を中止**して TUI にエラーを表示する。無言で
    破棄してはならない。中止時は `detaching` を false へ戻し、`onDetach` の
    one-shot ガード（`input.onDetach = undefined`）も復元して、キューを保持した
    まま再試行可能な状態に戻すこと。
  - リスク注記（履歴）: 旧 B/C 案の V2 `session_input` 経由は 2026-07-21 の
    実機スモークで「admit・子の promote・応答生成までは成功するが、V2 drain が
    legacy 履歴を見えず、応答も attach リプレイに表示されない」ことを実測し
    棄却した（スコープ外セクション参照）。D 案の nonce 判定 e2e（P4）を
    引き続き合格ゲートとすること。
  - ハザード注記: flush をターン完了**後**（step 2 の後）に行うのは、実行中
    ターンと handoff プロンプトの順序を保存するため。子は handoff を自分の
    legacy 経路で逐次実行するので、親内で次ターンが始まる競合はない。
    この順序を変えないこと。
  - `runtime.queue.ts:139` の誤ったコメントを実挙動に合わせて修正すること。
- **案内メッセージ**: `/detach` 成功時に detach 先 URL・セッション ID・
  `Reattach: opencode attach` を表示。detach 経由の終了では splash の
  `opencode --mini -s` 案内を出さない（または attach 系に差し替える）。
- **SIGHUP と live detach の競合ガード**（実測 2026-07-21、e2e item h の
  フレークとして顕在化）: live `/detach` が子を spawn しレコードを書いた後、
  親の終了前に SIGHUP（端末クローズ）が届くと、SIGHUP 自動デタッチが
  その場 daemonize を発動し**死にゆく親の pid でレコードを上書き**する。
  次の attach はこれを stale と誤検知してレコード削除→接続失敗となる。
  対策: live detach 完了後の SIGHUP は即クリーン終了、live detach 進行中
  （flush〜spawn、`detachPending`）の SIGHUP は無視して完走させる。flush
  中止時はフラグを戻し SIGHUP 自動デタッチを再武装する。残エッジ:
  `/detach` 投入後〜whenIdle 完了前の SIGHUP は従来どおり in-place
  daemonize が走り得る（その場合 live spawn と競合しうるが、ターン実行中
  の端末断という二重障害であり許容。将来課題）。

## 対象ファイル

- `packages/opencode/src/server/discovery.ts` — `Record` に `sessionID?: string`。
- `packages/opencode/src/cli/cmd/run/detach.ts` — `DetachInput.sessionID`、
  `OPENCODE_DETACH_SESSION_ID` env、SIGHUP パスの `Discovery.write` 拡張。
- `packages/opencode/src/cli/cmd/serve.ts` — detach-child bootstrap で env の
  sessionID を server.json へ（P1 実装済み）。handoff ファイルの読み取り・
  削除・逐次 self-POST 実行（P2）。
- `packages/opencode/src/cli/cmd/attach.ts` — `--new` フラグ、レコードから
  sessionID を取り出し `runMini` へ伝搬。
- `packages/opencode/src/cli/cmd/run.ts` — attach 時の `session()` を解決規則＋
  ピッカー起動に変更（P1 実装済み）、`onDetach` へのアクティブセッション ID
  受け渡し（P1 実装済み）、onDetach 実装内での検証＋handoff ファイル書き出し
  （P2）。
- `packages/opencode/src/cli/cmd/run/detach.ts` — `DetachInput` に handoff
  パスを追加し spawn 時に `OPENCODE_DETACH_HANDOFF` env を子へ（P2）。
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
      （推奨: 小文字 nonce の**全大文字化** — 応答にしか現れず、かつ逆順出力と
      違い小型モデルでも綴りを誤らない。実測 2026-07-21: deepseek-v4-flash-free
      が逆順で x を脱字し偽 FAIL）で判定し、プロンプト自身の echo への誤マッチ
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
