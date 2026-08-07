# OpsPilot 任务引擎与运维适配器实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在安全 SSH 底座上交付统一任务/快照/风险引擎，以及服务器概览、systemd、项目部署、Docker/Compose 和 Nginx 的可审查、可取消、可回滚运维能力。

**Architecture:** 所有运维写操作先以固化 `ToolCall` 进入 02 建立的 `OperationGateway`；Gateway 调用 Rust `ToolExecutor.prepare`，写工具返回 `ToolAction::Write(OperationPlan)`，Gateway 重算 `RiskDecision` 后再经审批/快照交给 `TaskEngine`。用户输入只能作为经过验证和 POSIX 编码的参数进入远程命令；OperationPlan 是入口下游产物，不是第二条执行通道。

**Tech Stack:** Rust/Tokio、SSH/SFTP、SQLite、serde、sha2、bollard 或 Docker CLI adapter、Nginx CLI、systemd、Vitest/Rust integration tests、Docker Compose fixtures。

## Global Constraints

- 所有耗时操作都必须进入 TaskEngine；状态只允许按本计划定义的状态机迁移。
- 重试必须由步骤显式声明 `RetryPolicy`；删除、迁移、任意 hook 默认不可自动重试。
- 每个用户输入参数分别校验；远程 Exec 虽然最终是命令字符串，也必须从静态 program + 已编码 argv 构造，禁止拼接 shell 片段。
- Nginx 写操作固定执行：快照 → 临时文件 → Diff → `nginx -t` → 原子替换 → reload → 健康检查 → 必要时恢复。
- Docker API 不暴露公网；优先经 SSH 受控隧道/Unix socket，能力不足时回退 Docker CLI。
- L4 操作不实现；L3 必须强制快照且不能通过调用方参数关闭。
- 适配器不得公开写 executor 给 Tauri command/Sidecar；所有写任务和审计必须能反查同一 `toolCallId/runId/serverId/argsDigest`。
- Docker/SSH/Nginx 等外部 fixture test 继续使用 `external-fixtures` feature + `#[ignore]`；每个 `run-*.sh` 负责启动、health polling、`--ignored --test-threads=1` 与 trap 清理，`cargo test --workspace` 不要求 Docker。
- 每个 `run-*.sh` 只有在文件创建并通过直接运行后，才可加入根 `test:integration:external` 聚合；对应 Task 必须同时修改并提交 `package.json`，不得预先登记不存在的入口。
- 每个 Task 的行为测试通过后、提交前都必须再运行 `pnpm verify:static`；该根脚本统一执行 pnpm lint/typecheck 与 Cargo fmt/clippy，任一非零退出都阻断提交。

---

## 文件责任映射

| 路径 | 唯一责任 |
|---|---|
| `crates/task-engine` | Task/Step、取消、重试、恢复、回滚编排 |
| `crates/remote-adapters/src/command.rs` | 远程 program/argv/cwd/timeout 安全编码 |
| `crates/remote-adapters/src/linux.rs` | Linux capability 和系统指标探测 |
| `crates/remote-adapters/src/systemd.rs` | 服务与日志操作 |
| `crates/remote-adapters/src/project.rs` | 项目检测与运行适配器 |
| `crates/remote-adapters/src/deploy.rs` | 发布计划、健康检查和回滚 |
| `crates/remote-adapters/src/docker` | Docker API/CLI 与 Compose |
| `crates/remote-adapters/src/nginx` | Nginx discovery、计划、验证、应用、恢复 |
| `crates/persistence/src/task_repository.rs` | Task/Step/Snapshot 状态持久化 |

### Task 1: 扩展统一 OperationGateway、TaskEngine、Snapshot 与确定性风险策略

**Files:**
- Modify: `crates/task-engine/src/state.rs`
- Modify: `crates/task-engine/src/gateway.rs`
- Create: `crates/task-engine/src/engine.rs`
- Create: `crates/task-engine/src/step.rs`
- Create: `crates/task-engine/src/snapshot.rs`
- Modify: `crates/task-engine/src/risk.rs`
- Create: `crates/task-engine/tests/engine.rs`
- Create: `crates/persistence/src/task_repository.rs`
- Modify: `crates/persistence/src/tool_call_repository.rs`
- Modify: `crates/persistence/src/approval_repository.rs`
- Create: `crates/persistence/migrations/0006_task_engine.sql`
- Modify: `packages/contracts/src/task.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `src-tauri/src/commands/task.rs`
- Modify: `src-tauri/src/commands/mod.rs`

**Interfaces:**
- Consumes: P0 完整 `TaskStatus`、`OperationGateway`、immutable ToolCall/Approval、Database、AuditWriter、RiskDecision、02 建立的唯一 `RiskEvaluator`。
- Produces: Gateway 内部 `TaskEngine::submit(OperationPlan)`、`cancel`、`retry`、`recover_interrupted`、`rollback`；`TaskRepository::events_since(task_id, after_sequence)` 与只读 `task_events_since` command；扩展同一 RiskEvaluator 的 L0-L4 策略表；`Snapshotter` trait。Tauri/Sidecar 的写入仍只能调用 Gateway。

```rust
pub struct OperationPlan {
    pub task_id: Id,
    pub tool_call_id: Id,
    pub run_id: Id,
    pub server_id: Id,
    pub project_id: Option<Id>,
    pub args_digest: Sha256Digest,
    pub environment: Environment,
    pub resource_scope: ResourceScope,
    pub operation: OperationKind,
    pub computed_risk: RiskDecision,
    pub steps: Vec<PlannedStep>,
}

pub enum RetryPolicy { Never, Safe { max_attempts: u8, backoff_ms: u64 } }
pub enum CancelCapability { Cooperative, StopAfterCurrentStep, NotCancelable { reason: String } }
```

- [ ] **Step 1: 写状态、取消和回滚失败测试**

```rust
#[tokio::test]
async fn failed_snapshotted_task_can_roll_back_once() {
    let engine = test_engine().await;
    let id = engine.submit(plan_with_snapshot_and_failing_apply()).await.unwrap();
    assert_eq!(engine.wait(id).await.status, TaskStatus::Failed);
    engine.rollback(id).await.unwrap();
    assert_eq!(engine.get(id).await.unwrap().status, TaskStatus::RolledBack);
    assert!(engine.rollback(id).await.is_err());
}
```

另测：Cooperative Running 可取消、不可安全中断步骤只阻止后续步骤并返回原因、Succeeded 不可取消、启动时 Running 变 Interrupted、Never 步骤不可 retry、L3 无 snapshot 计划被拒绝，以及任一 OperationPlan 的 ToolCall/digest/environment/resourceScope 不匹配时零执行。

- [ ] **Step 2: 运行测试并确认引擎能力缺失**

Run: `cargo test -p opspilot-task-engine --test engine`  
Expected: FAIL，因 `OperationPlan`/`rollback` 尚未定义。

- [ ] **Step 3: 实现状态机和持久化顺序**

- 状态完整集合：Pending → Running → Succeeded/Failed/Cancelled；Failed/Interrupted 且有快照可进入 RollingBack → RolledBack/RollbackFailed。
- 每次状态变更先在事务中把 task state 与 immutable event row 一并持久化，再发事件；事件包含 taskId、streamId、sequence、status、progress、currentStep、error。`task_events_since` 按 sequence 升序补拉且有 `hasMore/oldestAvailableSequence`；保留期内不得空洞，超出保留期明确返回 retention gap，由 UI 强制 Query snapshot 重同步。
- 启动恢复把遗留 Running/RollingBack 标记 Interrupted，并提供 `inspect_remote_state`，不猜测成功/失败。
- `args_digest` 使用 canonical JSON + SHA-256；审批、任务、审计和快照共享同一 digest。
- Snapshot 元数据保存 checksum、远端路径、权限、owner、创建时间；内容存应用私有目录或远端受控备份路径。
- Gateway 从已持久化 ToolCall 和 Server/Project 元数据填充 `environment/resource_scope`；adapter/Agent/UI 提交的同名字段全部忽略并拒绝冲突值。OperationPlan 创建后不可变，审批只引用 toolCallId + argsDigest。
- 审批记录属于共享 Core，而不是 Agent 专属状态；Nginx Diff、Compose plan 或人工 UI 挂起后重启，均从 ApprovalRepository + TaskRepository 恢复 Pending/Approved/Rejected/Expired，不重新执行 prepare 或写入。

- [ ] **Step 4: 实现 L0-L4 策略表**

风险策略由 `OperationKind + Environment + ResourceScope` 计算：`Environment` 固定为 Development/Staging/Production/Other，`ResourceScope` 至少包含 kind/id/label/parentId；读取为 L0；可逆启动/上传为 L1；生产重启、项目/Nginx 更新、单容器删除为 L2；卷/镜像清理、SSH/防火墙/覆盖配置为 L3；磁盘格式化、系统目录递归删除、禁用 SSH 为 L4 并返回不可执行。调用方提交的 risk 只用于核对，不能覆盖计算结果。

- [ ] **Step 5: 验证任务、数据库与审计一致性**

Run: `cargo test -p opspilot-task-engine -p opspilot-persistence -p opspilot-audit && pnpm verify:static`  
Expected: PASS；每个终态有一条审计；旧 sequence 不会覆盖新状态。

- [ ] **Step 6: 提交任务**

```bash
git add crates/task-engine crates/persistence packages/contracts
git commit -m "feat: 建立可恢复运维任务引擎"
```

### Task 2: 实现安全远程命令、能力探测与系统管理

**Files:**
- Create: `crates/remote-adapters/Cargo.toml`
- Create: `crates/remote-adapters/src/lib.rs`
- Create: `crates/remote-adapters/src/command.rs`
- Create: `crates/remote-adapters/src/linux.rs`
- Create: `crates/remote-adapters/src/systemd.rs`
- Create: `crates/remote-adapters/tests/command_encoding.rs`
- Create: `crates/remote-adapters/tests/linux_parsing.rs`
- Create: `packages/contracts/src/system.ts`
- Create: `src-tauri/src/commands/system.rs`
- Modify: `Cargo.toml`

**Interfaces:**
- Consumes: ConnectionManager、TaskEngine、CoreError。
- Produces: `RemoteExecutor::execute(RemoteCommand)`；`system_probe/metrics/services/ports` 和受控 service action。

```rust
pub struct RemoteCommand {
    pub program: ValidatedProgram,
    pub args: Vec<ShellArg>,
    pub cwd: Option<RemotePath>,
    pub timeout: Duration,
    pub stdin: Option<Vec<u8>>,
}

pub struct RemoteExecutionHandle {
    pub remote_pid: Option<u32>,
    pub process_start_token: Option<String>,
    pub cancel_capability: CancelCapability,
}
```

- [ ] **Step 1: 写 POSIX 编码与解析失败测试**

```rust
#[test]
fn quotes_each_argument_without_interpolation() {
    let cmd = RemoteCommand::new("systemctl")
        .arg("status")
        .arg("name; echo pwned")
        .render_posix();
    assert_eq!(cmd, "'systemctl' 'status' 'name; echo pwned'");
}
```

加入 proptest：任意不含 NUL 的字符串经 `/bin/sh -c 'printf ...'` round-trip 后字节一致；NUL 必须拒绝。

- [ ] **Step 2: 运行测试并确认 RemoteCommand 缺失**

Run: `cargo test -p opspilot-remote-adapters --test command_encoding`  
Expected: FAIL，因安全命令 builder 未定义。

- [ ] **Step 3: 实现命令 builder 与 capability 探测**

- program 只允许 `[A-Za-z0-9_./+-]` 并拒绝相对 `..`；argv 使用单引号并把内部 `'` 编码为 `'"'"'`。
- capability 读取 `/etc/os-release`、`uname`、`/proc`、`df -P`、`ip -j`（不可用时静态文本 parser 回退）；parser 不依赖固定本地化文案。
- metrics 输出 timestamp、CPU、memory、load、disk、inode、network，解析失败返回字段级 unavailable，不让整页失败。
- systemd write action 只注册 ToolExecutor 并经 OperationGateway；service 名通过 systemd unit 规则校验，日志读取为 L0。
- capability 不能只判断 `ss` 是否存在：先探测 `ss -H`，支持时用 `ss -H -lntup`；旧 iproute2 回退 `ss -lntup` 并由 parser 去表头；命令不存在/两种参数均不支持才回退 `netstat`。三种输出分别有 fixture。
- 可协作取消的通用远程进程使用受控 wrapper 记录 PID/进程组与 `/proc/<pid>/stat` start token；取消先核对 start token，再 TERM、限时等待、必要时 KILL。无法可靠获取/核对远端进程身份的命令标记 StopAfterCurrentStep/NotCancelable，关闭 SSH channel 不得谎称远端进程已终止。

- [ ] **Step 4: 用固定 fixture 验证多发行版输出**

为 Ubuntu、Debian、Rocky、Alpine（无 systemd）建立文本 fixture；Alpine 返回 `serviceManager: unsupported` 而非伪造 systemd。

Run: `cargo test -p opspilot-remote-adapters && pnpm verify:static`  
Expected: PASS；恶意 service/path payload 均在执行前拒绝。

- [ ] **Step 5: 提交任务**

```bash
git add Cargo.toml Cargo.lock crates/remote-adapters packages/contracts/src/system.ts src-tauri/src/commands/system.rs
git commit -m "feat: 增加安全 Linux 系统适配器"
```

### Task 3: 实现项目模型、检测器与运行适配器

**Files:**
- Create: `crates/domain/src/project.rs`
- Modify: `crates/domain/src/lib.rs`
- Create: `crates/persistence/src/project_repository.rs`
- Create: `crates/persistence/migrations/0007_projects.sql`
- Create: `crates/remote-adapters/src/project.rs`
- Create: `crates/remote-adapters/tests/project_detection.rs`
- Create: `packages/contracts/src/project.ts`
- Create: `src-tauri/src/commands/project.rs`

**Interfaces:**
- Consumes: SFTP list/read、RemoteExecutor、Database。
- Produces: `ProjectDetector::detect(root)`、ProjectRepository、`project_detect/create/status/logs`。

```rust
pub enum RuntimeType { DockerCompose, StaticSite, NodeJs, Go, Python, Generic }
pub enum DeployStrategy { InPlace, ReleaseSymlink, DockerCompose, StaticAtomic }
```

- [ ] **Step 1: 写确定性检测失败测试**

```rust
#[test]
fn compose_wins_over_node_when_both_are_present() {
    let files = fixture_tree(["package.json", "compose.yaml", "Dockerfile"]);
    let result = ProjectDetector::default().detect(&files);
    assert_eq!(result.primary, RuntimeType::DockerCompose);
    assert_eq!(result.evidence, vec!["compose.yaml", "Dockerfile", "package.json"]);
}
```

覆盖 `go.mod`、`requirements.txt`、静态 index.html、空目录和冲突证据。

- [ ] **Step 2: 运行测试并确认 detector 缺失**

Run: `cargo test -p opspilot-remote-adapters --test project_detection`  
Expected: FAIL，因 `ProjectDetector` 未定义。

- [ ] **Step 3: 实现项目模型与检测**

- root_path 使用绝对 RemotePath；repository URL 只允许 `https`/`ssh`/scp-like Git 格式。
- 检测器只读取已知文件名及有限内容，不递归下载整个目录；返回 evidence 和 confidence，用户确认后才持久化。
- Generic 的 start/stop/restart/build 命令保存为结构化 program/args/cwd，不保存任意 shell 文本；确需 raw hook 时标记 L2 并展示完整命令。
- `project_env_refs` 的 secret 环境变量只存 SecretRef，普通值才可存 SQLite。

- [ ] **Step 4: 验证 repository 和 adapter**

Run: `cargo test -p opspilot-domain -p opspilot-persistence -p opspilot-remote-adapters project && pnpm verify:static`  
Expected: PASS；删除 server 受外键保护或明确级联策略，不留下孤立 secret ref。

- [ ] **Step 5: 提交任务**

```bash
git add crates/domain crates/persistence crates/remote-adapters packages/contracts/src/project.ts src-tauri/src/commands/project.rs
git commit -m "feat: 建立项目检测与运行模型"
```

### Task 4: 实现可审查部署、健康检查与回滚

**Files:**
- Modify: `package.json`
- Create: `crates/remote-adapters/src/deploy.rs`
- Create: `crates/remote-adapters/src/health.rs`
- Create: `crates/remote-adapters/tests/deploy_workflow.rs`
- Create: `crates/remote-adapters/tests/health.rs`
- Create: `crates/persistence/migrations/0008_deployments.sql`
- Create: `packages/contracts/src/deploy.ts`
- Create: `packages/contracts/src/health.ts`
- Create: `src-tauri/src/commands/deploy.rs`
- Create: `tests/integration/deploy/deploy_flow.rs`
- Create: `tests/integration/run-deploy.sh`
- Modify: `tests/integration/Cargo.toml`

**Interfaces:**
- Consumes: Project、TaskEngine、Snapshotter、RemoteExecutor、SFTP。
- Produces: `HealthChecker::run(HealthCheckPolicy)`；`deploy.plan/deploy.run/deploy.rollback` ToolExecutor；`DeploymentPlan` 显示 commands/files/target/impact，实际写入只由 Gateway 提交。Task 7 和 06 Task 1 只复用/强化该 checker，不再各自创建实现。

```rust
pub struct HealthCheckPolicy {
    pub url: Url,
    pub expected_status: RangeInclusive<u16>,
    pub interval: Duration,
    pub request_timeout: Duration,
    pub deadline: Duration,
    pub success_threshold: u8,
    pub failure_threshold: u8,
}
```

- [ ] **Step 1: 写健康检查失败自动恢复测试**

```rust
#[tokio::test]
async fn restores_previous_symlink_when_health_check_fails() {
    let remote = ReleaseFixture::with_current("releases/001");
    let result = deployer(remote.clone()).run(release_plan("002", failing_health())).await;
    assert!(result.is_err());
    assert_eq!(remote.read_link("current"), "releases/001");
    assert!(remote.exists("releases/002")); // keep failed release for diagnosis
}
```

- [ ] **Step 2: 运行测试并确认 workflow 缺失**

Run: `cargo test -p opspilot-remote-adapters --test deploy_workflow`  
Expected: FAIL，因 DeployWorkflow 未定义。

- [ ] **Step 3: 实现 release/current 工作流**

固定步骤：preflight（连接/磁盘/Git/runtime/permission/port）→ materialize release → build → optional hook/migration approval → atomic symlink switch → process restart → health check → record。每步有 timeout、RetryPolicy 和 redacted logs。

- 构建失败不切换 current；切换后失败自动恢复旧 symlink 并重启旧版本。
- health check 由 `HealthChecker` 通过 SSH local forward 使用 Rust HTTP client 请求，限制协议为 http/https、禁止访问非项目声明地址；baseline 默认 deadline 60 秒，每次 request_timeout 不得超过剩余 deadline，取消 token 必须中止等待。
- keep_releases 最小 2；清理旧 release 是独立 L2 任务，不夹在成功部署的关键路径。
- raw migration/hook 默认 L2、Never retry，审批摘要包含 cwd、program、args 和环境键名。
- deploy/rollback 的 OperationPlan 必须继承原 ToolCall 的全部关联 ID/digest；自动恢复旧 symlink 是同一 task 的确定性补偿 step，用户另行回滚则创建新 ToolCall 和独立审计。

- [ ] **Step 4: 运行单元与真实部署 fixture**

Run: `cargo test -p opspilot-remote-adapters deploy && bash tests/integration/run-deploy.sh && pnpm verify:static`  
Expected: PASS；在 build/restart/health 三个故障点注入失败均恢复旧版本。

- [ ] **Step 5: 提交任务**

```bash
git add package.json crates/remote-adapters crates/persistence/migrations/0008_deployments.sql packages/contracts/src/deploy.ts src-tauri/src/commands/deploy.rs tests/integration/Cargo.toml tests/integration/deploy tests/integration/run-deploy.sh
git commit -m "feat: 实现可回滚项目部署"
```

### Task 5: 实现 Docker 安全传输、发现、日志与统计

**Files:**
- Modify: `package.json`
- Create: `crates/remote-adapters/src/docker/mod.rs`
- Create: `crates/remote-adapters/src/docker/api.rs`
- Create: `crates/remote-adapters/src/docker/cli.rs`
- Create: `crates/remote-adapters/tests/docker_parsing.rs`
- Create: `packages/contracts/src/docker.ts`
- Create: `src-tauri/src/commands/docker.rs`
- Create: `tests/integration/docker/docker_read_flow.rs`
- Create: `tests/integration/run-docker-read.sh`
- Modify: `tests/integration/Cargo.toml`

**Interfaces:**
- Consumes: 02 `UnixSocketForwarder`、RemoteExecutor、Project。
- Produces: `DockerReadAdapter`；version、container/image/network/volume list/inspect、logs、stats 与磁盘占用；本任务没有写 executor。

```rust
#[async_trait]
pub trait DockerReadAdapter {
    async fn version(&self) -> Result<DockerVersion, CoreError>;
    async fn list_containers(&self, filter: ContainerFilter) -> Result<Vec<Container>, CoreError>;
    async fn logs(&self, id: ContainerId, cursor: LogCursor) -> Result<LogStream, CoreError>;
    async fn stats(&self, id: ContainerId) -> Result<StatsStream, CoreError>;
}
```

- [ ] **Step 1: 写能力协商、解析与流隔离失败测试**

```rust
#[tokio::test]
async fn falls_back_to_cli_without_exposing_tcp_daemon() {
    let adapter = DockerAdapterFactory::new(api_unavailable(), cli_available()).create_read().await.unwrap();
    assert_eq!(adapter.transport(), DockerTransportKind::Cli);
    assert!(!fixture().published_ports().contains(&2375));
}
```

另测本地化 daemon 输出、API version 协商、containerId+sequence 跨流隔离和 1000 容器分页。

- [ ] **Step 2: 运行测试并确认 read adapter 缺失**

Run: `cargo test -p opspilot-remote-adapters docker_read`  
Expected: FAIL，因 DockerReadAdapterFactory 未定义。

- [ ] **Step 3: 实现 API/CLI 只读双适配器**

- API 只消费 02 提供的进程内 `UnixSocketForwarder` 访问远端 Unix socket 并协商服务端 API version；本层不创建 TCP listener、不拼接 SSH/socat 命令，不得要求用户开放 TCP 2375/2376。
- `UnixSocketForwarder` 返回 `CAPABILITY_UNAVAILABLE` 时才使用 CLI，固定 `--format '{{json .}}'` 逐行解析，不能解析本地化表格；认证/权限/连接错误不得被误当作“能力不足”静默降级。
- logs/stats 流带 containerId + sequence；images/networks/volumes 本任务只提供 list/inspect/history/usage。
- 所有 read 调用以 L0 ToolCall 经过 OperationGateway 校验与审计，但不创建 Approval。

- [ ] **Step 4: 运行真实 Docker 只读 fixture**

Run: `bash tests/integration/run-docker-read.sh && pnpm verify:static`  
Expected: fixture 容器发现、inspect、日志/stats 隔离、镜像/网络/卷只读查询全部 PASS；确认无公网 Docker port。

- [ ] **Step 5: 提交任务**

```bash
git add package.json crates/remote-adapters packages/contracts/src/docker.ts src-tauri/src/commands/docker.rs tests/integration/Cargo.toml tests/integration/docker tests/integration/run-docker-read.sh
git commit -m "feat: 增加受控 Docker 只读适配器"
```

### Task 6: 实现 Docker 写操作、Exec 与 Compose 可回滚闭环

**Files:**
- Modify: `package.json`
- Create: `crates/remote-adapters/src/docker/write.rs`
- Create: `crates/remote-adapters/src/docker/compose.rs`
- Create: `crates/remote-adapters/tests/docker_write.rs`
- Create: `crates/remote-adapters/tests/compose_rollback.rs`
- Create: `crates/persistence/migrations/0009_docker_stacks.sql`
- Modify: `packages/contracts/src/docker.ts`
- Modify: `src-tauri/src/commands/docker.rs`
- Create: `tests/integration/docker/docker_write_flow.rs`
- Create: `tests/integration/run-docker-write.sh`
- Modify: `tests/integration/Cargo.toml`

**Interfaces:**
- Consumes: DockerReadAdapter、OperationGateway、TaskEngine、Snapshotter、Project。
- Produces: Rust catalog 中的 container start/stop/restart/remove/exec、image pull/build/remove、network/volume create/remove、compose plan/apply/rollback ToolExecutor。

- [ ] **Step 1: 写风险门与 Compose 真实回滚失败测试**

```rust
#[tokio::test]
async fn compose_health_failure_restores_config_images_and_services() {
    let before = stack_fixture().snapshot().await;
    let prepared = gateway().prepare(compose_update_call(failing_health()), actor()).await.unwrap();
    gateway().approve_and_submit(proof_for(&prepared)).await.unwrap();
    assert_eq!(stack_fixture().snapshot().await, before);
    assert_eq!(stack_fixture().remote_apply_count(), 2); // apply candidate + deterministic restore
}
```

另测：无 ApprovalProof 的 restart/Exec/remove/prune 执行次数为 0；volume remove=L3；删除卷/镜像默认资源列表为空；相同 approval 重复提交只产生一个 task。

- [ ] **Step 2: 运行测试并确认写 catalog/rollback 缺失**

Run: `cargo test -p opspilot-remote-adapters docker_write compose_rollback`  
Expected: FAIL，因 Docker write executor 与 ComposeSnapshot 未定义。

- [ ] **Step 3: 实现写 executor 与 Compose snapshot**

- Exec 的 argv/cwd/tty 完整进入 argsDigest；交互 Exec 默认 L1，生产或特权 Exec 至少 L2，`--privileged`/host namespace 由策略提升且不可由 DTO 降级。
- images 支持 pull/build/remove，networks/volumes 支持 create/remove；prune、volume remove、批量 image remove 为 L3，必须显式资源 ID 列表。
- Compose 在 approve 前运行 `docker compose config`，保存 normalized config、env **键/SecretRef**、各服务 image repo digest、运行服务集、project name 和 health policy；返回 Diff 和 SnapshotRef。
- apply/rollback 都由同一 OperationGateway 提交。health fail 时按旧 digest 恢复 config 与服务集并再次 health；恢复失败进入 RollbackFailed，不能只恢复 YAML 或宣称成功。

- [ ] **Step 4: 运行真实 Docker 写入/回滚 fixture**

Run: `bash tests/integration/run-docker-write.sh && pnpm verify:static`  
Expected: restart、受控 Exec、Compose update 成功；config/image/service-set 三类变化在 health failure 后均恢复；所有 audit 可反查 ToolCall/Approval/Snapshot/Task。

- [ ] **Step 5: 提交任务**

```bash
git add package.json crates/remote-adapters crates/persistence/migrations/0009_docker_stacks.sql packages/contracts/src/docker.ts src-tauri/src/commands/docker.rs tests/integration/Cargo.toml tests/integration/docker tests/integration/run-docker-write.sh
git commit -m "feat: 完成 Docker 与 Compose 写操作闭环"
```

### Task 7: 实现 Nginx 发现、安全变更与恢复

**Files:**
- Modify: `package.json`
- Create: `crates/remote-adapters/src/nginx.rs`
- Create: `crates/remote-adapters/tests/nginx_plan.rs`
- Create: `crates/persistence/migrations/0010_nginx_sites.sql`
- Create: `packages/contracts/src/nginx.ts`
- Create: `src-tauri/src/commands/nginx.rs`
- Create: `tests/fixtures/nginx/Dockerfile`
- Create: `tests/integration/nginx/nginx_flow.rs`
- Create: `tests/integration/run-nginx.sh`
- Modify: `tests/integration/Cargo.toml`
- Create: `docs/security/nginx-change-protocol.md`

**Interfaces:**
- Consumes: SFTP、RemoteExecutor、OperationGateway、TaskEngine、Snapshotter、ApprovalRepository、健康检查器。
- Produces: L0 `nginx.discover/nginx.read` 与写入 `nginx.apply/nginx.rollback` ToolExecutor；不注册直达 apply/rollback command。

- [ ] **Step 1: 写语法失败零覆盖测试**

```rust
#[tokio::test]
async fn invalid_candidate_never_replaces_live_config() {
    let fixture = NginxFixture::running("server { listen 80; }");
    let before = fixture.live_bytes();
    let result = fixture.adapter().apply(candidate("server { invalid; }")).await;
    assert_eq!(result.unwrap_err().code(), CoreErrorCode::RemoteCommand);
    assert_eq!(fixture.live_bytes(), before);
    assert!(fixture.reloads().is_empty());
}
```

覆盖 reload 成功但 health 失败时恢复并再次 reload。

- [ ] **Step 2: 运行测试并确认 protocol 缺失**

Run: `cargo test -p opspilot-remote-adapters nginx`  
Expected: FAIL，因 NginxAdapter 未定义。

- [ ] **Step 3: 实现发现与双模式编辑**

- 通过 `nginx -V`、`nginx -T` 与发行版路径探测 binary/prefix/config/include；解析失败保留源码模式，不伪造结构化字段。
- 结构化表单只覆盖 server_name、listen、root、proxy_pass、WebSocket、基础缓存、上传限制、HTTP→HTTPS 和常用安全头。
- 含 Lua/OpenResty、动态 include 或未知 directive 的站点强制源码模式，仍可 Diff/validate/apply。

- [ ] **Step 4: 实现固定安全写协议**

1. 读取 live bytes、owner、mode、include graph 并创建强制 snapshot。
2. 在同目录写 `.opspilot-<taskId>.tmp`，保持 owner/mode。
3. 返回 unified Diff 并把 PreparedOperation/Approval Pending 持久化；应用重启后按 toolCallId 恢复同一 Diff/digest，不能重新 plan。只有 args_digest 相同的 ApprovalProof 才能继续。
4. 运行目标 binary 的 `-t -c <main-config>`。
5. 同文件系统原子 rename；执行 `nginx -s reload` 或已探测 systemd reload。
6. 检查 master/worker 与 URL health；失败则恢复 snapshot、再次 reload、记录 rollback。

- [ ] **Step 5: 运行真实 Nginx 故障矩阵**

Run: `bash tests/integration/run-nginx.sh && pnpm verify:static`  
Expected: valid change 成功；syntax、permission、reload、health 四个失败点均不留下半应用配置；审计关联 snapshot 和 Diff digest。

- [ ] **Step 6: 提交任务**

```bash
git add package.json crates/remote-adapters crates/persistence/migrations/0010_nginx_sites.sql packages/contracts/src/nginx.ts src-tauri/src/commands/nginx.rs tests/fixtures/nginx tests/integration/Cargo.toml tests/integration/nginx tests/integration/run-nginx.sh docs/security/nginx-change-protocol.md
git commit -m "feat: 实现可验证 Nginx 安全变更"
```

## 完成检查

- [ ] Task 状态、事件、数据库和 TS contract 完全一致。
- [ ] 所有用户参数经单独校验与 POSIX round-trip 属性测试。
- [ ] L3 缺少快照时 Rust 直接拒绝，调用方无法关闭该规则。
- [ ] 所有运维写 executor 只能由 OperationGateway 获得；直接调用、改 digest、改 environment/scope 均零执行。
- [ ] Cooperative/StopAfterCurrentStep/NotCancelable 三类取消语义均有远端状态证据，关闭 channel 不等于取消成功。
- [ ] Release 部署在 build/restart/health 失败时均恢复旧版本。
- [ ] Compose 在 config/image digest/service set 任一变化后均有可验证回滚。
- [ ] Docker daemon 未暴露公网，API 不可用时 CLI 回退可解释。
- [ ] Nginx syntax/reload/health 任一失败均通过真实 fixture 验证恢复。
