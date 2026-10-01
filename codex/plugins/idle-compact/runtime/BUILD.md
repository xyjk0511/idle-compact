# Windows 修复版构建

基线是 OpenAI Codex 的 `rust-v0.159.2` 标签。此目录的 `source.patch` 只修改请求构造及其回归检查；包内 `codex.exe` 为 Windows x64 本地构建，不是 OpenAI 官方发布二进制。

在标签对应的源码根目录应用补丁：

```powershell
git apply "D:\tools\idle-compact-codex\plugins\idle-compact\runtime\source.patch"
Set-Location codex-rs
```

本包使用下列额外 Cargo profile（加入 `codex-rs/Cargo.toml`）：

```toml
[profile.dev-small]
inherits = "dev"
opt-level = 0
debug = "none"
strip = "symbols"
```

Windows 上安装源码要求的 Rust 工具链及 Visual C++ Build Tools 后构建：

```powershell
cargo build --locked --profile dev-small -p codex-cli --bin codex
cargo test --profile dev-small -p codex-core responses_lite_prefix_ids_track_thread_and_payload --lib
```

输出为 `target/dev-small/codex.exe`。拷贝到本目录后运行插件行为测试。修改运行时后必须重新验证真实压缩的缓存用量，不能只凭测试通过恢复自动压缩。

本次 Windows 构建还在 `codex-rs/.cargo/config.toml` 的 MSVC `rustflags` 中保留 `/STACK:8388608`，并加入 `"-C", "target-feature=+crt-static"`，静态链接 C 运行时。
