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

## Notes

- Trust records "axis/name + absolute path" exact match (`driver-registry.sh:63-68`),
  so re-pointing the symlink requires re-trust.
- The plugin directory (`plugins/`) and its trust database (`db/trusted-plugins`) are
  preserved across `--update` re-installs of agmsg.
