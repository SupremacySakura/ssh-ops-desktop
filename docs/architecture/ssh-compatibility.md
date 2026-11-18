# SSH 兼容边界

Harbor 使用 `russh` + `russh-sftp` 作为唯一的活动 SSH/SFTP 传输。主机身份在认证前通过 SQLite 中的 `known_host_keys` 校验，未知指纹阻断，指纹变化必须由用户显式确认。密码与私钥口令只在 Rust Core 内从系统凭据库解析，不进入 WebView。

## 已接线能力

| 能力 | 状态 | 说明 |
|---|---|---|
| 密码认证 | 已接线 | 前端只提供 `password` 认证类型；秘密经 `secret_ref` 从系统凭据库读取。 |
| 私钥内容认证 | 已接线 | 前端只提供 `key` 认证类型；私钥内容经 `secret_ref` 从系统凭据库读取，不落 SQLite。 |
| PTY shell / 终端 | 已接线 | `terminal_open/write/resize/close`，每台服务器最多 8 个并发会话。 |
| SFTP 子系统 | 已接线 | 列表、读取、写入、下载、上传、新建目录、重命名、删除。 |
| 主机指纹校验 | 已接线 | SHA-256 指纹，未知阻断；变化确认绑定旧指纹并条件替换。 |
| `~/.ssh/config` 导入 | 已接线（有限） | 只导入 `Host`、`HostName`、`Port`、`User`；`IdentityFile` 仅用于预览展示，不复制私钥。 |

## 未接线能力

以下能力存在于 `crates/ssh-core` 的底层认证枚举或历史设计中，但**没有**对应的前端入口、Tauri 命令或产品承诺，不能按“已支持”宣传：

- OpenSSH 证书认证（`Certificate`）：底层 `AuthRequest` 有分支，但 `ServerAuthType` 只有 `password`/`key`，命令层不会构造该请求。
- SSH agent 认证（`SshAgent`）：底层有实现，但未暴露给 UI 或命令层。
- 私钥路径认证（`PrivateKey { path, .. }`）：底层存在，产品只使用私钥内容 + 系统凭据库。
- 端口转发、动态 SOCKS、远程 Unix socket 转发。
- OpenSSH fallback：`crates/ssh-core/src/openssh.rs` 保留了参数构造模块，但活动连接路径没有调用系统 `ssh`，也没有对应的 UI 或命令。
- `ProxyJump` / `ProxyCommand` / `Include` / `Match` 等连接语义：导入预览会标记为 unsupported，不会执行或静默降级为直连。
- 键盘交互认证、多因素认证、证书 principal 的用户界面配置。

## 已知限制

- SFTP v3 没有 `openat` 式 no-follow 句柄。Harbor 在操作前逐级 `lstat`，并在读取 open 后复检最终组件；但 `lstat` 与后续 open/rename 之间仍存在协议级竞态，祖先目录的符号链接替换无法完全消除。
- 文件上传与文件重命名依赖 `hardlink@openssh.com` 做无覆盖提交；服务器不提供该扩展时，操作失败关闭并给出中文原因，不降级为可能覆盖的 `rename`。
- 目录重命名没有原子 no-replace 原语：Harbor 先 `lstat` 目标不存在，再执行 `rename`，并在结果中始终声明竞态窗口。目标已存在时拒绝，不覆盖。
- 大文件传输受 JSON/IPC 峰值内存限制：单文件与整批各 16 MiB、最多 32 个文件；4 MiB 以上要求确认，超限在读取文件前拒绝。决策见 `docs/adr/0002-file-transfer-ipc-limits.md`。
- 真实 SSH 服务器、系统 Keychain 与 Windows WebView2 的行为只能由人工验收覆盖；renderer E2E 使用 fake `CoreClient`，不构成这些边界的证据。
