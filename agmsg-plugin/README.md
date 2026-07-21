# agmsg opencode plugin — monitor/both delivery modes

Adds `monitor` / `both` delivery modes to the `opencode` agent type in agmsg.
Shadows the built-in opencode type definition so `delivery.sh set monitor opencode
<project>` works and emits the `AGMSG-DIRECTIVE` that tells opencode to invoke its
Monitor tool.

## Install

```sh
ln -s <repo>/agmsg-plugin/types/opencode ~/.agents/skills/agmsg/plugins/types/opencode
~/.agents/skills/agmsg/scripts/plugin.sh trust types/opencode
```

Then install the skill into opencode itself so `/agmsg` resolves there (agmsg's
install.sh only deploys command files for claude-code/codex; the opencode skill
loader also requires `name:` in frontmatter, which the substitution below keeps):

```sh
mkdir -p ~/.config/opencode/skills/agmsg
sed 's/__SKILL_NAME__/agmsg/g' <repo>/agmsg-plugin/types/opencode/template.md \
  > ~/.config/opencode/skills/agmsg/SKILL.md
```

Re-run the `sed` after editing `template.md` — nothing refreshes the installed
copy automatically.

## Requirements

- **jq** (`/usr/bin/jq` 1.7+): required for monitor and both modes, which write
  an autostart entry to `.opencode/opencode.local.json`. This is outside agmsg's
  "bash+sqlite3 only" policy.
- `.opencode/opencode.local.json` is **machine-owned**: the plugin writes to it;
  humans should not hand-edit it. opencode's config loader reads it after
  `opencode.jsonc` with local precedence. It is git-ignored by opencode's
  `ensureGitignore`.

## Notes

- Trust records "axis/name + absolute path" exact match (`driver-registry.sh:63-68`),
  so re-pointing the symlink requires re-trust.
- The plugin directory (`plugins/`) and its trust database (`db/trusted-plugins`) are
  preserved across `--update` re-installs of agmsg.
- The autostart command in `opencode.local.json` uses `"agmsg-boot-$$"` as the
  watcher instance-id. The `$$` is expanded by the shell at runtime to the
  `sh -c` PID, giving each Monitor spawn a unique id (avoids shared watermarks
  and orphan watchers across parallel instances). The live re-arm directive
  (`emit_opencode_monitor_directive`) uses the concrete resolved session id
  because it targets the currently-running session directly.
