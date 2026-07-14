# Monitor ツール + agmsg monitor/both 対応 — Plan

| id | deps | done | verify | status |
| --- | --- | --- | --- | --- |
| P1 | - | monitor start/list/stop が動作し、stdout 行が synthetic prompt として注入され、shell 子プロセスから OPENCODE_SESSION_ID が読める | packages/opencode で bun test test/tool/monitor.test.ts と bun typecheck | done |
| P2 | P1 | monitor.event / monitor.stopped が publish され run UI に muted 行が出る。event-manifest カウント更新、client 再生成済み | packages/opencode で bun test test/cli/ test/event-manifest.test.ts、LANG=C LC_ALL=C bun run ui-gallery -- --check、packages/client で bun run generate の差分コミット | done |
| P3 | P1 | agmsg-plugin/ (type.conf / _delivery.sh / template.md / README.md / verify.sh) が作成され、symlink + trust でインストール済みで、delivery.sh set monitor opencode <project> が opencode 向け directive を出力する | agmsg-plugin/verify.sh が全項目 PASS | done |
| P4 | P2,P3 | 下記「検証」の手動手順が通る | 手動 | pending |

## Progress log

2026-07-14: P1 done. Files created: `packages/opencode/src/tool/monitor.ts`, `monitor.txt`, `test/tool/monitor.test.ts`. Edited: `shell.ts` (add OPENCODE_SESSION_ID to shellEnv), `registry.ts` (register MonitorTool). Key decisions: use Queue.unbounded + Queue.poll for stdout batching (avoids fiber starvation), stub publishMonitorEvent/publishMonitorStopped for P2. The flood guard test passes with `seq`-based fast output. Remaining for P2: wire event schemas in packages/schema, implement real publishMonitorEvent/MonitorStopped, update event-manifest, regenerate client.

2026-07-14: P3 done. Files created: `agmsg-plugin/types/opencode/type.conf`, `_delivery.sh`, `template.md`, `agmsg-plugin/README.md`, `verify.sh`. Installed via `ln -s` + `plugin.sh trust`. All 8 verify.sh items PASS. Key decisions: custom `emit_opencode_monitor_directive` reimplements delivery.sh's logic keyed on OPENCODE_SESSION_ID; `agmsg_delivery_stop_directive` uses Monitor tool vocabulary (action: list / action: stop) instead of TaskList/TaskStop; template modeled on claude-code's template with opencode-specific tool names.

2026-07-14: P2 done. Files created: `packages/schema/src/v1/monitor.ts`, `monitor-v1.ts`. Edited: `schema/event-manifest.ts` +2 definitions, `monitor.ts` (replace stubs with EventV2Bridge.publish), `session-data.ts` (monitor.event/monitor.stopped handlers), `ui-gallery.tsx` (2 new gallery entries), event-manifest tests (+2 counts), session-data test (+5 monitor test cases), `test/tool/monitor.test.ts` (add EventV2Bridge mock to test layer). Key decisions: EventV2Bridge.Service yielded in tool generator; publish calls wrapped with Effect.ignore to suppress unknown error type. Generated client had no diff (V1 events excluded from current SDK surface).
