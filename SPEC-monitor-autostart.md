# Monitor 常用化・自動武装 — Spec

> **Status:** ✅ Shipped — P1–P3 完了(2026-07-21, `d92d148b9`)。P4(`.opencode/rules` ネイティブロード)はスコープ外として明示的に見送り。

## 目的

monitor ツール(既存 SPEC.md で実装済み)を常用可能にし、セッション起動時に
LLM 非依存で決定論的に武装する本体機構を opencode に追加する。あわせて
shell ツール相当の「単発完了通知」を monitor ツールの `oneshot` オプションで
再現し、システムプロンプトで monitor の自発利用を促す。agmsg プラグインは
この本体機構へ設定を書き込む形へ更新し、ルールファイル経由の LLM 任せ武装を
置き換える。

## スコープ外

- V2 セッションコア(`SessionV2.prompt` / steer/queue / `execution.wake`)経由の注入 — 現行 SPEC.md と同様に V1 synthetic prompt のみ
- `.opencode/rules/*.md` のネイティブロード(P4) — P1 完了後に別 SPEC で再検討
- agmsg 本体(`~/project_dir/agmsg` clone および `~/.agents/skills/agmsg` インストール済みスクリプト)のあらゆる変更 — 変更はすべてこのリポジトリの `agmsg-plugin/` にとどめる
- WebSocket ソース・外部プロセスブリッジ方式
- 既存 monitor ツールのイベントスキーマ(`MonitorV1.Event.Event` / `Stopped`)の互換性を壊す変更
- inline run UI 以外のクライアント(desktop / tui / sdk)での描画追加

## 確定済みの設計判断(インタビュー結果 + レビュー確定)

1. **autostart 起動場所**: InstanceBootstrap(`packages/opencode/src/project/bootstrap.ts`)。インスタンス(プロジェクト)起動時に 1 回、plugin.init() の後に走る。LLM 非依存。
2. **起動方式**: monitor ツールの start ロジックをプログラム的に直接呼ぶ(i案)。プロセス表・flood guard・Layer finalizer をツールと共有し、重複管理を避ける。
3. **oneshot(P2)**: monitor ツールへ `oneshot: boolean` オプション追加。Claude Code の「単発通知は bg Bash、継続監視は Monitor」の使い分けを 1 ツールで表現。shell ツールは変更しない。
4. **P4(.opencode/rules ネイティブロード)**: 今回は見送り。P1〜P3 完了後に別 SPEC で再検討。
5. **autostart config マージ**: global + project 加算マージ。両方の宣言を起動する。
6. **promptOps バインディング(レビュー確定)**: latest-session-wins 再バインド方式。
   - autostart monitor は **セッションIDに紐付けずインスタンス所属** として entries に登録。
   - prompt.ts が promptOps を構築するたびに、インスタンス内の未バインド/旧バインドエントリを **最新の promptOps へ再バインド**。
   - **再バインド対象はトップレベルセッションの promptOps のみ**。親を持つセッション(subagent/task 起源)は再バインド対象から除外する。これによりサブエージェント起動のたびに配信が短命なサブセッションへ奪われ、完了後は dispose まで注入先を失うのを防ぐ。親子関係の判定は session 生成箇所の `parentID` フィールド等を用いる(実装時に確認)。
   - 旧セッション dispose 時(`Effect.addFinalizer`)に当該セッションへバインドしていたエントリの promptOps を `null` に戻す → 以降のイベントはキューへ蓄積、次セッションの promptOps 構築時に再バインド & flush。
   - 「見えない配信」は構造的に発生しない(旧セッションは注入先を失い、新セッションが取得するまでイベントは安全に蓄積)。
7. **config 書き込み先(レビュー確定)**: `.opencode/opencode.local.json`(純 JSON)を新設。
   - `ConfigPaths.files` へ追加(読み込み順序は既存 jsonc より後、ローカル優先)。
   - `ensureGitignore` の既定無視リストに `opencode.local.json` を追加。
   - agmsg プラグインはこのファイルへ `monitor.autostart` エントリを書き込み/削除。
   - jq 等の外部依存が必要な場合はプラグイン README に依存と「bash+sqlite3 のみ方針の外側」を明記。
   - グローバル config 案は command に project path が焼き込まれるため別プロジェクトで誤起動する問題があり不採用。
8. **oneshot 仕様(レビュー確定)**: 簡素化 — `oneshot = non-persistent + exit 時集約通知`。
   - stdout 行は **蓄積のみ**(逐次注入しない)、プロセス exit まで注入しない。
   - exit 時に `monitor.stopped(reason=exit)` を publish し、蓄積した全行(上限あり、超過分は破棄)を **1 回の synthetic 注入**にまとめて通知。
   - `persistent` は強制 `false`、`timeout_ms` は既定の短め(60 秒)。
   - 500ms バッチ窓は使用しない(oneshot は「完了通知」が本質、逐次注入不要)。
9. **複数インスタンス(レビュー確定)**: 許容 + エッジケース明記。
   - 同一プロジェクトで TUI と `vanamei run` が同時起動すると両インスタンスが autostart し、同一メッセージが両方へ配信され、両者が応答し得る。
   - 同一インスタンス内では【6】の latest-session-wins により旧セッションは応答しない(重複応答なし)。
   - インスタンス間の排他は agmsg 側(watch.sh の pidfile/actas ロック)の変更が必要でスコープ外、SPEC エッジケースへ明記。

## 対象ファイル / インターフェース

### P1 — config schema / autostart 機構

- `packages/core/src/v1/config/monitor.ts` — 新規。`ConfigMonitorV1.Info` を定義:
  ```ts
  // autostart エントリ: monitor ツールの start パラメータと同形
  export const AutostartEntry = Schema.Struct({
    command: Schema.String.annotate({ description: "Shell command to run" }),
    description: Schema.String.annotate({ description: "Short description shown in list and notifications" }),
    persistent: Schema.optional(Schema.Boolean),
    timeout_ms: Schema.optional(Schema.Number),
    oneshot: Schema.optional(Schema.Boolean),
  })
  export const Info = Schema.Struct({
    autostart: Schema.optional(Schema.mutable(Schema.Array(AutostartEntry))).annotate({
      description: "Monitors to start deterministically at session bootstrap (no LLM in the loop)",
    }),
  })
  export type Info = Schema.Schema.Type<typeof Info>
  ```
  `packages/core/src/v1/config/config.ts` の `Info` へ `monitor: Schema.optional(ConfigMonitorV1.Info)` を追加。同ファイルの import と `export type Info` の更新。
- `packages/core/src/config/monitor.ts` — 上記の再エクスポート羽(他の config module と同型)。`packages/core/src/config/index.ts` で `export * as ConfigMonitor` を追加。

### P1 — opencode.local.json 新設(機械所有ローカル設定)

- `packages/opencode/src/config/config.ts` — `ConfigPaths.files` に `.opencode/opencode.local.json`(純 JSON)を追加。読み込み順序は既存の `.opencode/opencode.jsonc` より後(ローカル優先)。global config と project config のマージでは、project の local が最優先。
- `packages/opencode/src/config/config.ts` — `ensureGitignore` の既定無視リスト(`config.ts:295-310` 近辺)に `opencode.local.json` を追加。git 管理下の `.opencode/` 配下でもこのファイルは無視される。
- このファイルは agmsg プラグイン等の機械所有設定専用。人手編集は想定しない(README に明記)。

### P1 — monitor ツールの start ロジック分離(インスタンス所属・latest-session-wins)

- `packages/opencode/src/tool/monitor.ts` — 既存 start 処理(action === "start" ブロック)を関数として抽出:

  ```ts
  export type StartInput = {
    command: string
    description: string
    persistent?: boolean
    timeout_ms?: number
    oneshot?: boolean // P2 で追加
  }
  export function startMonitor(input: StartInput): Effect.Effect<{ monitorID: string }>
  ```

  - **セッションID を StartInput に取らない**: autostart monitor はインスタンス所属とし、セッションには紐付けない。LLM 経由 start は `ctx.sessionID` を使うが、autostart は null/インスタンス ID を使う。
  - `entries` のエントリ型 `MonitorEntry` の `sessionID` を `SessionID | null` に変更(null = インスタンス所属 autostart)。
  - 既存の `run` 内 start ブロックは `startMonitor` を呼ぶ thin ラッパへ置換。
  - `Tool.define` の Effect.gen 内で `Scope.Scope` / `ChildProcessSpawner` / `Session.Service` / `EventV2Bridge.Service` を capture し、`startMonitor` はそれらを引数(or 依存)として受け取る形にする。プロセス表 `entries` も共有。

- `packages/opencode/src/tool/monitor.ts` — `rebind(promptOps)` 関数追加。インスタンス内の全エントリ(未バインド + 旧バインド)の promptOps を最新のものへ再設定。イベント発生時、未バインドなら行をエントリ内キューに蓄え(サイズ上限あり、超過は破棄 + warning log)、バインド済みなら直接注入。rebind 時に蓄積キューを flush。
- `packages/opencode/src/tool/monitor.ts` — `unbind(promptOps)` 関数追加。旧セッション dispose 時に呼び、当該 promptOps へのバインドを null へ戻す。エントリ自体は残り、イベントはキュー蓄積へ戻る。

### P1 — bootstrap からの autostart 起動

- `packages/opencode/src/project/bootstrap.ts` — `run` 内で `plugin.init()` の後に autostart を処理:

  ```ts
  yield * plugin.init()
  // ... existing init ...
  // Deterministic monitor autostart (no LLM in the loop)
  const cfg = yield * config.get()
  const autostart = cfg.monitor?.autostart ?? []
  if (autostart.length > 0) {
    yield *
      Effect.forEach(
        autostart,
        (entry) =>
          MonitorTool.startMonitor(entry).pipe(
            Effect.catchCause((cause) => Effect.logWarning("monitor autostart failed", { cause })),
          ),
        { discard: true },
      )
  }
  ```

  - `MonitorTool` の Layer が bootstrap の依存に入るよう、`node.deps` に `ToolRegistry.node` (または Monitor.layer 単独) を追加。

### P1 — promptOps 再バインド + 旧セッション unbind フック

- `packages/opencode/src/session/prompt.ts` — promptOps 構築後(行 1238 / 行 266 の `yield* ops()`)に、**トップレベルセッションの場合のみ** MonitorTool の全エントリをこの promptOps へ再バインドする Effect を挿入: `if (session.parentID === null) yield* MonitorTool.rebind(promptOps)`。親を持つセッション(subagent/task 起源)は再バインド対象から除外し、配信が短命なサブセッションへ奪われるのを防ぐ。親子判定は session 生成箇所の `parentID` フィールドを用いる(実装時に確認)。
- `packages/opencode/src/session/session.ts`(または該当のセッション dispose 箇所) — セッション終了時の `Effect.addFinalizer` で `yield* MonitorTool.unbind(promptOps)` を呼び、当該セッションへのバインドを null へ戻す。これにより死んだセッションへイベントが流れ続けるのを防ぐ。

### P2 — oneshot オプション

- `packages/opencode/src/tool/monitor.ts` — `Parameters` に `oneshot: Schema.optional(Schema.Boolean)` を追加。`oneshot: true` の start は:
  - `persistent` は強制 `false`、`timeout_ms` は無視(既定 or 短め)
  - プロセスが exit したら通常の終了処理(`monitor.stopped` reason=`exit`)を行い、synthetic 注入で 1 行通知
  - 1 行でも stdout があればバッチ注入、それ以降は無視
  - LLM 向けには「単発完了通知に使う。継続監視は oneshot 無指定(既定)」と記載
- `packages/opencode/src/tool/monitor.txt` — oneshot の使い分けを追記。
- `packages/opencode/test/tool/monitor.test.ts` — oneshot の end-to-end(printf 1 行 → 注入 → exit 通知)を追加。

### P3 — システムプロンプト拡充

- `packages/opencode/src/tool/monitor.txt` — ビルド・テスト・dev サーバー・ログ監視で monitor を自発的に使うよう、具体例を追記。Claude Code の Monitor 節を参考にしつつ opencode 語彙へ翻訳。
- `packages/opencode/src/session/prompt.ts` のシステムプロンプト assembly に直接追記するのではなく、monitor.txt の description 拡充で実現(ツール説明がシステムプロンプトに流れるため)。

### P3 — agmsg プラグイン更新

- `agmsg-plugin/types/opencode/_delivery.sh` — `agmsg_delivery_apply` で monitor/both 時にルールファイルの self-arm ブロックを廃止し、代わりに opencode グローバル config(`~/.config/opencode/opencode.json`)の `monitor.autostart` へ書き込む処理を追加。ただし `_delivery.sh` は agmsg スクリプトから source されるため、config 書き換えは opencode プロセス外で行う必要がある — `delivery.sh set` 実行時に `~/.config/opencode/opencode.json` を読み、`monitor.autostart` 配列に agmsg watch エントリを追記/更新する。重複登録を避けるため description が `agmsg inbox stream` のエントリは置換する。
  - ただし `_delivery.sh` はプロジェクト単位で呼ばれるが、autostart はグローバル config に置くべきかプロジェクト config に置くべきかは「懸案」を参照。
  - `off` 時は autostart 配列から agmsg エントリを削除。
  - `emit_opencode_monitor_directive` は `mode` 変更時の実行中セッション向け即時武装用として維持(P1 完了後も、配信モード切替の即時反映には必要)。
- `agmsg-plugin/types/opencode/template.md` — 「Ensure monitor is running first」節は、P1 完成後は不要になるが、ルールファイルが読まれなくなるわけではない(`instructions` 設定は別用途で残り得る)ため、テンプレートの self-arm 節は残しつつ「通常は autostart で自動起動するので手動不要」と注記。
- `agmsg-plugin/verify.sh` — 以下を追加:
  - Item 6: `delivery.sh set monitor` 後に `~/.config/opencode/opencode.json`(またはテスト用 temp config path)の `monitor.autostart` に `agmsg inbox stream` エントリが存在する
  - Item 7: `delivery.sh set off` 後に同エントリが削除される
  - 既存 Item 1-5 は維持(self-arm ブロック廃止に伴い Item 3 の monitor mode の「PostToolUse 無し」検証は self-arm ブロック無しに変更)

## 振る舞い

### 1. autostart 起動フロー

```
[instance bootstrap]
  config.get() → plugin.init() → (各 service init 並列) → monitor autostart
    ↓
  config.monitor.autostart の各エントリに対し:
    MonitorTool.startMonitor({ ...entry, sessionID, agent })
      → プロセス spawn + entries Map 登録(まだ promptOps は未バインド)
      → stdout 行はエントリ内キューに蓄積(上限あり、超過は破棄 + warning log)
    ↓
  [初回プロンプト受信]
  prompt.ts が promptOps 構築
    ↓
  MonitorTool.bindUnbound(sessionID, promptOps)
    → 当該 sessionID の未バインド全エントリに promptOps を結びつけ
    → 蓄積キューを flush(初回注入)
    → 以降のイベントは直接注入
```

### 2. oneshot 挙動

```
startMonitor({ command, description, oneshot: true, ... })
  → プロセス spawn(通常と同じ)
  → stdout 1 行目を 1 バッチとして注入
  → プロセス exit で monitor.stopped(reason=exit) publish + 1 行 exit 注入
  → エントリ除去
  ※ 継続監視と異なり、複数行のバッチはしない(最初の完了通知が主目的)
  ※ ただし stdout が 500ms バッチ窓内に複数行来る場合は通常バッチ扱いでよい(実装上の簡素化)
```

### 3. config マージ

```
global config:    monitor.autostart = [A, B]
project config:   monitor.autostart = [C]
→ merged:         monitor.autostart = [A, B, C]  (すべて起動)
```

### 4. agmsg プラグインの config 書き込み

```
delivery.sh set monitor opencode <project>
  → agmsg_delivery_apply でルールファイル書き(既存、marker のみ)
  → さらに ~/.config/opencode/opencode.json の monitor.autostart に:
    { command: "<watch.sh> <instance_id> <project> opencode", description: "agmsg inbox stream", persistent: true }
    を追記(description が "agmsg inbox stream" の既存エントリは置換)
  → AGMSG-DIRECTIVE で実行中セッションへ即時武装指示(既存)

delivery.sh set off opencode <project>
  → ルールファイル削除(既存)
  → monitor.autostart から agmsg エントリ削除
  → AGMSG-DIRECTIVE で停止指示(既存)
```

### 5. エッジケース

- autostart で指定された command が即死する場合 → 通常の `monitor.stopped(reason=exit)` が publish され、bootstrap ログに warning。セッション自体は起動し続ける。
- autostart エントリの command が空/不正 → bootstrap で catchCause して warning log、次のエントリへ継続。
- 1 セッションに複数 autostart monitor が起動 → それぞれ別 monitorID、別エントリ。list で一覧可能。
- プロセスがバインド前に大量出力 → キュー上限(例: 100 行)で破棄、warning log。バインド後に flush されるのは上限内の分のみ。
- autostart monitor は `action: stop` でユーザーが明示停止可能(通常 monitor と同様)。
- 既存の LLM 経由 start と autostart は同じ entries Map に共存。list/stop は区別しない(区別不要)。

## 懸案(実装時に確定)

### A. sessionID の解決

autostart は bootstrap(インスタンス起動)で走るが、この時点で「プライマリセッション ID」が確定しているか。`InstanceState.context` から取得できるか、それともセッションはプロンプト受信時に作成されるか。
→ 実装時の精査点。もし bootstrap 時点で sessionID が無ければ、start をセッション作成時まで遅延させるか、インスタンス ID を monitorID の prefix として使いセッション作成時に bind で紐付けるかを選ぶ。

### B. config 書き込み先(global vs project)

agmsg プラグインが autostart エントリを書き込む先:

- **global**(`~/.config/opencode/opencode.json`)→ 全プロジェクトで agmsg watcher が起動。プロジェクトを開くたびに起動。
- **project**(`<project>/.opencode/opencode.json` または `<project>/opencode.json`)→ 当該プロジェクトでのみ起動。

agmsg の `delivery.sh set` はプロジェクト単位で呼ばれるため、project config へ書くのが自然。ただし opencode の config merge 順序で project config が global を上書きしないよう(配列は加算マージなので問題なし)。実装時に project config path の解決方法を確認。

### C. 重複起動の防止

agmsg プラグインが autostart へ書き込む際、複数プロジェクトで同じ `delivery.sh set monitor` を実行するとエントリが重複蓄積されるか。
→ `description: "agmsg inbox stream"` で既存エントリを置換するロジックで対処(1 プロジェクト 1 エントリ。command に project path が埋め込まれているため別プロジェクトは別エントリになるが、グローバル config に書く場合は累積に注意)。

### C'. ベイク済み instance-id の共有(ライブ E2E で検出 → 修正済み)

当初の実装では `opencode.local.json` の watch コマンドに `delivery.sh set` 実行時点の固定 instance-id を焼き込んでいた。これにより:

- 同一プロジェクトの複数インスタンス(TUI と vanamei run 同時起動、SIGHUP 自動デタッチで生き残った旧インスタンス含む)が同一 id の watcher を複数持ち、共有 watermark を先取りした側だけが配信を受ける = 他方は恒久的にメッセージ消失
- `set` 時に agent pid 未解決のため watcher の死活リンクが張られず、インスタンス終了後も watcher が無期限残留

**修正(コミット 6a6e20d02)**: 焼き込む command をシェル展開に変更 — `watch.sh "agmsg-boot-$$" '<project>' opencode`。`$$` は Monitor ツールが `sh -c` で起動するごとに展開される PID で、インスタンスごとに一意の watcher id になる。watermark/pidfile の共有が消え、新 id の初期 watermark は現在値から始まるため過去メッセージの再配信もない。ライブ再武装用 AGMSG-DIRECTIVE は現行セッションを対象とするため具象 session id のまま維持。

## フェーズ分割

- **P1 autostart 機構 + promptOps 2段階バインド** | deps:- | done: config に `monitor.autostart` を宣言すると bootstrap で monitor が決定論起動し、初回プロンプト時にイベントが注入される。既存 LLM 経由 start は従来どおり動作 | verify: `packages/opencode` で `bun test test/tool/monitor.test.ts` と `bun typecheck`。autostart エントリ 1 件の E2E テスト(bootstrap → bind → イベント注入)を test/tool/monitor-autostart.test.ts に追加
- **P2 oneshot オプション** | deps:P1 | done: `oneshot: true` で start すると単発完了通知として機能し、exit 後にエントリが除去される | verify: `packages/opencode` で `bun test test/tool/monitor.test.ts`(oneshot ケース追加)と `bun typecheck`
- **P3 agmsg プラグイン + monitor.txt 拡充** | deps:P1 | done: `_delivery.sh` が autostart config へ agmsg エントリを書き込み/削除する。monitor.txt に monitor 常用ガイダンスを追記。verify.sh が新項目を含めて全 PASS | verify: `agmsg-plugin/verify.sh` 全項目 PASS、`packages/opencode` で `bun typecheck`

## 検証(完了の定義)

- [ ] `packages/opencode` から `bun test` / `bun typecheck` が緑(既知の pre-existing failure があれば除外を明記)
- [ ] `packages/core` で `bun typecheck` が緑(config schema 追加の型整合性)
- [ ] `packages/client` の `bun run generate` 実行済みで `src/generated*` に手編集がない(config schema 変更が client 生成に影響する場合)
- [ ] `agmsg-plugin/verify.sh` が全項目 PASS。かつ `~/.agents/skills/agmsg/scripts/` に一切の変更が無い(agmsg 本体無変更の確認)
- [ ] E2E(autostart): 素の vanamei TUI 起動のみ(スキル未呼び出し・`$agmsg` 未実行)で、グローバル config に `monitor.autostart` が宣言されていれば agmsg メッセージが 15 秒以内に run UI へ注入される。LLM への self-arm 指示に依存しない。
- [ ] E2E(oneshot): monitor ツール `action: start, oneshot: true` で `echo done` 相当を実行すると、1 行の完了通知が注入されエントリが list から消える
- [ ] E2E(停止): `mode off` の directive に従い monitor が止まり、config の autostart エントリも削除される
- [ ] 既存の LLM 経由 monitor start / list / stop は従来どおり動作(regression 無し)
