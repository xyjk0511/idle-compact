# Codex 闲置自动压缩插件

**Idle Compact 1.2.0**：一轮任务结束后，空闲 25 分钟自动压缩一次上下文。你继续发消息、开始新会话或手动压缩时，会取消待执行的计时器。持续工作的任务也会跳过。

这是可分享的本地 Codex 插件包，包含源码、插件目录、测试及 Windows x64 的专用 Codex 0.159.2 修复版。它保留压缩前的工具定义，并禁止摘要过程调用工具。无需独立 API 密钥或额外 Node 依赖。压缩使用本机 Codex 已配置的账号、模型和供应商，会消耗其额度。

## 安装

前提：已安装并登录支持生命周期钩子的 Codex，`codex` 和 Node.js 20 或更新版本的 `node` 命令可用。推荐使用 Codex CLI 0.159.2 或更新的兼容版本；本包在 Windows x64、Codex CLI 0.159.2、Node.js 24.13.1 上检查。CLI 0.156.0 可以显示插件已安装，但现场检查未加载本插件的生命周期钩子，不能只凭安装列表判断可用。

### 从 GitHub 安装（推荐）

安装 Git 和 Git LFS 后，先启用一次 LFS，再添加插件源并安装：

```powershell
git lfs install
codex plugin marketplace add xyjk0511/idle-compact
codex plugin add idle-compact@idle-compact
```

Codex 会从仓库根目录的 `.agents/plugins/marketplace.json` 识别本插件，并下载 Windows 修复版程序。安装时不要设置 `GIT_LFS_SKIP_SMUDGE=1` 或关闭 Git 的 LFS 下载过滤器。下载失败时先修复 Git LFS 或网络问题，再重新添加插件源；不要将 LFS 指针文本当作可执行程序。

重启 Codex，在 `/hooks` 中检查并信任 `Stop`、`UserPromptSubmit`、`SessionStart`、`PreCompact` 四个钩子，然后核对：

```powershell
codex plugin list | Select-String 'idle-compact@idle-compact'
```

应显示 `installed, enabled`，版本 `1.2.0`。这是第三方 GitHub 插件源，不代表已上架 OpenAI 公共插件目录。

### 从本地包安装

从 Git 仓库手动克隆本版本时，先安装 Git LFS，并在仓库根目录运行 `git lfs pull`，确认 `codex/plugins/idle-compact/runtime/codex.exe` 已下载为实际程序。安装时将下文的解压路径替换为本仓库 `codex` 目录的绝对路径；GitHub 的自动源码 ZIP 不保证包含 LFS 程序文件。

1. 解压到固定目录，例如 `D:\tools\idle-compact-codex`。安装后不要移动或删除这个源目录。
2. 在 PowerShell 中运行，替换为实际解压路径：

   ```powershell
   codex plugin marketplace add "D:\tools\idle-compact-codex"
   codex plugin add idle-compact@idle-compact
   ```

3. 重启 Codex。在 Codex CLI 的 `/hooks` 中检查并信任四个插件钩子：`Stop`、`UserPromptSubmit`、`SessionStart`、`PreCompact`。安装不会自动授予钩子信任，未信任时插件不会执行。
4. 检查安装结果：

   ```powershell
   codex plugin list | Select-String 'idle-compact@idle-compact'
   ```

   应显示 `installed, enabled`，版本 `1.2.0`。

### 已装旧版

本包和旧版使用相同名称。升级前在相关会话发一条消息取消计时器，或等待计时器结束。将旧的本地插件源切换为 GitHub 源时，先确认 Git LFS 已启用，然后运行：

```powershell
codex plugin remove idle-compact@idle-compact
codex plugin marketplace remove idle-compact
codex plugin marketplace add xyjk0511/idle-compact
codex plugin add idle-compact@idle-compact
```

如果继续使用本地包，改为：

```powershell
codex plugin remove idle-compact@idle-compact
codex plugin marketplace remove idle-compact
codex plugin marketplace add "D:\tools\idle-compact-codex"
codex plugin add idle-compact@idle-compact
```

重启后重新检查 `/hooks` 的信任状态。上述操作只针对本插件；已有会话和插件数据仍留在本机。

## 实际行为

- 每个会话最多保留一个待执行计时器。默认空闲 25 分钟后触发一次。
- 超过 35 分钟才醒来的计时器会跳过，例如机器休眠后恢复。
- 新消息、新会话、手动压缩会取消待执行计时器；持续工作的会话也会跳过。
- 压缩失败时记录日志，本次不重试。下一轮正常结束后可以重新计时。
- Windows 后台子进程使用隐藏窗口参数。压缩完成后可以显示通知。
- 插件读取会话记录判断状态；压缩由 Codex 执行，不直接改写会话文件。
- 收到桌面端请求确认后，还要观察会话中的完成记录才写成功回执。
- Windows 默认使用包内修复版，优先于桌面端注入的 `CODEX_CLI_PATH`。它只用于插件的独立压缩进程，不替换桌面程序。
- 使用包内修复版时，如果桌面端仍持有会话，跳过此次压缩。当前桌面端不能应用这个请求修复，插件也不会抢占会话写锁。
- 数据目录存在 `paused` 文件时，已加载的钩子和计时器也会停止触发。恢复前应取消旧计时状态，再移除这个文件。

**不能保证节省费用或额度。** 25 分钟是可调整的默认值，不是所有模型和供应商的缓存保证。压缩本身需要一次模型调用；缓存失效时可能产生大量未缓存输入。摘要也可能遗漏细节，关键要求应保存在项目文件中。

原版 Codex CLI 0.159.2 的压缩请求把开头的工具定义清空，导致现场两次压缩仅命中 2.67% 和 1.88%。包内修复版在同一份隔离会话副本上实际达到 **99.49%（112,384 / 112,956 token）**；会话用量与转发站账本一致。该结果来自正常请求后立即压缩，不能保证闲置 25 分钟后、其他模型或供应商也达到同样命中率。完整材料见本包外的调查报告及用量证据文件。

实测使用普通文本输出。使用额外 JSON 输出 schema、动态改变工具定义或更换模型时，缓存前缀仍可能变化；本包未验证这些场景的命中率。

## 查看日志和结果

默认插件数据目录是 Codex 数据目录中的 `plugins/data/idle-compact-idle-compact`。常规 Windows 安装可这样查看：

```powershell
Get-Content "$env:USERPROFILE\.codex\plugins\data\idle-compact-idle-compact\idle-compact.log" -Tail 20
```

`armed` 表示已开始计时，`cancelled` 表示已取消，`skipped` 表示跳过。`compaction finished` 才表示观察到完成；`state/<会话ID>.done.json` 是回执。数据目录由宿主提供，使用自定义 Codex 数据目录时以实际 `PLUGIN_DATA` 为准。

## 设置

在启动 Codex 的同一环境中设置，然后重启。以下设置只影响之后新启动的计时器：

```powershell
$env:IDLE_COMPACT_IDLE_MIN = '25'
$env:IDLE_COMPACT_LATEST_MIN = '35'
$env:IDLE_COMPACT_MIN_TOKENS = '50000'
$env:IDLE_COMPACT_TOAST = '0'
codex
```

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `IDLE_COMPACT_IDLE_MIN` | `25` | 空闲多少分钟后压缩 |
| `IDLE_COMPACT_LATEST_MIN` | `35` | 超过这个时间跳过，至少与空闲时间相同 |
| `IDLE_COMPACT_MIN_TOKENS` | `0` | 小于该 token 数时跳过；可设 `50000` 减少小会话压缩 |
| `IDLE_COMPACT_DISABLE` | 未设置 | `1` 表示不再启动新计时器 |
| `IDLE_COMPACT_TOAST` | 开启 | `0` 关闭 Windows 通知 |
| `IDLE_COMPACT_CODEX` | Windows 优先使用包内修复版 | 显式覆盖实际 Codex 路径；指定原版会失去本修复 |
| `IDLE_COMPACT_LOG` | 插件数据目录 | 指定日志文件路径 |
| `IDLE_COMPACT_IPC_PIPE` | `\\.\pipe\codex-ipc` | 桌面端 IPC 地址，通常无需修改 |

卸载：`codex plugin remove idle-compact@idle-compact`。独立计时器不会因卸载立即退出；卸载前先在相关会话发消息取消，或等待计时器结束。

## 支持范围

- 面向支持上述钩子的本地 Codex。Windows 桌面端通过私有 IPC 发起压缩，接口可能随应用更新改变。
- 无桌面端持有会话时，通过官方 `thread/resume`、`thread/compact/start` 尝试压缩。其他客户端持有写锁时可能被拒绝，插件不会强行接管。Windows 包内修复版会主动跳过桌面端持有的会话。
- macOS/Linux 的 CLI 回退路径未做现场验证；不承诺这些平台的桌面端兼容性。
- 本包尚未提交或上架公开插件目录。普通 ChatGPT 网页 Chat 的自动压缩不在支持范围内。ChatGPT Work 的本地钩子执行支持以宿主为准，本包未在那里现场验证。

## 源码与验证

```text
.agents/plugins/marketplace.json      本地插件目录
plugins/idle-compact/.codex-plugin/    支持生命周期钩子的插件清单
plugins/idle-compact/hooks/           钩子、计时器、桌面通信及通知
plugins/idle-compact/tests/           不调用模型的行为测试
plugins/idle-compact/runtime/         Windows 修复版、源码补丁及许可证
```

在解压目录中运行：

```powershell
node --test plugins/idle-compact/tests/idle-compact.test.mjs
```

测试使用临时目录和模拟桌面端，覆盖计时、取消、休眠超时、忙碌跳过、拒绝请求及完成回执，不对真实会话发起压缩。

包内 `runtime/codex.exe` 是从 [OpenAI Codex rust-v0.159.2](https://github.com/openai/codex/tree/rust-v0.159.2) 源码构建的非官方修复版。`source.patch` 提供请求修复；`LICENSE`、`NOTICE` 保留上游许可。源码构建命令见 `runtime/BUILD.md`。它没有自动升级机制，Codex 更新后应重新核验兼容性。

本包保留 `.codex-plugin/plugin.json` 清单格式。Codex 0.159.2 读取带 Agent Plugin schema 的顶层 `plugin.json` 时不会加载生命周期钩子，因此不能用那个格式替代此清单。

灵感来自 [takahirom 的 Claude Code idle-compact](https://github.com/takahirom/takahirom-claude-code-marketplace/tree/main/plugins/idle-compact)，本包是 Codex 本地钩子实现。

官方参考：[插件打包与分发](https://developers.openai.com/plugins/build/plugins)、[Codex App Server](https://developers.openai.com/codex/app-server)、[钩子与信任](https://developers.openai.com/codex/hooks)。
