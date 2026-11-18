# 0003 — 命令面与 Issue #1 的偏差

## Status

**Accepted** — 2026-11-18

## Context

Issue #1 的实现决策列出了 `sftp_stat`、`system_*`（含 OS 信息）与 `credentials_read/delete`，并要求 Docker exec “不新增独立命令：复用终端 `open_command`”。本 ADR 记录时的命令面是 32 个，与规格有四处差异。

## Decision

### 1. 不提供 `sftp_stat`

`file_list` 已返回名称、类型、大小、修改时间与权限；`file_read` 返回大小、修改时间与 SHA-256。单独暴露 `sftp_stat` 只会增加一个无调用方、需要单独校验路径与符号链接的命令。若未来需要“只取元数据”的优化，再以具体调用方为依据新增。

### 2. 不提供 `system_*`，由 `monitor_snapshot` 统一承载

监控 Tab 需要的是同一时刻的 CPU、内存、磁盘、负载、运行时间与 Top 进程。拆成多个命令会让五张卡来自不同采样时刻，也会增加连接归属校验面。`monitor_snapshot` 一次返回完整快照；OS 信息目前没有 UI 消费方，不暴露。

### 3. 不提供 `credentials_read` / `credentials_delete`

- `credentials_read` 会把原始密码或私钥送进 WebView，直接违反安全边界；凭据只在 Rust Core 连接期间按 `secret_ref` 读取。
- 凭据删除由 `server_delete`、`server_update` 与 `server_credential_set` 在 Rust 内部完成，WebView 不持有可删除的凭据句柄。

### 4. 保留 `docker_exec`，但实现为终端会话的受控包装

`docker_exec` 不新建 shell 后端，也不绕过会话限额：它校验连接归属、容器 ID 与 shell 路径，调用 `DockerCliAdapter::verify_exec`，然后复用 `TerminalManager::open_command`，与 `terminal_open` 共享每服务器 8 个会话的上限。

不把它并入 `terminal_open` 的原因是安全边界：若 `terminal_open` 接受任意命令字符串，WebView 就获得了任意远程命令执行能力，绕过所有类型化命令。`docker_exec` 只接受容器 ID 与单个受校验的 shell 路径，参数由 Rust 侧构造。

## Consequences

- 命令面以 `tests/integration/command-surface.test.ts` 与 capability 为唯一事实源；后续终端剪贴板修复新增 `clipboard_read_text`，当前为 33 个；
- 规格中的 `sftp_stat`、`system_*`、`credentials_*` 视为已由现有命令覆盖或被安全边界否决；
- Docker exec 的“复用 `open_command`”按“复用终端会话管理”解释，而不是“复用 `terminal_open` 的参数面”。

## 后续动作

- 若产品需要 OS 信息，新增 `monitor_snapshot` 字段而不是新命令域；
- 若未来需要凭据轮换 UI，仍只提供“写入新凭据”，不提供读取。
