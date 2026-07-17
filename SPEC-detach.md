# Session Detach / Re-attach — Spec

## 目的

素の `opencode`（TUI + サーバー同一プロセス）で長いターンを実行中、`/detach`
コマンドでサーバーを TCP listener 付きの常駐プロセスへ昇格させ、ssh 切断でも
ターンを完走させ、後から `opencode attach`（URL 省略可）で再接続できるようにする。
Claude Code の `/bg` 相当。

## スコープ外

- クラスタ構成・リモート配置（あくまで同一プロセスの昇格）。
- post-crash 継続リカバリ（既存の durable inbox 設計とは独立）。
- mDNS 以外のネットワーク発見の新規実装（ファイルベース発見レコードのみ）。
- 既存 `serve` モードの挙動変更なし。

## 設計判断（claude 承認済み）

- 発見レコードは**プロジェクト単位**: `<Global.Path.data>/server/<projectID>/server.json`（0600）。
- P4 SIGHUP 自動デタッチは**デフォルト ON**。設定 `opencode.detach.sighup` で無効化可。
- P3 停止手段は `opencode stop` CLI サブコマンド **and** `/shutdown` TUI コマンドの両方。
- コマンド名: `/detach`（昇格）、`/shutdown`（接続先停止、attach 中のみ）。
- bind: `127.0.0.1`、port `0`（空きポート自動割当）。auth はランダムパスワード自動生成。

## 対象ファイル / インターフェース

- `packages/opencode/src/server/server.ts` — `Server.listen` 既存 API を再利用。変更不要想定。
- `packages/opencode/src/server/auth.ts` — `OPENCODE_SERVER_PASSWORD/USERNAME` 既存。detached 時はプロセス内で env に設定してから listen。
- `packages/opencode/src/cli/cmd/run/run.ts` — `runInteractiveLocalMode` 周辺に detach フック追加。
- `packages/opencode/src/cli/cmd/run/runtime.ts` — `runMini` に detached 状態と detach 実行関数を注入。
- `packages/opencode/src/cli/cmd/run/runtime.queue.ts` — `submit()`/`drain()` で `/detach` `/shutdown` をハンドル（`/exit` と同様の分岐）。
- `packages/opencode/src/cli/cmd/run/runtime.lifecycle.ts` — SIGHUP ハンドラ追加（detached 移行または無視）。
- `packages/opencode/src/cli/cmd/attach.ts` — `<url>` を optional にし、省略時は発見レコードを読む。
- `packages/opencode/src/cli/cmd/tui.ts` — `--attach` 省略時の発見レコード fallback（attach.ts と共有ロジック）。
- `packages/opencode/src/cli/cmd/stop.ts`（新規）— `opencode stop` サブコマンド。
- `packages/opencode/src/server/discovery.ts`（新規）— 発見レコードの読み書き・ヘルスチェック・stale 削除。
- `packages/opencode/src/cli/cmd/run/detach.ts`（新規）— detach 実行ロジック（listener bind・レコード書き出し・デーモン化・TUI 終了）。
- `packages/opencode/src/cli/detach-state.ts`（新規）— プロセス内共有フラグモジュール。`activate()` / `active` の最小実装。`/detach` 実行時に `activate()` を呼び、`index.ts` と `effect-cmd.ts` が `DetachState.active` で分岐。引数受け渡し・monkeypatch はしない。
- `packages/opencode/src/server/routes/instance/httpapi/handlers/server.ts`（新規）— `POST /server/shutdown`（auth 必須）。即 204 返却後 `setImmediate` で graceful shutdown（InstanceStore 各 InstanceContext dispose → `Server.stop` → `process.exit(0)`）。実行中ターンはそのまま落とす。
- `packages/opencode/src/index.ts` — finally を `if (!DetachState.active) process.exit()` に分岐。listener が ref されたままイベントループを保持するので exit 呼ばなければ自然に生存。`process.exit` 差し替え・`process.disconnect`/`unref` 細工は不要。
- `packages/opencode/src/cli/effect-cmd.ts` — finally を `if (!DetachState.active) store.dispose(ctx)` に分岐。引数渡し・再実行構成はしない。
- `packages/opencode/src/config`（必要なら）— `detach.sighup` 設定項目。

## 振る舞い

### P1: 途中デタッチ（コア）

TUI で `/detach` 入力時:

1. in-process の `Server.Default().app` に対し `Server.listen({ port: 0, hostname: "127.0.0.1" })` を呼び TCP listener を開く。
2. ランダムパスワードを生成し `process.env.OPENCODE_SERVER_PASSWORD` に設定（auth 有効化）。username はデフォルト `opencode`。
3. 発見レコード `<data>/server/<projectID>/server.json` を 0600 で書き出す。内容:
   ```json
   { "url": "http://127.0.0.1:<port>", "username": "opencode", "password": "<rand>", "pid": <process.pid>, "directory": "<cwd>", "projectID": "<id>", "startedAt": <iso> }
   ```
4. プロセスをデーモン化:
   - `process.stdin` を `/dev/null` に付け替え、stdout/stderr を `<Global.Path.log>/detach-<projectID>.log` へリダイレクト（EPIPE 防止）。
   - `SIGHUP` を無視ハンドラへ置換。
   - detached フラグを立て、`index.ts` の finally `process.exit()` と `effect-cmd.ts` の InstanceContext dispose が both 回避されるようにする。
5. TUI に再アタッチ用メッセージを表示（`opencode attach --continue` で再接続可）してから描画を終了。プロセスは残り、実行中ターンは既存の `promptAsync` + `forkIn`（`handlers/session.ts:314-332`）によりサーバー側で完走。

### P2: 再アタッチ UX

`opencode attach`（URL 省略可）:

1. URL 指定時は従来どおり。
2. URL 省略時:
   - カレントプロジェクトの `<data>/server/<projectID>/server.json` を読む。
   - `pid` 生存確認（`process.kill(pid, 0)`）と HTTP ヘルスチェック（レコードの url + auth で適当な GET、例: `/event` または既存の健全性エンドポイント）。失敗時は stale としてレコード削除しエラー。
   - 有効なら url/username/password を使って接続（パスワードは `--password` 相当で渡す、または env 経由）。
3. `--continue` / `--session` / `--no-replay` は既存の組み合わせを維持。
4. attach クライアントの通常終了・切断でサーバー側プロセスを殺さないこと（serve モードと同じ挙動）。

### P3: 明示的な停止手段

- `opencode stop`（新規 CLI サブコマンド）: カレントプロジェクトの発見レコードを読み、`pid` に `SIGTERM` を送り、レコードを削除。`--force` で `SIGKILL`。
- `/shutdown` TUI コマンド: attach 中のみ有効。接続先サーバーへ `POST /server/shutdown`（auth 必須）を投げる。サーバー側は即 204 返却後 `setImmediate` で graceful shutdown（各 InstanceContext dispose → `Server.stop` → `process.exit(0)`）。実行中ターンはそのまま落とす（止める人の意思優先）。発見レコード削除はサーバー側で実行。

### P4: SIGHUP 自動デタッチ（デフォルト ON）

- detached 移行前の SIGHUP 受信時、デフォルトで P1 相当の detach を実行してから TUI を終了（ターンは継続）。
- 設定 `detach.sighup: false` で無効化（従来通り死亡）。
- detach 済みプロセスでは SIGHUP は無視（P1 で設定済み）。

## フェーズ分割（独立して検証・コミット可能）

- P1 Detach core | deps:- | done: `/detach` で TCP listener が開き発見レコードが書かれプロセスが生存 | verify: `bun typecheck` + 手動（`/detach` → ターン完走確認）
- P2 Attach discovery | deps:P1 | done: `opencode attach`（URL 省略）で同プロジェクトに再接続 | verify: `bun typecheck` + 手動 E2E
- P3 Explicit stop | deps:P1 | done: `opencode stop` と `/shutdown` でサーバー停止 | verify: `bun typecheck` + 手動
- P4 SIGHUP auto-detach | deps:P1 | done: SIGHUP 受信で自動 detach（デフォルト）| verify: 手動（ssh 切断でプロセス生存）

## 検証（完了の定義）

- [ ] `bun typecheck` が `packages/opencode` で成功。
- [ ] E2E: 素の `opencode` で長いターン開始 → `/detach` → 端末（ssh）を殺してもプロセス生存・ターン完走・セッションに記録。
- [ ] E2E: 別端末から `opencode attach`（URL 指定なし）+ `--continue` で同セッションへ再接続、リプレイとライブストリームが機能。
- [ ] デタッチしない通常終了ではプロセスが完全終了（リグレッションなし）。
- [ ] attach クライアントの終了・切断でサーバー側実行が中断されない。
- [ ] `opencode stop` でデタッチ済みサーバーが停止しレコード削除。
- [ ] `/shutdown` で接続先サーバーが停止。
- [ ] SIGHUP 受信で自動 detach（デフォルト）、`detach.sighup: false` なら従来通り死亡。