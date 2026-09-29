# idle-compact

A Claude Code plugin that compacts a long, idle conversation **once**, shortly before its 1h prompt cache goes cold, so the first message after you come back starts from a small, cheap context instead of re-caching the whole thing.

This is a fork of [takahirom's idle-compact](https://github.com/takahirom/takahirom-claude-code-marketplace/tree/main/plugins/idle-compact) that also works where the original cannot:

- **Claude desktop app and SDK sessions.** They run headless, where the engine refuses a direct compaction; this fork queues `/compact` instead.
- **A visible schedule.** The prompt footer shows when the pending compaction fires.
- **A Windows balloon** after an automatic compaction, since the desktop app shows no plugin output.
- Person-facing text follows the system language (Chinese or English).

It never keeps the cache alive, polls, or retries: one timer per idle period, one compaction, then nothing until you send another message. Full details in the [plugin README](plugins/idle-compact/README.md).

## Install

Function hooks are early access: set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, for example in the `env` block of `~/.claude/settings.json`. Then:

```
/plugin marketplace add xyjk0511/idle-compact
/plugin install idle-compact@idle-compact
```

If the upstream `idle-compact@takahirom-claude-code-marketplace` is installed, disable it so only one timer runs.

## 中文说明

长对话放着不管，等 1 小时缓存过期再回来，第一条消息要重新缓存整段上下文。这个插件在空闲 50 分钟、缓存还热的时候自动压缩一次，回来时从一个小而便宜的上下文开始。相比上游，这个版本在 Claude 桌面版里也能用，输入框底部会显示几点压缩，Windows 上压缩完会弹气泡，系统是中文就显示中文。安装命令见上方。

## License

[Apache-2.0](LICENSE). Derived from takahirom's idle-compact; see [NOTICE](NOTICE) for what changed.
