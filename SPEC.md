# Monitor ツール + agmsg monitor/both 対応 — Spec

## 目的

opencode(vanamei-code)に Claude Code 相当の **monitor ツール**を追加する: 長寿命のバックグラウンドコマンドを起動し、その stdout 行を非同期イベントとして実行中セッションへ注入する。あわせて agmsg の opencode タイプ定義を外部プラグインでシャドウし、配信モード `monitor` / `both` を opencode エージェントで使えるようにする。

変更対象リポジトリは **vanamei-code(このリポジトリ)のみ**:

- monitor ツール本体・イベント・UI(`packages/`)
- agmsg 側は**本体を一切変更しない**。agmsg 公式の外部プラグイン機構(driver-registry / タイプシャドウ)で built-in の opencode タイプ定義を丸ごと上書きするプラグインを、このリポジトリの `agmsg-plugin/` に置く。`~/project_dir/agmsg`(github.com/fujibee/agmsg の clone、HEAD `8a2fe62`)は読み取り専用の参照

## 確定済みの設計判断(インタビュー結果)

1. **スコープ**: 両リポジトリの変更を本 SPEC に含める(vanamei-code 側だけでは agmsg の中央ゲート `delivery_modes` が monitor を拒否するため)。
2. **注入経路**: V1 synthetic prompt。`task.ts` の `inject()` と同一パターン(`ctx.extra.promptOps` を capture → `Effect.forkIn(scope)` で `ops.prompt({ parts: [{ type: "text", synthetic: true, ... }] })`)。V2 `SessionV2.prompt` は使わない。
3. **管理サーフェス**: monitor ツール 1 つに `action: start | list | stop` パラメータ。別ツールには分割しない。
4. **UI 可視化**: イベント到着時に専用イベントを publish し、inline run UI の scrollback に muted 一行を出す(automode の `permission.judged` 行と同じ配線パターン)。
5. **agmsg 対応方式**(2026-07-14 追加指示): agmsg 本体(clone・インストール済みスクリプト)は無変更。外部プラグインで built-in の opencode タイプをシャドウする(`type-registry.sh` の「Later bases override earlier ones among eligible candidates」+ `plugin.sh trust` opt-in)。

## スコープ外

- V2 セッションコア(`SessionV2.prompt` / steer/queue / `execution.wake`)経由の注入 — run UI が V2 未接続のため
- WebSocket ソース(Claude Code Monitor の `ws` パラメータ相当)
- bash ツールへの `run_in_background` 追加
- opencode 本体への SessionStart / SessionEnd フック機構の新設 — agmsg 側はテンプレート指示(下記「ensure monitor first」)+ `mode` 設定時の AGMSG-DIRECTIVE で代替
- inline run UI 以外のクライアント(desktop / tui / sdk)でのモニタイベント描画(プロトコル上イベントは流れるが描画は追加しない)
- モニタの永続化・opencode プロセス再起動後の自動復元(次回 `/agmsg` 呼び出し時の ensure-monitor で再武装される)
- codex 型 app-server ブリッジのような外部プロセス方式(opencode はネイティブツールで実現する)
- agmsg 本体(`~/project_dir/agmsg` clone および `~/.agents/skills/agmsg` インストール済みスクリプト)のあらゆる変更。`delivery.sh` の `emit_monitor_directive` 一般化も行わない(プラグインの `_delivery.sh` が独自 directive を出すため不要)。claude-code / codex の挙動は自動的に不変
- fujibee/agmsg への upstream PR(このプラグインが実証済みステージングになるが、本 SPEC の完了条件には含めない)

## 対象ファイル / インターフェース

### vanamei-code — schema / protocol(変更後 `packages/client` で `bun run generate` 必須)

- `packages/schema/src/v1/monitor.ts` — 新規。イベント 2 種を定義し `Event.Definitions` に登録(`permission.judged` の追加コミット `7da2ffbeb` を範とする):
  - `monitor.event`: `{ sessionID, monitorID: Schema.String, description: Schema.String, lines: Schema.Array(Schema.String) }`
  - `monitor.stopped`: `{ sessionID, monitorID, description, reason: Schema.Literals(["exit", "timeout", "flooded", "stopped"]), exitCode: Schema.optional(Schema.Number) }`
- `packages/opencode/src/event-manifest.ts` — 2 イベント登録。`packages/opencode/test/event-manifest.test.ts` / `packages/schema/test/event-manifest.test.ts` のカウントを +2

### vanamei-code — server / tool

- `packages/opencode/src/tool/monitor.ts` — 新規ツール。`Tool.define("monitor", ...)`。プロセス表(Map<monitorID, entry>)はこのモジュールの Layer に保持し、Layer の finalizer で全子プロセスを kill。読み取り fiber は tool init で `yield* Scope.Scope` した長寿命スコープに `Effect.forkIn`(`task.ts:93` と同型)
- `packages/opencode/src/tool/monitor.txt` — LLM 向け説明文(start/list/stop、行=イベント、persistent の使い分け、flood 制限を記載)
- `packages/opencode/src/tool/registry.ts` — `Effect.all` への追加・`builtin` 配列への追加・`ToolRegistry.node.deps` への依存追加
- `packages/opencode/src/tool/shell.ts` — `shellEnv` に `OPENCODE_SESSION_ID: ctx.sessionID` を追加(優先順: `process.env` → `OPENCODE_SESSION_ID` → plugin の `extra.env`。plugin が上書き可能)。monitor ツールの spawn env も同じ構成にする(`OPENCODE_SESSION_ID` 付与)

### vanamei-code — inline run UI(`packages/opencode/src/cli/cmd/run/`)

- `session-data.ts` — `monitor.event` / `monitor.stopped` 受信で muted 一行(`permission.judged` の処理に併設):
  - `⏺ monitor(<description>): <lines[0]>`(lines が複数なら末尾に ` (+N more)`)
  - `⏺ monitor(<description>) stopped — <reason>`
  - 字組みは既存 tool ヘッダ規約(⏺ + truncate)に従う
- `packages/opencode/script/ui-gallery.tsx` — gallery エントリ追加

### vanamei-code — テスト

- `packages/opencode/test/tool/monitor.test.ts` — 新規。fake `promptOps`(呼び出しを配列に記録するだけの実装)を `ctx.extra` に渡して注入を検証。globalThis モック禁止。実プロセス(`printf` / `sleep` を使う短命スクリプト)で start→イベント注入→exit 通知、stop、list、timeout、flood guard を検証
- `packages/opencode/test/cli/run/session-data.test.ts` — monitor 行の表明を追加

### agmsg プラグイン(このリポジトリの `agmsg-plugin/` — agmsg 本体は無変更)

前提となる agmsg の機構(検証済み): タイプ探索は「built-in `scripts/drivers/` → `<install_dir>/plugins/` → `$AGMSG_PLUGIN_DIRS`」の順で**後勝ち**し(`scripts/lib/type-registry.sh:53-69`)、trust 済み外部プラグインは built-in の同名タイプを完全置換する。`_delivery.sh` プラグと `template.md` も同じ `agmsg_type_dir` 解決を通るためプラグイン側が使われる(`delivery.sh:244-247`、`agmsg_type_template_path`)。`install.sh` は `plugins/` 配下と `db/trusted-plugins` を保存するため(install.sh:264-266 のコメント)`--update` 後も生存する。

- `agmsg-plugin/types/opencode/type.conf` — built-in(`scripts/drivers/types/opencode/type.conf`)の**完全コピー**を基にする(シャドウは完全置換なので `name` / `template` / `cli` / `spawnable` / `model_arg` / `detect_proc` / `hooks_file` を欠かさないこと)。変更・追加: `monitor=yes`、`delivery_modes=monitor turn both off`、`detect=OPENCODE_SESSION_ID`、`spawn_unset_env=OPENCODE_SESSION_ID`(同型 spawn の子がセッション ID を継承しない — claude-code の #294 と同じ理由)
- `agmsg-plugin/types/opencode/_delivery.sh` — built-in コピーを基に全面改訂。delivery.sh のコンテキストに source されるため `$SKILL_DIR` / `$RUN_DIR` / `compat_uuidgen` / `agmsg_normalize_instance_id` / `resolve_hooks_file` が利用できる:
  - `agmsg_delivery_apply`: `off` → ルールファイル(`.opencode/rules/agmsg.md`)除去。`turn` / `both` / `monitor` → ルールファイルを書き、1 行目にモードマーカー(`<!-- agmsg mode: <mode> -->`)。PostToolUse 節(check-inbox.sh 実行指示、現行 turn と同内容)は `turn` / `both` のみ。`monitor` はマーカーのみのファイル
  - `agmsg_delivery_on_enable`(monitor / both 時): プラグ内関数 `emit_opencode_monitor_directive` を呼ぶ — `delivery.sh` の `emit_monitor_directive` と同じロジックを `OPENCODE_SESSION_ID` で再実装する(env が空なら `agmsg-<uuid>` 生成 fallback → `agmsg_normalize_instance_id` で複合化 → 生存 pidfile があれば重複起動せず案内のみ → `watch.sh <instance_id> <project> opencode` を `printf %q` で焼き込んだ AGMSG-DIRECTIVE を出力。文言は monitor ツールの引数名 `command` / `description: agmsg inbox stream` / `persistent: true` に合わせる)
  - `agmsg_delivery_stop_directive`: 「monitor ツールを `action: list` で呼び、description が `agmsg inbox stream` で始まるエントリを `action: stop` + その `monitor_id` で停止せよ」という AGMSG-DIRECTIVE
  - `agmsg_delivery_status`: ルールファイルのモードマーカーから 4 モードを表示(マーカー無しの旧形式ファイルは `turn` 扱い、ファイル無しは `off`)
- `agmsg-plugin/types/opencode/template.md` — claude-code の `template.md` を範に全面改訂(下記「振る舞い §5」)
- `agmsg-plugin/README.md` — インストール手順と注意を記載:

  ```sh
  ln -s <repo>/agmsg-plugin/types/opencode ~/.agents/skills/agmsg/plugins/types/opencode
  ~/.agents/skills/agmsg/scripts/plugin.sh trust types/opencode
  ```

  trust は「axis/name + 絶対 path」の完全一致で記録される(`driver-registry.sh:63-68`)ため、symlink を張り替えたら再 trust が必要なことを明記

- `agmsg-plugin/verify.sh` — 再実行可能な検証スクリプト(bats 不使用。インストール済み skill に対して実行し、項目ごとに expected / actual を出力): ① `plugin.sh list` で types/opencode が trusted ② タイプ解決がプラグインを指す(`delivery_modes` に `monitor` を含む)③ テンポラリプロジェクト dir への `delivery.sh set <mode> opencode <dir>` 4 モードの apply 結果(ルールファイルの有無・マーカー・PostToolUse 節)④ monitor 時の directive に複合 instance id と `watch.sh ... opencode` が焼き込まれる ⑤ `set off` で watcher teardown が走りルールファイルが消える

## 振る舞い

### 1. monitor ツールのパラメータ

```
action:      "start" | "list" | "stop"(省略時 "start")
command:     string  — start 必須。シェルコマンド。stdout 1 行 = 1 イベント、exit で監視終了
description: string  — start 必須。通知・list に表示される短い説明
persistent:  boolean — 省略時 false。true でセッション寿命(timeout 無視)
timeout_ms:  number  — 省略時 300000、最大 3600000。persistent=false のみ有効
monitor_id:  string  — stop 必須
```

start で command / description 欠落、stop で monitor_id 欠落は `InvalidArgumentsError` 相当のバリデーションエラーにする。

### 2. start

1. permission: `ctx.ask({ permission: "monitor", patterns: [command], always: ["*"] })`。ユーザーは config `"permission": { "monitor": { "*": "allow" } }` で恒久許可できる
2. `ctx.extra.promptOps` を capture(無ければ task.ts:192 と同様に fail)
3. `ChildProcessSpawner` で spawn(shell ツールと同じ cwd 既定・env は shellEnv + `OPENCODE_SESSION_ID`)。`detached` は shell の kill 群セマンティクスに合わせる
4. `monitorID` は `mon_` + 乱数。エントリ(proc, sessionID, description, command, persistent, startedAt, stderr リングバッファ 4KB)を Map に登録
5. **即 return**: `title: description`、`output` に monitorID・description・persistent を明記、`metadata: { monitorID, command, persistent }`
6. `ctx.abort` は監視しない — モニタはツールコール終了後も生存する

### 3. イベントストリーム(バックグラウンド fiber)

- stdout を行分割し、**500ms ウィンドウでバッチ**して 1 回の注入にまとめる
- 注入(バッチごと): `ops.prompt` を `Effect.ignore` + `Effect.forkIn(scope, { startImmediately: true })` で発火。`sessionID: ctx.sessionID`、agent は task.ts inject と同様に現セッションの agent。parts は synthetic text 1 つ、本文は正確に:

  ```
  [monitor event] <description> (<monitorID>)
  <バッチ内の行を \n 連結>

  This is an automated monitor notification, not user input. Act on it if needed.
  ```

- 同時に `monitor.event` を publish(`lines` = バッチ内の行)
- stderr はイベントにしない。リングバッファに保持し list / stop 時の出力に含める
- **flood guard**: 直近 60 秒の注入バッチが 20 を超えたら子プロセスを kill し、reason `flooded` として下記の終了処理を行う
- **終了処理**(exit / timeout / flooded 共通、`action: stop` は除く): `monitor.stopped` を publish し、synthetic 注入 1 行:

  ```
  [monitor exited] <description> (<monitorID>) reason=<reason> exit=<code|none>
  ```

  Map からエントリを除去する

- timeout: persistent=false のとき timeout_ms 経過で kill(reason `timeout`)
- 注入失敗(セッション不在等)は `Effect.ignore` で握りつぶす(task.ts と同じ)

### 4. list / stop / ライフサイクル

- `list`: **自セッション(`ctx.sessionID`)のエントリのみ**を一覧。各行: monitorID, status(running / 終了直前情報), description, persistent, startedAt, command。0 件なら "no monitors running"
- `stop`: 自セッションの monitor_id を SIGTERM → 3 秒後 SIGKILL(shell の `forceKillAfter: "3 seconds"` と同じ)。エントリ除去。`monitor.stopped`(reason `stopped`)は publish するが **synthetic 注入はしない**(ツール結果で見えるため)。存在しない monitor_id はエラーではなく "not found" 出力
- instance 終了: Layer finalizer が全エントリの子プロセスを kill(watch.sh 側も複合 instance id の pid 死活で自己終了するため二重に安全)
- 同一 command の重複 start は許可する(agmsg watch.sh は同一 instance id の先行 watcher を pidfile で kill するため自然に一本化される)

### 5. agmsg opencode プラグイン

- **directive の command**: プラグ内 `emit_opencode_monitor_directive` が組み立てる `watch.sh <instance_id> <project> opencode [role]`。instance id は `OPENCODE_SESSION_ID`(shell ツール経由で delivery.sh に見える)を `agmsg_normalize_instance_id` で複合化 — agent pid は既存の `detect_proc=opencode` により opencode プロセスへ解決される。watch.sh の死活自己終了(`kill -0`)がそのまま機能する
- **template.md**(claude-code 版を範に、opencode 語彙へ翻訳):
  - 「**Ensure monitor is running first**」節: サブコマンド処理の前に、モードが monitor/both なら monitor ツールを `action: list` で確認し、`agmsg inbox stream` が無ければ `action: start`(command: `watch.sh $OPENCODE_SESSION_ID "$(pwd)" opencode`、description: `agmsg inbox stream`、persistent: true)
  - join 後のモード選択プロンプトを 4 択(monitor 推奨 / turn / both / off)に変更
  - `mode <name>`: 4 モードすべて受理し、`delivery.sh set` の AGMSG-DIRECTIVE に従う(claude-code 版 §mode と同文構造。TaskList/TaskStop への言及は monitor ツール `action: list` / `action: stop` に置換)
  - `actas <name>`: 既存 monitor を `action: stop` → モードが monitor/both なら role フィルタ付きで `action: start`(watch.sh 第 4 引数に `<name>`、description: `agmsg inbox stream (acting as <name>)`)。actas-claim の pre-flight は claude-code 版と同じ
  - `drop <name>`: stop → モードが monitor/both ならデフォルト購読で再 start
  - 「OpenCode has no Monitor tool」の注記を全削除
- **spawn**: `monitor=yes` になることで `spawn opencode <name>` の ready 待ちが有効化される。spawn は初期プロンプト `/agmsg actas <name>` で起動し、テンプレートの actas フローが role 付き watcher を start → watch.sh が ready sentinel を stamp → `status=ready`。追加のコード変更は不要(データ駆動)
- **despawn**(graceful): watch.sh の `ctrl:despawn` 処理は `$TMUX_PANE` に依存 — monitor ツールが spawn する watch.sh は opencode プロセスの env を継承するため、opencode が tmux ペイン内で動いていれば claude-code と同条件で機能する。変更不要
- **check-inbox.sh**: both モードの watcher 委譲(pidfile 検査)は型非依存で既に機能する。変更不要

### 6. エッジケース

- セッションはアイドルでも注入で新ターンが始まる(V1 loop の仕様)— これが意図した動作(メッセージ到着にエージェントが反応する)
- run UI はローカルキューでターンを駆動しているが、サーバー側注入ターンのアシスタント出力はイベント購読で描画される。synthetic user text は `includeUserText: false` により非表示 — 可視シグナルは muted 行(P2)とアシスタント応答
- opencode プロセスは生きたままセッションだけ切り替わった場合、旧セッションのモニタは残る(注入先はアイドルセッション)。回収は mode off / instance 終了 / flood guard に委ねる(スコープ外の明示)
- watch.sh が即死する場合(DB 不在等は 1 行 ERROR を出して exit)→ そのまま `[monitor exited]` 注入でエージェントに見える

## フェーズ分割

- P1 monitor ツール本体 + OPENCODE_SESSION_ID | deps:- | done: monitor start/list/stop が動作し、stdout 行が synthetic prompt として注入され、shell 子プロセスから `OPENCODE_SESSION_ID` が読める | verify: `packages/opencode` で `bun test test/tool/monitor.test.ts` と `bun typecheck`
- P2 イベント + run UI | deps:P1 | done: `monitor.event` / `monitor.stopped` が publish され run UI に muted 行が出る。event-manifest カウント更新、client 再生成済み | verify: `packages/opencode` で `bun test test/cli/ test/event-manifest.test.ts`、`LANG=C LC_ALL=C bun run ui-gallery -- --check`、`packages/client` で `bun run generate` の差分コミット
- P3 agmsg プラグイン | deps:P1 | done: `agmsg-plugin/`(type.conf / \_delivery.sh / template.md / README.md / verify.sh)が作成され、symlink + trust でインストール済みで、`delivery.sh set monitor opencode <project>` が opencode 向け directive を出力する | verify: `agmsg-plugin/verify.sh` が全項目 PASS
- P4 E2E | deps:P2,P3 | done: 下記「検証」の手動手順が通る | verify: 手動

## 検証(完了の定義)

- [ ] `packages/opencode` から `bun test` / `bun typecheck` が緑(既知の pre-existing failure があれば除外を明記)
- [ ] `packages/client` の `bun run generate` 実行済みで `src/generated*` に手編集がない
- [ ] `agmsg-plugin/verify.sh` が全項目 PASS。かつ `~/.agents/skills/agmsg/scripts/` に一切の変更が無い(agmsg 本体無変更の確認)
- [ ] E2E(実セッション): プラグインを README.md の手順(symlink + `plugin.sh trust types/opencode`)でインストール → vanamei ビルドの opencode でチームに join → `mode monitor` → 別エージェント(例: dotfiles チームの claude)から `send` → opencode 側 run UI に `⏺ monitor(agmsg inbox stream): ...` の muted 行が出てエージェントが反応する
- [ ] E2E(停止): `mode off` の directive に従い monitor が止まり、以後 send しても反応しない
- [ ] E2E(spawn): claude 側から `spawn opencode <name>` が `status=ready` で返り、`send <name> ...` に spawned opencode が応答する。注意: spawn の boot コマンドはプラグイン type.conf の `cli=` を使う。ストック opencode(`~/.opencode/bin/opencode`)は automode 設定(`"auto"`)を解せず起動即死するため(2026-07-14 実測)、ローカルでは `cli=` を fork ビルド(`~/.local/bin/vanamei`)に解決させること — プラグイン type.conf は本体無変更で自由に書けるので `cli=vanamei run --interactive` とするのが簡単
- [ ] flood guard: `command: "yes hello"` 相当で start すると自動停止し `reason=flooded` の行が出る
