# Detachable-by-Default Startup (Server-First + Auto-Attach) — Spec

## 目的

デフォルトの `opencode` 対話起動を「**先にサーバー子プロセスを spawn し、TUI は
純粋な HTTP attach クライアントとして動く**」構成に切り替える。これによりターンが
最初から TTY を持たないプロセスに住むため、**ターン実行中でも `/detach` は
「クライアントが即座に退出するだけ」**になり、現行の `whenIdle()` 待ち
（`runtime.queue.ts`）と spawn-handoff は不要になる。

マスター決定事項（2026-07-22）:

1. **デフォルト有効**。オプトアウトは CLI フラグ＋config の両方で用意する。
2. `/exit`（通常終了）は**サーバーも停止**する（tmux の `exit` 相当）。
3. 起動時に既存の発見レコード（生きているサーバー）があっても**常に新規 spawn**
   （警告は表示する）。
4. ターン実行中の `/detach` 時、TUI ローカルキューは**サーバーへ引き渡す**。

## 現状事実（調査確定、dev @ 4e3aa7d8a）

- ローカル対話モードはサーバー同居の in-process fetch
  （`packages/opencode/src/cli/cmd/run.ts:1047-1054`）。attach モードは
  `createOpencodeClient` による実 HTTP クライアント（`run.ts:429-435`）で、
  runtime 入口が分かれている: ローカル= `runInteractiveLocalMode`
  （`run/runtime.ts:1095`、`onDetach` あり）、attach= `runInteractiveMode`
  （`runtime.ts:1148`、`onDetach` なし・`onShutdown` あり）。
- **attach モードでは `/detach` は無言の no-op**（`runtime.queue.ts` の分岐は
  `input.onDetach` が undefined のためスキップ）。SIGHUP は即 `process.exit(0)`
  （`runtime.ts:483`）。
- **クライアント退出はサーバー側ターンを中断しない**。対話プロンプトは
  fire-and-forget の `promptAsync`（`run/stream.transport.ts:1460`）で送信され、
  クライアントはイベント購読で完了を見ているだけ。サーバーへ abort を送るのは
  Ctrl+C の `onInterrupt` → `sdk.session.abort`（`runtime.ts:435-448`）のみ。
  → 「クライアントが消えてもドレイン継続」という本 SPEC の核心はすでに成立済み。
- `spawnDetachChild`（`run/detach.ts:22-70`）: `serve --port 0 --hostname
127.0.0.1` を `detached: true` で spawn。env は `OPENCODE_DETACH_CHILD=1`、
  `OPENCODE_SERVER_PASSWORD`、`OPENCODE_DIRECTORY`、`OPENCODE_PROJECT_ID`、
  任意で `OPENCODE_DETACH_SESSION_ID` / `OPENCODE_DETACH_HANDOFF`。
  子が発見レコードを書くのを 500ms 間隔・最大 10s ポーリング。
- 子（`cli/cmd/serve.ts:26-46`）が `Discovery.write` で
  `<data>/server/<projectID>/server.json`（0600）を書く。handoff 消費は
  `serve.ts:55-107`（ファイルを読んで即 unlink し、legacy 同期エンドポイント
  `session/{id}/message` へ**逐次** self-POST）。
- `Discovery.write` は**無条件上書き**（`server/discovery.ts:20-24`）。
  stale 検出（pid 生存＋HTTP ヘルス、失敗時レコード削除）は
  `Discovery.resolve`（`discovery.ts:73-83`）にのみ存在。
- `POST /server/shutdown`（`routes/instance/httpapi/handlers/server.ts:19-44`）:
  204 応答後に dispose → `Discovery.remove` → `process.exit(0)`。
- TUI ローカルキューは attach モードでも存在するが、クライアント終了時に
  `close()` が破棄する（`runtime.queue.ts:107-112`）— attach 側には handoff
  経路がない。
- エディタ起動・shell モード・`/new`・Ctrl+C 中断は共有 runtime にあり
  **両モードで動作**する（`run/runtime.lifecycle.ts:284-304`、
  `stream.transport.ts:1379-1405`）。

## スコープ外

- 非対話実行（`opencode run "msg"` のワンショット）、`opencode serve`、
  `opencode attach`、`opencode stop` の挙動変更。すべて現状維持。
- オプトアウト時（`--no-detach` / config 無効化）の従来ローカルモードの挙動変更。
  既存の live `/detach`（whenIdle＋spawn-handoff）・SIGHUP in-place daemonize は
  そのまま残す。
- 同一サーバーへの複数クライアント同時 attach の新規保証。
- リモート（非 127.0.0.1）サーバー、mDNS、クラスタリング、Windows。
- V2 durable inbox 経由の引き渡し・post-crash 継続リカバリ（SPEC-attach-resume.md
  のスコープ外判断を踏襲）。
- `detach.sighup` 設定（従来どおり未実装のまま）。

## 設計判断

- **有効判定**: CLI フラグ `--no-detach`（yargs boolean `detach`、既定 undefined）
  ＞ config `detach.enabled`（optional boolean）＞ 既定 `true`。
  config は `packages/core/src/config/detach.ts` を新設（`experimental.ts` の
  Schema.Class パターンと `src/config` の self-export パターンに従う）し、
  `Config.Info`（`packages/core/src/config.ts:29`）へ optional `detach`
  フィールドとして接続する。
- **適用範囲**: 対話 TUI 起動のうち `--attach` でないものすべて
  （bare / `--continue` / `--session` を含む）。有効時はローカル in-process
  分岐（`run.ts:1042` ほか）の代わりに「spawn → HTTP クライアント」経路へ入る。
- **セッション選択は現行 bare `opencode` と同一**: 既定は新規セッション作成
  （attach コマンドのピッカーは**使わない**）、`-c` は最新継続、`-s <id>` は
  指定再開。`/new` `/sessions` は共有 runtime 経由で従来どおり。
- **キュー引き渡しは新エンドポイント `POST /server/handoff`**
  （`groups/server.ts` の `/server/shutdown` と同じ instance グループ）。
  body: `{ sessionID, prompts: [...] }`（既存 handoff ファイルの JSON 形と同形）。
  204 を即返し、長寿命 scope に fork したファイバーが**セッションのアクティブ
  ターン完了（idle）を待ってから** `serve.ts:55-107` と同じ逐次 self-POST で
  実行する。この逐次ドレイン部は serve.ts から共有ヘルパーへ抽出し両者で使う。
  公開 `HttpApi` 変更なので `packages/client` から `bun run generate` を実行する
  （`src/generated*` 直編集禁止）。
- **`/detach` 時の record sessionID 更新はクライアント側の read-modify-write**
  （`Discovery.read` → sessionID を差し替えて `Discovery.write`）。同一マシン・
  0600 ファイルであり、新規エンドポイントを増やすほどの境界ではない。

## 振る舞い

### 起動（detachable 有効時）

1. projectID を解決（attach.ts:81-90 と同じ `Project.Service.fromDirectory`
   方式。フル instance ロードは不要）。
2. `Discovery.read(projectID)` にレコードがあり pid 生存なら警告を表示:
   旧サーバーの url / pid と「レコードは新サーバーで上書きされる。旧サーバーへは
   今のうちに `opencode attach <url>` するか `kill <pid>` すること」。
   **表示後、無条件に新規 spawn を続行**（マスター決定 3）。
3. `spawnDetachChild` を流用して子を spawn。起動レイテンシのためポーリング間隔を
   パラメータ化し、この経路では 50ms を使う（live `/detach` 経路は 500ms のまま）。
   親は自分が生成した password を保持し、レコードから url を得て
   `createOpencodeClient`（Basic 認証）を構築する。
4. **spawn 失敗時（10s 以内にレコードが現れない）**: 警告＋ログパス
   （`<log>/detach-<projectID>.log`）を表示し、従来の単一プロセスローカルモードへ
   フォールバックして続行する。
5. `runInteractiveMode` を **`onDetach` を新たに配線して**起動する（後述の
   即時デタッチ動作）。`onShutdown` は従来 attach と同じ
   `POST /server/shutdown`。

### `/detach`（detachable 有効時 = 即時デタッチ）

`whenIdle()` を**待たない**。順に:

1. キュー昇格を停止（既存 `detaching` フラグ相当）。
2. ローカルキューが非空なら snapshot（順序保持）を `POST /server/handoff` へ送信。
3. 発見レコードの sessionID をアクティブセッション ID へ更新（read-modify-write）。
4. DetachSummary（sessionID・url・`opencode attach` での再接続案内）を表示して
   クライアント終了。サーバー側の実行中ターンはそのまま継続する。

handoff POST が失敗した場合はデタッチを中止し、キューを復元して従来同様の
エラー行を表示し、接続を維持する（`runtime.queue.ts:322-336` の中止パターンを
踏襲）。

### `/exit`・Ctrl+C 二度押し・`/shutdown`

いずれも `POST /server/shutdown` → クライアント終了（マスター決定 2）。
ターン実行中の `/exit` はターンごとサーバーを止める（従来ローカルモードの
プロセス終了と同じ意味論であることを docs に明記）。shutdown POST が失敗した
場合（サーバー既死）もクライアントは終了し、`Discovery.remove` を試みる。
Ctrl+C **一度押し**は従来どおり `sdk.session.abort` によるターン中断のみ。

### SIGHUP（端末死）

ベストエフォートでキュー handoff POST（短いタイムアウト）と record sessionID
更新を試みてから `process.exit(0)`。サーバーは生き残るため**SIGHUP が
そのまま自動デタッチになる**（in-place daemonize はこのモードでは使わない）。

### クライアントクラッシュ

サーバーは生存し `opencode attach` で再接続可能。未送信ローカルキューは失われる
（既知の制限として docs に明記）。

### 既知の制限（受容済み）

- 常に新規 spawn＋レコード無条件上書きのため、デタッチ済みサーバーが残った状態で
  新規起動すると旧サーバーは発見不能になる（起動時警告で緩和。マスター決定 3）。
- 再 attach 時、実行中ターンの未コミット部分はリプレイに現れず、コミット済み
  part から表示される（既存 ScrollbackSurface の表示モデルどおり）。
- 起動レイテンシは子プロセス起動分だけ増える。50ms ポーリングで緩和し、実測値を
  PR 説明に記録する（ハードゲートにはしない）。

## 対象ファイル / インターフェース

- `packages/opencode/src/cli/cmd/run.ts` — detachable 起動分岐（spawn →
  HTTP クライアント → `runInteractiveMode`）、`--no-detach` フラグ、
  server-mode 用 `onDetach` / `/exit` shutdown 配線。
- `packages/opencode/src/cli/cmd/run/detach.ts` — `spawnDetachChild` の
  ポーリング間隔パラメータ化と password/url の返却。legacy 経路は挙動不変。
- `packages/opencode/src/cli/cmd/run/runtime.ts`・`runtime.queue.ts` —
  `runInteractiveMode` への `onDetach` 受け入れ、`/detach` 分岐の即時モード
  （whenIdle スキップ）、SIGHUP のベストエフォート handoff。
- `packages/opencode/src/server/routes/instance/httpapi/groups/server.ts`・
  `handlers/server.ts` — `POST /server/handoff` の追加。
- `packages/opencode/src/cli/cmd/serve.ts` — handoff 逐次ドレインの共有
  ヘルパー抽出（endpoint と boot 時消費の両方から使用）。
- `packages/core/src/config.ts`・`packages/core/src/config/detach.ts`（新規）—
  `detach.enabled` 設定。
- `packages/client` — `bun run generate`（HttpApi 変更後）。
- `packages/web/src/content/docs/{tui,cli,server}.mdx` — 英語版のみ更新
  （既存方針どおり、他言語は翻訳待ち）。
- `packages/opencode/test/e2e-detachable.sh`（新規）— 検証ハーネス。

## ハーネス env ノブとポーリング方式

`e2e-detachable.sh`・`e2e-detach.sh`・`e2e-detach-live.sh` は固定 `sleep` の
代わりに早期リターン付きポーリングを使う（実測で合計 ~14 分の固定 sleep を
削減）。各スクリプトの先頭で以下の env 変数を `${VAR:-default}` で読む。
デフォルト値は既存の固定 sleep より短い締切にならないよう選んである
（早期リターンで速くなる分だけ得をする設計。ワースト側は退行しない）:

- `E2E_STARTUP_TIMEOUT`（既定 30）— TUI 起動・attach 接続・発見レコード出現
  など「準備完了」待ちのポーリング締切（秒）。
- `E2E_TURN_TIMEOUT`（既定 90）— ターン／queue handoff の完了待ちポーリング
  締切（秒）。
- `E2E_POLL_INTERVAL`（既定 0.5、小数可）— ポーリング間隔（秒）。
- `E2E_TOOL_SLEEP`（既定 12）— プロンプト内で使う `sleep N` ツール呼び出しの
  秒数。ターン開始検出がポーリングに変わったことで、旧来の固定 15–20s 待ちより
  短い秒数でも「/detach やキュー投入の時点でまだターンが実行中」という前提を
  保てる。

主なポーリングパターン:

- **TUI/attach 起動待ち**: discovery record の出現（`wait_for_record_any`
  系、既存）、または pane に `Ask anything` プレースホルダが現れるまで
  ポーリング（`wait_for_tui_ready`）。
- **ターン開始待ち**: `packages/opencode/src/cli/cmd/run/tool.ts` の
  `headerBash` がツール実行中に `Bash(<command>)` ヘッダをレンダリングする
  ことを利用し、pane に `Bash(sleep <N>)` が現れるまでポーリングする
  （`wait_for_pane`）。プロンプトのエコーとは異なる文字列なので誤検知しない。
- **ターン完了待ち**: attach 済み client がなくサーバー側で継続中のケースは
  DB（SQLite の `part`/`message` テーブル）をポーリングする
  (`wait_for_session_text` / `wait_for_project_text`)。マーカーが一意でない
  プロンプトには nonce
  （`$$` 由来のユニーク文字列）を追加してから DB を検索する。

`bun typecheck` ゲート（`e2e-detach.sh` item a、`e2e-detach-live.sh` item a）
は `E2E_SKIP_TYPECHECK=1` でスキップできる（スキップ時も明示的に
"skipped" 行を出し、結果一覧の項目数は変えない）。

## フェーズ分割

- P1 server-first 起動 | deps:- | done: bare `opencode` が子サーバーを spawn し
  TUI が HTTP クライアントとして新規セッションで起動する。`-c`/`-s` も同経路。
  `--no-detach`・config で従来モードに戻る。spawn 失敗時は警告付きフォールバック。
  既存レコードありの場合の警告表示 | verify: `packages/opencode` で
  `bun typecheck`、実機スモーク（起動→プロンプト 1 往復→ps で 2 プロセス確認）
- P2 detach/exit 意味論 | deps:P1 | done: ターン実行中 `/detach` が即時に
  summary を出して退出しサーバーがターンを完走、record sessionID 更新、
  `opencode attach` で結果閲覧可。`/exit`・Ctrl+C 二度押し・`/shutdown` で
  サーバー停止＋レコード削除。SIGHUP でサーバー生存 | verify: 実機で各操作、
  `server.json` とプロセス生死を確認
- P3 キュー引き渡し | deps:P2 | done: `POST /server/handoff` が idle 待ち後に
  逐次実行。`/detach`・SIGHUP でローカルキューが送信され、attach で両ターンの
  結果が見える。`bun run generate` 済み | verify: `packages/client` で
  `bun typecheck`、長時間ツール＋キュー 1 件→`/detach`→attach の実機確認
- P4 e2e＋docs | deps:P3 | done: `e2e-detachable.sh`（起動/フォールバック/
  即時 detach/exit=停止/SIGHUP 生存/キュー handoff/オプトアウト回帰）が
  2 連続全緑。既存 `e2e-detach.sh`・`e2e-detach-live.sh` も全緑（legacy 経路
  無傷の確認）。docs 更新 | verify: 各スクリプト実行×2、`bun typecheck`

## 検証（完了の定義）

- [ ] `packages/opencode`・`packages/core`・`packages/client` それぞれで
      `bun typecheck` が緑。
- [ ] 新規 `test/e2e-detachable.sh` が 2 連続全緑。最低限のケース:
      (a) bare 起動で親子 2 プロセス＋レコード生成、(b) ターン実行中 `/detach`
      →親即退出→子がターン完走→`opencode attach` で応答表示、(c) `/exit` で
      両プロセス終了＋レコード削除、(d) SIGHUP でサーバー生存、(e) 長時間ツール
      ＋キュー 1 件→`/detach`→両ターン完走・順序保持、(f) `--no-detach` で
      従来単一プロセス起動、(g) spawn 失敗時フォールバック。
- [ ] 既存 `test/e2e-detach.sh`・`test/e2e-detach-live.sh` が引き続き全緑
      （オプトアウト経路の無回帰）。
- [ ] 実機確認: detachable モードで permission プロンプトの往復・エディタ起動・
      shell モード・`/new` が従来どおり動く（HTTP 経路でのパリティ確認）。
- [ ] 実機確認: handoff ドレインが実行中ターンの完了を待ってから開始される
      （e2e (e) のアサーションで順序を固定）。
- [ ] 起動レイテンシの実測値（legacy 比）を PR 説明に記録。
