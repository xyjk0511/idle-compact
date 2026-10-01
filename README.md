# idle-compact

A Claude Code plugin that compacts a long, idle conversation **once**, shortly before its 1h prompt cache goes cold, so the first message after you come back starts from a small, cheap context instead of re-caching the whole thing.

This is a fork of [takahirom's idle-compact](https://github.com/takahirom/takahirom-claude-code-marketplace/tree/main/plugins/idle-compact) that also works where the original cannot:

- **Claude desktop app and SDK sessions.** They run headless, where the engine refuses a direct compaction; this fork queues `/compact` instead.
- **A visible schedule.** The prompt footer shows when the pending compaction fires.
- **A Windows balloon** after an automatic compaction, since the desktop app shows no plugin output.
- Person-facing text follows the system language (Chinese or English).

It never keeps the cache alive, polls, or retries: one timer per idle period, one compaction, then nothing until you send another message. Full details in the [plugin README](plugins/idle-compact/README.md).

## Install for Claude Code

Function hooks are early access: set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, for example in the `env` block of `~/.claude/settings.json`. Then:

```
/plugin marketplace add xyjk0511/idle-compact
/plugin install idle-compact@idle-compact
```

If the upstream `idle-compact@takahirom-claude-code-marketplace` is installed, disable it so only one timer runs.

## 中文说明

长对话放着不管，等 1 小时缓存过期再回来，第一条消息要重新缓存整段上下文。这个插件在空闲 50 分钟、缓存还热的时候自动压缩一次，回来时从一个小而便宜的上下文开始。相比上游，这个版本在 Claude 桌面版里也能用，输入框底部会显示几点压缩，Windows 上压缩完会弹气泡，系统是中文就显示中文。安装命令见上方。

## Codex version

The Codex 1.2.0 plugin lives in [`codex/`](codex/README.md), with its own
marketplace, hooks, tests, and Windows runtime that preserves the tool prefix
during compaction. With Node.js 20+, a Codex CLI that supports lifecycle hooks
(0.159.2 tested; 0.156.0 does not load these hooks),
Git and Git LFS installed, enable LFS once and install directly from GitHub:

```powershell
git lfs install
codex plugin marketplace add xyjk0511/idle-compact
codex plugin add idle-compact@idle-compact
```

The repository's `.agents` marketplace points Codex at the Codex plugin;
the `.claude-plugin` marketplace remains available to Claude Code.
The Windows executable is stored in Git LFS and is downloaded during checkout.
Do not set `GIT_LFS_SKIP_SMUDGE=1` during installation. Restart Codex, then review
and trust the four hooks in `/hooks`; installation does not grant hook trust.
See the Codex README for upgrading an existing local installation, settings,
and compatibility limits. This is a third-party repository marketplace, not a
listing in OpenAI's public plugin directory.

## License

[Apache-2.0](LICENSE). Derived from takahirom's idle-compact; see [NOTICE](NOTICE) for what changed.
