# OpsPilot 安全连接、终端与远程文件实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付服务器 CRUD、严格主机指纹校验、密码/密钥 SSH、多会话终端、SFTP、端口转发与系统 OpenSSH 回退，使 P0 的人工连接能力在没有 Agent 时独立可用。

**Architecture:** `ssh-core` 以 russh 为主通道，将配置、主机身份、认证、连接、Shell、SFTP 与 Tunnel 分层；所有凭据经 `SecretStore` 按引用获取。Tauri command 只接受结构化 DTO，字节流通过带序号事件传输；复杂 OpenSSH 兼容性走参数数组和受控 PTY，不经过 shell 字符串。

**Tech Stack:** Rust/Tokio、russh、russh-sftp、portable-pty、Tauri events、SQLite repositories、Docker Compose SSH fixtures、Vitest/Rust tests。

## Global Constraints

- 首次未知主机密钥返回 `SSH_HOST_KEY_UNKNOWN` 并要求确认；已知主机密钥变化返回 `SSH_HOST_KEY_CHANGED` 且默认阻断。
- 凭据只由 Rust 从 `SecretStore` 读取，不进入 command 参数、事件、日志或数据库。
- 连接异常只自动恢复读取流和交互终端；任何可能有副作用的 Exec 不自动重放。
- 广播输入默认关闭；端口转发只绑定用户显式地址并先检查端口冲突。
- 远端路径按原始字节/平台语义处理，禁止用本地路径规则猜测远端安全性。
- 每个终端标签有独立 `terminalSessionId`；连接复用不能导致跨标签或跨服务器串流。
- 文件写操作不得注册为可直接执行的 Tauri command；WebView 只能提交 `ToolCall` 到共享 `OperationGateway`，批准时只能回传 `ApprovalProof`。
- 每个 Task 的行为测试通过后、提交前都必须再运行 `pnpm verify:static`；该根脚本统一执行 pnpm lint/typecheck 与 Cargo fmt/clippy，任一非零退出都阻断提交。

---

## 文件责任映射

| 路径 | 唯一责任 |
|---|---|
| `crates/domain/src/server.rs` | Server、认证类型、连接配置值对象 |
| `crates/persistence/src/server_repository.rs` | Server/Group/Tag SQLite CRUD |
| `crates/ssh-core/src/config.rs` | DTO 到已校验连接配置的转换 |
| `crates/ssh-core/src/known_hosts.rs` | 指纹计算、TOFU 决策和 known_hosts 存储 |
| `crates/ssh-core/src/auth.rs` | SecretStore 到 russh 认证材料的短生命周期转换 |
| `crates/ssh-core/src/connection.rs` | 连接状态机、KeepAlive、复用与关闭 |
| `crates/ssh-core/src/terminal.rs` | Shell Channel、PTY、序列化数据流 |
| `crates/ssh-core/src/sftp.rs` | 目录、元数据、流式传输与冲突策略 |
| `crates/ssh-core/src/tunnel.rs` | Local/Remote/Dynamic 转发生命周期 |
| `crates/ssh-core/src/openssh.rs` | 系统 ssh 回退与受控 PTY |
| `crates/task-engine` | 传输任务所需的通用 Task/Step 最小状态机 |
| `crates/task-engine/src/gateway.rs` | 所有远端写操作的唯一 prepare/approve/submit 入口 |

### Task 1: 实现服务器、分组和标签 CRUD

**Files:**
- Create: `crates/domain/src/server.rs`
- Modify: `crates/domain/src/lib.rs`
- Create: `crates/persistence/src/server_repository.rs`
- Modify: `crates/persistence/src/lib.rs`
- Create: `crates/persistence/tests/server_repository.rs`
- Create: `src-tauri/src/commands/server.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `packages/contracts/src/server.ts`
- Create: `packages/contracts/src/server-import.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/server.test.ts`

**Interfaces:**
- Consumes: `Database`、`Id`、`CoreError`、`SecretRef`、`AuditWriter`。
- Produces: `ServerRepository::{list,get,create,update,delete}`；Tauri `server_list/server_create/server_update/server_delete/server_import_preview/server_import_apply`。

```ts
export interface ServerSummary {
  id: Id; name: string; host: string; port: number; username: string;
  environment: 'development' | 'staging' | 'production' | 'other';
  authType: 'password' | 'private_key' | 'ssh_agent' | 'certificate';
  groupId?: Id; tagIds: Id[]; lastConnectedAt?: string;
}
```

- [ ] **Step 1: 写输入与 repository 失败测试**

```rust
#[tokio::test]
async fn rejects_duplicate_server_identity_and_invalid_port() {
    let repo = test_repository().await;
    let first = server_input("prod", "example.com", 22, "deploy");
    repo.create(first.clone()).await.unwrap();
    let duplicate = repo.create(first).await.unwrap_err();
    assert_eq!(duplicate.code(), CoreErrorCode::Conflict);
    assert_eq!(ServerPort::try_from(0).unwrap_err().code(), CoreErrorCode::Validation);
}
```

TS 测试断言 host/name trim、端口 1-65535、生产环境标识必填。

- [ ] **Step 2: 运行测试并确认类型/repository 缺失**

Run: `pnpm --filter @opspilot/contracts test --run src/server.test.ts && cargo test -p opspilot-persistence --test server_repository`  
Expected: FAIL，因 Server schema 和 repository 未定义。

- [ ] **Step 3: 实现领域值对象和事务 CRUD**

- `ServerPort(u16)` 只允许 1-65535；`Host` 禁止空白、控制字符与 URL scheme。
- 唯一键为归一化 `(host, port, username)`；显示名可重复但同组建议由 UI 提示。
- create/update 在单事务内写服务器与 tags；delete 只删除数据库行和关联 secret，由 command 层先确认后调用 `SecretStore.delete`。
- command 返回脱敏 `ServerSummary`，不返回 `secret_ref` 的内部 account 结构。
- create/update/delete/import_apply 在数据库/SecretStore 事务结果确定后写脱敏审计；删除失败不得留下“成功”审计，审计 payload 只含 serverId、字段名集合和结果，不含 host/username/secret_ref account。
- 批量导入接受 UTF-8 CSV 和结构化 JSON；preview 逐行返回 valid/error/duplicate，不读取秘密列、不写数据库。preview 数据保存在 Rust 进程内按 desktop session 隔离的有界 LRU：TTL 15 分钟、最多 10 个 import/10,000 行，绑定源文件 SHA-256 与随机不可猜测的一次性 importId；进程重启、session 关闭、apply 成功或 TTL 到期立即失效。apply 只接收 importId + 勾选 rowId，重验 session/摘要/有效行并在单事务写入；不得从 UI 回传整行内容重建 preview。

- [ ] **Step 4: 验证 CRUD、级联和 DTO**

Run: `pnpm --filter @opspilot/contracts test --run && cargo test -p opspilot-domain -p opspilot-persistence && pnpm verify:static`  
Expected: PASS；删除 group 后 server.group_id 置空，删除 server 后 server_tags 清空。

- [ ] **Step 5: 提交任务**

```bash
git add crates/domain crates/persistence packages/contracts src-tauri/src
git commit -m "feat: 实现服务器目录管理"
```

### Task 2: 实现 TOFU 主机指纹与认证材料边界

**Files:**
- Create: `crates/ssh-core/Cargo.toml`
- Create: `crates/ssh-core/src/lib.rs`
- Create: `crates/ssh-core/src/config.rs`
- Create: `crates/ssh-core/src/known_hosts.rs`
- Create: `crates/ssh-core/src/auth.rs`
- Create: `crates/ssh-core/src/auth/agent.rs`
- Create: `crates/ssh-core/src/auth/certificate.rs`
- Create: `crates/ssh-core/tests/known_hosts.rs`
- Create: `crates/persistence/migrations/0003_host_keys.sql`
- Modify: `Cargo.toml`
- Create: `packages/contracts/src/host-key.ts`
- Create: `packages/contracts/src/host-key.test.ts`
- Create: `tests/contract-fixtures/host-key-unknown.json`

**Interfaces:**
- Consumes: `ServerSummary`、`SecretStore`、russh public key。
- Produces: `HostKeyVerifier::verify`、`HostKeyVerifier::trust`、`AuthResolver::resolve`。

```rust
pub enum HostKeyDecision {
    Trusted,
    Unknown { verification_id: Id, algorithm: String, sha256: String, expires_at: DateTime<Utc> },
    Changed { expected_sha256: String, actual_sha256: String },
}
```

Rust enum 使用 `#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]`；TS 对等 Unknown 字段名为 `verificationId/algorithm/sha256/expiresAt`，Changed 为 `expectedSha256/actualSha256`，并加入契约 fixture。

- [ ] **Step 1: 写未知/可信/变化三态失败测试**

```rust
#[tokio::test]
async fn blocks_changed_host_key_without_mutating_trust_store() {
    let store = TestHostKeyStore::default();
    store.trust(endpoint("srv", 22), key_a()).await.unwrap();
    let decision = store.verify(endpoint("srv", 22), &key_b()).await.unwrap();
    assert!(matches!(decision, HostKeyDecision::Changed { .. }));
    assert_eq!(store.saved_key(endpoint("srv", 22)).await, Some(key_a()));
}
```

另写测试验证 `[host]:port` 规范化、SHA256 显示格式、unknown 不自动保存，以及 `verification_id` 绑定 serverId/host/port/hash、10 分钟过期、一次性消费；过期或重复 trust 必须零写入。

- [ ] **Step 2: 运行测试并确认 verifier 缺失**

Run: `cargo test -p opspilot-ssh-core --test known_hosts`  
Expected: FAIL，因 `HostKeyVerifier` 未定义。

- [ ] **Step 3: 实现主机身份与认证解析**

- 使用 russh key fingerprint API 生成用户显示值，存储算法、公钥编码、SHA256 和确认时间。
- `trust` 只接受前一次 Unknown 响应中实际返回的 `verification_id`，且绑定 serverId/host/port/实际 key hash，防止确认错对象。
- `AuthResolver` 只在连接作用域内解析 `SecretRef`，密码/口令放入 `Zeroizing<String>`；私钥文件只保存路径引用，读取前检查为普通文件且拒绝 world-writable。
- `ssh_agent` 通过当前用户的系统 OpenSSH agent socket/Windows named pipe 请求签名，只允许枚举公钥指纹，不复制私钥；agent 不可用时返回稳定的 `SSH_AUTHENTICATION` 原因并可切换其他认证。
- `certificate` 必须同时解析 OpenSSH user certificate 与其配对私钥引用，校验有效期、签名 key 类型和 server 配置中的期望 principal；证书正文可读但私钥/口令仍由 SecretStore 短生命周期解析。
- 密码、私钥、ssh-agent、certificate 分别有成功/拒绝/不可用 fixture；DTO 中不得保留没有实现和测试的 authType。
- 日志只允许 `auth_type` 与 key fingerprint，不允许 secret/path 内容。

- [ ] **Step 4: 验证认证 fixture 不泄漏**

Run: `cargo test -p opspilot-ssh-core -p opspilot-secrets -p opspilot-audit && pnpm verify:static`  
Expected: PASS；测试捕获日志中不包含密码、私钥正文或 API token fixture。

- [ ] **Step 5: 提交任务**

```bash
git add Cargo.toml Cargo.lock crates/ssh-core crates/persistence/migrations/0003_host_keys.sql packages/contracts/src/host-key.ts packages/contracts/src/host-key.test.ts tests/contract-fixtures/host-key-unknown.json
git commit -m "feat: 强制校验 SSH 主机身份"
```

### Task 3: 实现连接状态机与 russh 会话管理

**Files:**
- Create: `crates/ssh-core/src/connection.rs`
- Create: `crates/ssh-core/src/backend.rs`
- Create: `crates/ssh-core/tests/connection_state.rs`
- Create: `src-tauri/src/commands/connection.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Create: `packages/contracts/src/connection.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Consumes: `HostKeyVerifier`、`AuthResolver`、Server connection config。
- Produces: `ConnectionManager::{test,connect,disconnect,get}`；`connection:state` 事件。

```rust
pub enum ConnectionState {
    Idle, Connecting, HostVerifying, Authenticating, Ready,
    Reconnecting { attempt: u8 }, Closed, Error { code: CoreErrorCode },
}
```

- [ ] **Step 1: 写纯状态机失败测试**

```rust
#[test]
fn changed_host_key_never_reaches_authentication() {
    let mut machine = ConnectionMachine::new();
    machine.apply(ConnectionEvent::ConnectRequested).unwrap();
    machine.apply(ConnectionEvent::TcpConnected).unwrap();
    let err = machine.apply(ConnectionEvent::HostKeyChanged).unwrap_err();
    assert_eq!(err.code(), CoreErrorCode::SshHostKeyChanged);
    assert!(matches!(machine.state(), ConnectionState::Error { .. }));
}
```

覆盖 Ready 断线到 Reconnecting、手动关闭不重连、最大重连次数到 Error。

- [ ] **Step 2: 运行测试并确认状态机缺失**

Run: `cargo test -p opspilot-ssh-core --test connection_state`  
Expected: FAIL，因 `ConnectionMachine` 未定义。

- [ ] **Step 3: 实现连接管理器**

- key 使用 `server_id`，同一 server 可复用 transport，但每个 channel 有独立 ID 和取消 token。
- KeepAlive 默认 30 秒、连续 3 次无响应转入 Reconnecting；值由设置覆盖但限制 10-300 秒。
- 连接配置解析直连、HTTP/SOCKS 代理与有序 jump-host 链；检测 jump 环和跨链重复 serverId，链中每一跳独立校验主机指纹。
- 重连只恢复标记 `resumable=true` 的 Shell/读取订阅；Exec 请求必须由上层查询状态后决定。
- `test_connection` 建立、认证、读取基础 banner 后立即关闭，不写 `last_connected_at`；正式 Ready 才更新时间。
- 所有状态事件包含 `serverId`、`connectionId`、递增 `sequence`。

- [ ] **Step 4: 验证状态机与 command 序列化**

Run: `cargo test -p opspilot-ssh-core && pnpm --filter @opspilot/contracts test --run && pnpm verify:static`  
Expected: PASS；Rust/TS 对同一 `connection:state` fixture 的 `serverId/connectionId/sequence/state` 序列化一致。乱序丢弃、空洞恢复属于 05 Task 1 的真实前端 event reducer 测试，不在 contracts 包伪装覆盖。

- [ ] **Step 5: 提交任务**

```bash
git add crates/ssh-core packages/contracts src-tauri/src/commands
git commit -m "feat: 实现可恢复 SSH 连接管理"
```

### Task 4: 实现多会话 Shell、PTY 与有序终端流

**Files:**
- Create: `crates/ssh-core/src/terminal.rs`
- Create: `crates/ssh-core/tests/terminal.rs`
- Create: `src-tauri/src/commands/terminal.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Create: `packages/contracts/src/terminal.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Consumes: Ready `ConnectionHandle`。
- Produces: `terminal_open/write/resize/close`；`terminal:data`；`TerminalData { terminalSessionId, sequence, bytesBase64 }`。

- [ ] **Step 1: 写会话隔离失败测试**

```rust
#[tokio::test]
async fn routes_bytes_and_resize_to_the_bound_channel_only() {
    let backend = InMemoryShellBackend::new();
    let manager = TerminalManager::new(backend.clone());
    let a = manager.open(connection("a"), PtySize::new(80, 24)).await.unwrap();
    let b = manager.open(connection("a"), PtySize::new(120, 40)).await.unwrap();
    manager.write(a.id(), b"uptime\n").await.unwrap();
    manager.resize(b.id(), PtySize::new(140, 50)).await.unwrap();
    assert_eq!(backend.writes(a.id()), vec![b"uptime\n".to_vec()]);
    assert_eq!(backend.resizes(b.id()), vec![PtySize::new(140, 50)]);
}
```

- [ ] **Step 2: 运行测试并确认 manager 缺失**

Run: `cargo test -p opspilot-ssh-core --test terminal`  
Expected: FAIL，因 `TerminalManager` 未定义。

- [ ] **Step 3: 实现 Shell 与背压策略**

- `open` 创建 PTY 和 shell，尺寸限制 2-1000 列/行；`write` 接收 base64 解码后的原始 bytes。
- 每个 session 单独递增 sequence；以 16 KiB 或 16ms 为一批 emit，队列超过 4 MiB 时暂停读取并报告 backpressure，不能静默丢字节。
- Close 是幂等的；窗口销毁时关闭其全部 terminal session，但不强制断开仍被其他窗口使用的 transport。
- 粘贴保护属于 UI；Core 只执行用户确认后的 bytes，不解析或改写命令。

- [ ] **Step 4: 运行终端单元与并发测试**

Run: `cargo test -p opspilot-ssh-core terminal -- --nocapture && pnpm verify:static`  
Expected: PASS；100 个并发 session fixture 无串流、无死锁、关闭后写入返回 `NOT_FOUND`。

- [ ] **Step 5: 提交任务**

```bash
git add crates/ssh-core packages/contracts src-tauri/src/commands
git commit -m "feat: 提供隔离的 SSH 终端会话"
```

### Task 5: 建立通用任务状态机并实现 SFTP 传输

**Files:**
- Create: `crates/task-engine/Cargo.toml`
- Create: `crates/task-engine/src/lib.rs`
- Create: `crates/task-engine/src/state.rs`
- Create: `crates/task-engine/src/gateway.rs`
- Create: `crates/task-engine/src/risk.rs`
- Create: `crates/task-engine/tests/state.rs`
- Create: `crates/task-engine/tests/gateway.rs`
- Create: `crates/task-engine/tests/risk.rs`
- Create: `crates/ssh-core/src/sftp.rs`
- Create: `crates/ssh-core/tests/sftp.rs`
- Create: `src-tauri/src/commands/file.rs`
- Create: `src-tauri/src/commands/operation.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Create: `packages/contracts/src/file.ts`
- Create: `packages/contracts/src/approval.ts`
- Create: `crates/persistence/migrations/0004_tasks.sql`
- Create: `crates/persistence/src/tool_call_repository.rs`
- Create: `crates/persistence/src/approval_repository.rs`
- Modify: `Cargo.toml`

**Interfaces:**
- Consumes: Ready `ConnectionHandle`、Database、AuditWriter、ServerRepository 提供的 environment/resource scope。
- Produces: `RiskEvaluator::evaluate(ToolDefinition, immutable context)`、`OperationGateway::{prepare,approve_and_submit,reject,status}` 最小安全入口、`TaskEngine::{start,cancel,retry}` 最小状态机；只读 `file_list/file_preview` 与按 tool catalog 注册的传输/文件 executor。

```rust
pub enum ConflictPolicy { Fail, Overwrite, Rename, ResumeIfMatching }
```

`TaskStatus` 只能复用 01 固化的 9 状态 Rust 类型，并保持 `#[serde(rename_all = "snake_case")]`；本计划禁止重新声明缩减版枚举。

- [ ] **Step 1: 写任务与路径失败测试**

```rust
#[test]
fn completed_or_cancelled_transfer_cannot_run_again() {
    let succeeded = TaskState::new().start().unwrap().succeed().unwrap();
    assert!(succeeded.start().is_err());
    let cancelled = TaskState::new().cancel().unwrap();
    assert!(cancelled.start().is_err());
}
```

SFTP 测试使用真实临时目录 adapter，覆盖恶意文件名、符号链接、部分文件和 hash 不匹配。Gateway 测试直接调用 executor，断言没有持久化 ToolCall/有效 ApprovalProof 时一律返回 `APPROVAL_REQUIRED` 且远端写入次数为 0。

- [ ] **Step 2: 运行测试并确认状态机/SFTP 缺失**

Run: `cargo test -p opspilot-task-engine -p opspilot-ssh-core`  
Expected: FAIL，因状态机和 SFTP service 未定义。

- [ ] **Step 3: 实现最小任务和流式传输**

- `0004_tasks.sql` 同时建立 task/step、immutable tool_calls 和 approvals；tool call 的 name/server/args canonical JSON/args_digest/schemaVersion 创建后不可 UPDATE/DELETE，approval 唯一关联 tool_call_id + digest，并持久化 Rust 生成的 target_label、可空 confirmation_target、confirmation_text/policy_version/expiry。L3 proof 的 confirmedResource 只作为批准输入，规范化后与 confirmation_target 比较并写脱敏决定摘要；重复批准返回同一 taskId。`packages/contracts/src/approval.ts` 对应导出 `ApprovalRequest.confirmationTarget?`，不得要求 UI 从 confirmationText 提取资源名。
- WebView 可调用 `operation_prepare(ToolCall)` 与 `operation_approve(ApprovalProof)`；不注册 `file_delete/file_chmod/file_chown/file_archive/file_extract` 等直达 command。Gateway 从 Rust catalog 找 executor，并由本任务建立的 `RiskEvaluator` 根据工具定义、服务器环境、资源范围和不可变 args 重算 RiskDecision，写审计后决定 L0 返回或 L1-L3 等待；调用方不能提交 risk/snapshotRequired/policyVersion。`03` 只能扩展这一个 evaluator 的策略表，不能另建判定入口。
- L4 必须返回 `PrepareResult::Blocked`、写一条 blocked 审计且不创建 Approval/Task/Snapshot；L4 定义不下发给 Agent catalog，人工 UI 也只展示原因。若策略无法分类或上下文缺字段，fail closed 为 L4/blocked，而不是降级为 L0-L3。
- upload 写入同目录 `.opspilot-upload-<taskId>.part`，完成后 fsync（若支持）并原子 rename；overwrite 前先显式 ConflictPolicy。upload/overwrite/rename/move/copy/delete/chmod/chown/archive/extract 均以同一 `toolCallId/runId/argsDigest` 进入 Gateway，执行端只接受 Gateway 解析出的内部 `ApprovedOperation`。
- download 写本地 `.part`，记录远端 size/mtime/hash；Resume 只在这些元数据与已保存 checkpoint 一致时允许。
- 每个 transfer task 记录 total/transferred/speed、取消 token、错误码；取消保留可恢复 `.part`，用户删除任务时才清理。
- `retry` 永远是用户显式动作：创建新的 attempt/toolCallId 并通过 `retryOfToolCallId` 关联原任务；读取和可校验传输可复用 checkpoint，任何远端写 executor 都不因断线或进程重启自动 retry/replay。
- list/preview 对大文件只读前后窗口；不得把超过配置上限的文件一次性装入内存。
- rename/move/copy/delete/chmod/chown 分别使用结构化 DTO 与 RemotePath 校验；delete、owner/permission 扩权进入 RiskDecision，不能由文件名拼接命令。
- archive 不把文件名拼进 shell：Core 以 SFTP 写入 NUL 分隔、相对选定 root 的临时清单，调用静态 tar program + 独立 argv 的 `--null --verbatim-files-from -T <list>`；拒绝 NUL、root 外路径、前导 option 混淆，结束后删除清单。
- extract 先把目录解析到受控 staging：Core 流式解析 tar/zip central directory，拒绝绝对路径、`..`、设备节点、逃逸 hardlink/symlink；远端解压只使用静态 program/argv，完成后逐项 realpath 验证仍在 staging，全部通过才移动到用户根目录。任何失败清理 staging 且目标目录零写入。

- [ ] **Step 4: 验证传输、取消与恢复**

Run: `cargo test -p opspilot-task-engine -p opspilot-persistence -p opspilot-audit -p opspilot-ssh-core sftp && pnpm verify:static`  
Expected: PASS；无 ApprovalProof 的所有写 executor 执行次数为 0；注入中断后用户显式 Resume 从 checkpoint 继续，hash 变化时拒绝 Resume；含分号、引号、换行、前导 `-` 与逃逸 link 的 archive fixture 均零目标写入。

- [ ] **Step 5: 提交任务**

```bash
git add Cargo.toml Cargo.lock crates/task-engine crates/ssh-core crates/persistence/migrations/0004_tasks.sql crates/persistence/src/tool_call_repository.rs crates/persistence/src/approval_repository.rs packages/contracts/src/file.ts packages/contracts/src/approval.ts src-tauri/src/commands/file.rs src-tauri/src/commands/operation.rs src-tauri/src/commands/mod.rs
git commit -m "feat: 以任务驱动 SFTP 传输"
```

### Task 6: 实现端口转发、OpenSSH 回退与真实 SSH 集成环境

**Files:**
- Modify: `package.json`
- Create: `crates/ssh-core/src/tunnel.rs`
- Create: `crates/ssh-core/src/streamlocal.rs`
- Create: `crates/ssh-core/src/openssh.rs`
- Create: `crates/ssh-core/src/ssh_config.rs`
- Create: `crates/ssh-core/tests/tunnel.rs`
- Create: `crates/ssh-core/tests/streamlocal.rs`
- Create: `tests/fixtures/ssh/Dockerfile`
- Create: `tests/fixtures/ssh/entrypoint.sh`
- Create: `tests/integration/ssh/docker-compose.yml`
- Create: `tests/integration/ssh/ssh_flow.rs`
- Create: `tests/integration/Cargo.toml`
- Create: `tests/integration/run-ssh.sh`
- Create: `crates/persistence/migrations/0005_tunnels_profiles.sql`
- Create: `packages/contracts/src/tunnel.ts`
- Modify: `Cargo.toml`
- Create: `docs/architecture/ssh-compatibility.md`

**Interfaces:**
- Consumes: `ConnectionManager`、`TerminalManager`、`SecretStore`。
- Produces: `TunnelManager::{open,close,list}`、`UnixSocketForwarder::open(connection, remote_socket)`、`OpenSshBackend`、`SshConfigImporter::preview/apply`；P0 真实链路验收证据。03 Docker 只消费该 streamlocal 能力，不自行拼接隧道命令。

- [ ] **Step 1: 写端口与命令参数失败测试**

```rust
#[test]
fn openssh_arguments_do_not_invoke_a_shell() {
    let args = OpenSshArgs::for_server(server("example.com;touch /tmp/pwned"));
    assert!(args.is_err());
    let args = OpenSshArgs::for_server(server("example.com")).unwrap();
    assert_eq!(args.program(), "ssh");
    assert!(!args.arguments().iter().any(|arg| arg.contains("sh -c")));
}
```

端口测试先占用本地端口，再断言 local forward 返回 `CONFLICT`。

- [ ] **Step 2: 运行测试并确认 adapter 缺失**

Run: `cargo test -p opspilot-ssh-core tunnel && cargo test -p opspilot-ssh-core openssh`  
Expected: FAIL，因 `TunnelManager`/`OpenSshArgs` 未定义。

- [ ] **Step 3: 实现三类转发和回退**

- Local/Remote/Dynamic 使用结构化 `TunnelRule`，bind host 默认 `127.0.0.1`；绑定 `0.0.0.0` 需显式风险确认。
- `UnixSocketForwarder` 只接受归一化的远端绝对 socket path，通过 SSH `direct-streamlocal@openssh.com` channel 暴露为进程内 AsyncRead/AsyncWrite，不监听本机 TCP、不可持久化或恢复。服务端/后端不支持该扩展时返回稳定 `CAPABILITY_UNAVAILABLE`，03 DockerAdapterFactory 才可回退结构化 CLI；禁止用 `socat`、shell 字符串或开放 2375/2376 模拟该能力。
- OpenSSH 回退只允许 `ssh` 可执行文件绝对路径或系统解析结果，所有参数逐项传入 `Command`/`portable-pty`，禁止 `sh -c`/`cmd /C`。
- 只把硬件密钥、复杂 ProxyCommand、未支持算法等兼容场景路由到回退；普通连接继续用 russh。
- 回退 stderr 经 Redactor；环境变量使用允许列表，不传递应用 secret 环境。
- tunnels 与 terminal_profiles 持久化到独立 migration；重启应用后只恢复规则定义，不自动打开远程/公网转发。
- `~/.ssh/config` importer 支持 Host/Hostname/User/Port/IdentityFile/ProxyJump 的确定子集，preview 展示展开值和 unsupported directive；导入不会复制私钥、不会静默信任 known_hosts、不会自动执行 ProxyCommand。

- [ ] **Step 4: 建立真实 SSH fixture**

Dockerfile 基于 `ubuntu:24.04`，安装 `openssh-server`，创建 `opspilot` 用户、固定测试密码和测试公钥；Compose 启动 `target` 与 `jump` 两台容器，端口只发布到 `127.0.0.1`。entrypoint 每次可选择保留或重建 host key，用于 TOFU 与 key-changed 测试。

同时建立 Cargo package `opspilot-integration-tests`，把 `ssh/ssh_flow.rs` 注册为 `[[test]] name = "ssh_flow"`，并将 `tests/integration` 加入根 Cargo workspace。所有需要 Docker/网络进程的 test 标记 `#[ignore = "requires Docker SSH fixture"]` 并使用 Cargo feature `external-fixtures`；因此 `cargo test --workspace` 只编译并忽略它们，不会要求 Docker。后续计划只向这个 package 增加同样 gated 的命名 test target。

- [ ] **Step 5: 跑真实集成矩阵**

`run-ssh.sh` 必须先启动 Compose、轮询 SSH health、再执行 `cargo test -p opspilot-integration-tests --features external-fixtures --test ssh_flow -- --ignored --test-threads=1`，最后用 trap 清理 fixture。

根脚本将它登记为 `pnpm test:integration:external:ssh`，并由 `pnpm test:integration:external`/`pnpm test:integration:all` 聚合；默认 `pnpm test:integration` 保持无 Docker、无外网可运行，不能直接挂入该脚本。

Run: `bash tests/integration/run-ssh.sh && pnpm verify:static`  
Expected: 密码、私钥、代理/跳板、Shell resize、SFTP 全操作、local forward、断线/手动重连、ssh_config preview 全部 PASS；重建任一跳 host key 后连接明确失败为 `SSH_HOST_KEY_CHANGED`。

再次在不启动 Agent runtime、无模型环境变量的 shell 中运行同一命令，Expected 仍全部 PASS。

- [ ] **Step 6: 提交任务**

```bash
git add package.json crates/ssh-core crates/persistence/migrations/0005_tunnels_profiles.sql packages/contracts/src/tunnel.ts tests/integration tests/fixtures docs/architecture/ssh-compatibility.md
git commit -m "feat: 完成 SSH P0 兼容性闭环"
```

## 完成检查

- [ ] Server DTO 永远不返回 secret 值。
- [ ] Unknown/Trusted/Changed 三种 host key 路径都有真实测试。
- [ ] 终端 bytes 有 sessionId 和 sequence，100 会话无串流。
- [ ] SFTP 中断可恢复，远端元数据变化时拒绝错误续传。
- [ ] 文件写 command 无直达 executor；抽样 upload/delete/extract 可由 audit 反查同一 toolCallId/runId/digest/approval/task。
- [ ] 端口转发默认只绑定 loopback，公网绑定走风险确认。
- [ ] OpenSSH 回退不调用 shell 字符串，stderr 已脱敏。
- [ ] streamlocal 支持时 Docker 可复用进程内 Unix socket channel；不支持时返回稳定错误并由上层回退 CLI，始终不开放 Docker TCP daemon。
- [ ] Agent 与模型完全关闭时所有人工连接能力仍可用。
