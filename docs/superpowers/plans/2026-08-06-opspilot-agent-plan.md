# OpsPilot Mastra Agent 与审批闭环实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付随桌面应用运行的本地 Mastra Sidecar、供应商无关模型配置、Rust 目录驱动的读写工具、结构化计划、分级审批、持久化 Workflow、崩溃恢复和可解释降级。

**Architecture:** Rust 启动受控 Node 24 Sidecar runtime，双方在私有 stdin/stdout 上使用有大小限制的 JSONL 双向协议；启动时以一次性 challenge 和 session token 完成握手。Mastra 负责推理与 Workflow 编排，任何工具请求都由 Rust 重新校验 schema、server scope、RiskDecision、审批、快照和任务状态。

**Tech Stack:** Mastra、`@mastra/libsql`、TypeScript、Zod、AI SDK OpenAI-compatible provider、Node.js 24 LTS runtime、Rollup chunked ESM、Rust/Tokio、Tauri shell plugin（仅 Rust 侧）、SQLite、Vitest、Rust integration tests。

## Global Constraints

- API Key 只通过 SecretStore 访问；不进入 Sidecar argv/env、SQLite、WebView、日志、trace 或测试 snapshot。
- Sidecar stdout 只允许协议帧，日志只写 stderr 且先脱敏；单帧最大 1 MiB。
- 本地 IPC 不监听 TCP/Unix 公共 socket；session token 不写命令行和环境变量，只通过已建立的 stdin 发送。
- Agent 只能发现 Rust 注册的工具；不能调用 Tauri shell、系统文件或任意 SSH 命令。
- Rust 计算并持久化风险；Mastra 的 approval/suspend 只表达暂停和恢复，不能代替安全决策。
- 默认只持久化 thread/run/tool/approval 的摘要和脱敏元数据，不保存完整模型请求响应。
- Sidecar 重启后先查询 Rust 中的 task/tool_call 状态，绝不自动重放写调用。
- Mastra Workflow snapshot 只持久化 ID、digest、状态和脱敏摘要；API Key、原始工具参数、秘密或完整远端输出不得进入 Sidecar storage。
- `run-agent.sh` 只有在文件创建并通过直接运行后，才可加入根 `test:integration:external` 聚合；对应 Task 同时修改并提交 `package.json`。
- 每个 Task 的行为测试通过后、提交前都必须再运行 `pnpm verify:static`；该根脚本统一执行 pnpm lint/typecheck 与 Cargo fmt/clippy，任一非零退出都阻断提交。

---

## 文件责任映射

| 路径 | 唯一责任 |
|---|---|
| `packages/contracts/src/agent-ipc.ts` | JSONL 帧、协议版本和 Zod 校验 |
| `apps/agent-runtime/src/ipc.ts` | Sidecar stdin/stdout transport |
| `apps/agent-runtime/src/runtime.ts` | Mastra 实例与 run 生命周期 |
| `apps/agent-runtime/src/storage.ts` | app-private LibSQL Workflow snapshot 与恢复 |
| `packages/model-providers` | Base URL/API Key/Model 到模型对象与错误映射 |
| `packages/agent-core` | Agent instructions、工具、上下文、Workflow |
| `crates/agent-bridge/src/sidecar.rs` | 进程、握手、心跳、重启与关闭 |
| `crates/agent-bridge/src/ipc.rs` | Rust 帧 codec、请求关联与限制 |
| `crates/agent-bridge/src/tools.rs` | Rust 工具目录、schema、server scope 和执行 |
| `crates/agent-bridge/src/approval.rs` | tool_call/digest/approval/snapshot 绑定 |
| `crates/persistence/src/agent_repository.rs` | Agent thread/run 摘要与恢复索引；ToolCall/Approval 复用 02 的共享 repository |

### Task 1: 打包 Sidecar runtime 并实现认证 JSONL IPC

**Files:**
- Create: `packages/contracts/src/agent-ipc.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/agent-ipc.test.ts`
- Create: `apps/agent-runtime/src/main.ts`
- Modify: `apps/agent-runtime/package.json`
- Create: `apps/agent-runtime/src/ipc.ts`
- Create: `apps/agent-runtime/src/storage.ts`
- Create: `apps/agent-runtime/rollup.config.mjs`
- Create: `apps/agent-runtime/tests/bundle-smoke.test.mjs`
- Create: `crates/agent-bridge/Cargo.toml`
- Create: `crates/agent-bridge/src/lib.rs`
- Create: `crates/agent-bridge/src/ipc.rs`
- Create: `crates/agent-bridge/src/sidecar.rs`
- Create: `crates/agent-bridge/tests/handshake.rs`
- Create: `scripts/prepare-agent-runtime.mjs`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/src/lib.rs`
- Modify: `Cargo.toml`

**Interfaces:**
- Consumes: 核心 Id/CoreError、Tauri AppHandle。
- Produces: `AgentSidecar::{start,request,shutdown,status}`；协议 `version=1`；与后续任务解耦的 `AgentEventEnvelope`。

```ts
export type AgentIpcFrame =
  | { version: 1; type: 'hello'; requestId: Id; sessionId: Id; challenge: string; sessionToken: string; storageUrl: string }
  | { version: 1; type: 'hello.ack'; requestId: Id; sessionId: Id; proof: string }
  | { version: 1; type: 'request'; requestId: Id; method: string; payload: unknown }
  | { version: 1; type: 'response'; requestId: Id; ok: true; payload: unknown }
  | { version: 1; type: 'response'; requestId: Id; ok: false; error: CoreError }
  | { version: 1; type: 'event'; event: AgentEventEnvelope }
  | { version: 1; type: 'heartbeat'; timestamp: string };

export interface AgentEventEnvelope {
  eventName: string;
  runId?: Id;
  sequence?: number;
  payload: unknown;
}
```

- [ ] **Step 1: 写 codec 和真实子进程握手失败测试**

```rust
#[tokio::test]
async fn rejects_child_that_cannot_prove_the_private_session_token() {
    let child = fixture_child("tests/fixtures/bad-sidecar.mjs");
    let result = AgentSidecar::spawn_with(child, fixed_token([7; 32])).await;
    assert_eq!(result.unwrap_err().code(), CoreErrorCode::SidecarUnavailable);
}
```

TS 测试用真实 stream parser 输入：一帧被拆成多 chunk、两帧合并、超过 1 MiB、未知版本、无 requestId；分别断言正确产出或拒绝。另写 bundle smoke：从打包目录启动真实 Node runtime，完成 handshake、初始化 LibSQL、列出空工具目录后退出，断言没有监听 TCP/Unix socket、没有 unresolved dynamic import。

- [ ] **Step 2: 运行测试并确认 codec/sidecar 缺失**

Run: `pnpm --filter @opspilot/contracts test --run src/agent-ipc.test.ts && cargo test -p opspilot-agent-bridge --test handshake`  
Expected: FAIL，因 schema、codec 与 AgentSidecar 未定义。

- [ ] **Step 3: 实现握手、请求关联和进程策略**

- Rust 生成 256-bit token 与 challenge，把含 `sessionToken` 的 hello 作为第一条 stdin 私有帧发送；`storageUrl` 由 Rust 解析到 app-private data 目录并创建权限受限的 `agent-workflows.db`。Sidecar 用 HMAC-SHA256(token, sessionId + challenge) 回复 proof，Rust 常量时间比较。
- token 不出现在 argv/env/日志；完成握手后双方丢弃原始 token，只保留会话派生 key。
- 每行 UTF-8 JSON，最大 1 MiB；协议 stdout 遇到非 JSON 立即隔离进程并返回 SIDECAR_UNAVAILABLE。
- request map 以 requestId 关联 oneshot，并按 method 设 deadline：hello 5 秒；catalog/read/operation prepare 30 秒；模型 run 使用 profile.timeoutMs（1-300 秒）作为“无 token/heartbeat 的 idle timeout”，每个有效流事件续期但仍受 30 分钟 absolute deadline；写 task 提交成功即返回 taskId，远端长任务不占用 IPC request；shutdown 2 秒后才 kill。
- 心跳 5 秒，连续 3 次缺失判定崩溃；一分钟最多重启 3 次，之后进入 degraded，不形成无限重启循环。

- [ ] **Step 4: 实现跨平台 Sidecar 打包**

不假设 Mastra 可被 esbuild 压成单一 CJS。Rollup 产出 `dist/` chunked ESM，并显式保留 Mastra/LibSQL 的动态模块与原生资源；`bundle-smoke.test.mjs` 必须在三个 target 的 CI 上从只读临时安装布局运行后，才允许写入 Tauri resources。若 bundle 含绝对构建路径、缺失动态 chunk/原生资源或启动监听 socket，本任务失败，不能以 external 全量 `node_modules` 规避。

首版不使用 Node SEA：CI 为每个 target 使用官方 Node 24 LTS 二进制并按 Tauri target triple 复制为 `src-tauri/binaries/opspilot-agent-node-$TARGET(.exe)`；完整 `dist/` 通过 `bundle.resources` 放入只读资源目录。Rust 用 `shell().sidecar("opspilot-agent-node")` 启动并把 ESM 入口路径作为唯一 argv；WebView capability 不授予 `shell:allow-spawn`。

必须覆盖 `aarch64-apple-darwin`、`x86_64-apple-darwin`、`x86_64-pc-windows-msvc`；下载 Node 归档后校验 Node 官方 SHA256 清单。

- [ ] **Step 5: 运行 codec、握手、超时和崩溃测试**

Run: `pnpm --filter @opspilot/contracts test --run && pnpm --filter @opspilot/agent-runtime test --run && cargo test -p opspilot-agent-bridge && pnpm verify:static`  
Expected: PASS；bundle smoke、坏 proof、超长帧、污染 stdout、各类 deadline、EOF 均返回稳定结果且无 token/storage 内容输出。

- [ ] **Step 6: 提交任务**

```bash
git add packages/contracts apps/agent-runtime crates/agent-bridge scripts/prepare-agent-runtime.mjs src-tauri Cargo.toml Cargo.lock
git commit -m "feat: 建立认证 Agent Sidecar 通道"
```

### Task 2: 实现模型 Profile、SecretRef 与连通性测试

**Files:**
- Create: `packages/model-providers/package.json`
- Create: `packages/model-providers/src/profile.ts`
- Create: `packages/model-providers/src/openai-compatible.ts`
- Create: `packages/model-providers/src/errors.ts`
- Create: `packages/model-providers/src/provider.test.ts`
- Create: `crates/persistence/src/model_profile_repository.rs`
- Create: `crates/persistence/migrations/0011_model_profiles.sql`
- Create: `src-tauri/src/commands/model.rs`
- Create: `packages/contracts/src/model.ts`
- Create: `tests/integration/model/mock-provider.ts`

**Interfaces:**
- Consumes: SecretStore、Sidecar IPC、Database。
- Produces: `model_profile_list/save/delete/test_connection/set_default`；`ModelProviderFactory::create(profile, apiKey)`。

```ts
export interface ModelProfileInput {
  id?: Id; name: string; provider: 'openai-compatible';
  baseUrl: string; model: string; timeoutMs: number; apiKey?: string;
}
export interface ModelProfileSummary extends Omit<ModelProfileInput, 'apiKey'> {
  id: Id; hasApiKey: boolean; isDefault: boolean;
}
```

- [ ] **Step 1: 写 URL、安全和错误映射失败测试**

```ts
it.each([
  ['https://models.example.com/v1', true],
  ['http://127.0.0.1:11434/v1', true],
  ['http://models.example.com/v1', false],
  ['file:///tmp/model', false],
])('validates model endpoint %s', (baseUrl, accepted) => {
  expect(ModelProfileSchema.safeParse(validProfile({ baseUrl })).success).toBe(accepted);
});
```

使用真实本地 HTTP mock provider 返回 401、429、500、慢响应和一 token 成功响应；断言稳定错误码，不断言 mock 调用次数。

- [ ] **Step 2: 运行测试并确认 provider 缺失**

Run: `pnpm --filter @opspilot/model-providers test --run`  
Expected: FAIL，因 Profile schema/factory 未定义。

- [ ] **Step 3: 实现 Profile 与最小连通性请求**

- 非 loopback Base URL 强制 HTTPS；拒绝 embedded credentials、fragment 和非 http(s) scheme。
- save 时 API Key 立即写 SecretStore，SQLite 只写 `api_key_secret_ref`；更新时未提供 apiKey 表示保留，显式 `clearApiKey=true` 才删除。
- test_connection 由 Rust 读取 secret 后仅通过私有 IPC 发给 Sidecar 的单次 request payload；Sidecar 不缓存 key，完成后释放引用。
- `agent.run` 走同一凭据边界：Rust 根据 run 选定的 profile 从 SecretStore 读取 API Key，以仅存活于 request 的 credential payload 发送给 Sidecar；Sidecar 为该 run 构造 provider/model 实例，run 终态或取消后清除引用。严禁只为 test_connection 注入 key。
- 连通性请求对已选 model 发送固定无敏感内容的最小生成，`maxOutputTokens=1`，不依赖 `/models` 必然存在。
- 映射 401→MODEL_UNAVAILABLE/invalid_credentials，429→rate_limited，timeout→TIMEOUT，5xx→retryable provider error；UI 收到的技术详情不含响应 header/body secret。

- [ ] **Step 4: 验证数据库/日志/WebView 零密钥**

保存 fixture key 后扫描 SQLite 文件、Rust tracing buffer、Sidecar stderr capture 和 Tauri event payload；任何命中都让测试失败。

Run: `pnpm --filter @opspilot/model-providers test --run && cargo test -p opspilot-persistence -p opspilot-agent-bridge model && pnpm verify:static`  
Expected: PASS。

- [ ] **Step 5: 提交任务**

```bash
git add packages/model-providers packages/contracts/src/model.ts crates/persistence src-tauri/src/commands/model.rs tests/integration/model
git commit -m "feat: 增加安全模型配置与连通性测试"
```

### Task 3: 注册 Rust 白名单工具与最小上下文脱敏

**Files:**
- Create: `crates/agent-bridge/src/tools.rs`
- Create: `crates/agent-bridge/src/context.rs`
- Create: `crates/agent-bridge/tests/tool_registry.rs`
- Create: `packages/agent-core/package.json`
- Create: `packages/agent-core/src/tools/core-tool.ts`
- Create: `packages/agent-core/src/tools/read-only.ts`
- Create: `packages/agent-core/src/context.ts`
- Create: `packages/agent-core/src/context.test.ts`
- Create: `packages/contracts/src/agent-tool.ts`
- Create: `crates/persistence/migrations/0012_agent_runs.sql`

**Interfaces:**
- Consumes: system/project/docker/nginx L0 adapter、Redactor、AuditWriter、Sidecar IPC。
- Produces: `ToolRegistry::describe/request`；Mastra `createTool` wrappers；首组 L0 工具。

```ts
export interface ToolRequest {
  toolCallId: Id; runId: Id; serverId: Id;
  name: string;
  schemaVersion: 1; args: unknown;
}
```

`name: string` 不表示开放任意工具：Sidecar 只能从 Rust 本次 handshake 返回的 catalog 创建 wrapper，Rust 再按 `(name, schemaVersion)` 查定义并重验 schema/scope；任何硬编码的“仅 6 个 L0”联合类型都会在后续写工具加入时漂移，因此禁止使用。

- [ ] **Step 1: 写跨服务器越权与脱敏失败测试**

```rust
#[tokio::test]
async fn rejects_tool_target_outside_the_run_scope() {
    let run = scoped_run(server_id("A"));
    let request = tool_request("server.overview", server_id("B"));
    let err = registry().request(run, request).await.unwrap_err();
    assert_eq!(err.code(), CoreErrorCode::ToolScopeViolation);
    assert_eq!(executed_operation_count(), 0);
}
```

TS 测试用完整服务器/log/config fixture，断言输出不含 host、username、Authorization、Cookie、env secret、私钥块，并保留 CPU/磁盘/服务名等任务所需数据。

- [ ] **Step 2: 运行测试并确认 registry/context 缺失**

Run: `cargo test -p opspilot-agent-bridge --test tool_registry && pnpm --filter @opspilot/agent-core test --run src/context.test.ts`  
Expected: FAIL，因 ToolRegistry/context policy 未定义。

- [ ] **Step 3: 实现工具目录与双重 schema 校验**

- Rust 是可执行工具目录源头，描述包含 name、version、description、input JSON Schema、固定/动态 risk policy。
- Sidecar 只为 Rust 描述的工具建立 Mastra `createTool` wrapper；输入先经 Zod，再由 Rust JSON Schema 和领域值对象重验。
- run scope 固定 serverId/projectId；tool request 不允许模型通过 args 改目标。任何 request/server/project 与 run scope 不一致都在风险/审批前返回 `TOOL_SCOPE_VIOLATION` 并零 executor 调用；`APPROVAL_MISMATCH` 只用于既有 approval 的 digest/确认目标不匹配。
- `server.overview/service.list/port.list/project.status/docker.list/nginx.read` 都是 L0，但仍写 tool_call 与 audit 摘要。
- 上下文策略按字段白名单组装，单次文本上限 64 KiB、单日志源 200 行；超出明确截断并记录 `truncated=true`。

- [ ] **Step 4: 用真实 L0 adapter 跑契约测试**

启动 SSH fixture，执行 `server.overview`，Sidecar 收到脱敏结构并返回摘要；测试最终 CPU/磁盘字段真实存在，审计只含摘要。

Run: `cargo test -p opspilot-agent-bridge tool && pnpm --filter @opspilot/agent-core test --run && pnpm verify:static`  
Expected: PASS；恶意日志中的提示词只能作为 data 字段，不能生成新工具权限。

- [ ] **Step 5: 提交任务**

```bash
git add crates/agent-bridge packages/agent-core packages/contracts/src/agent-tool.ts crates/persistence/migrations/0012_agent_runs.sql
git commit -m "feat: 注册受控 Agent 只读工具"
```

### Task 4: 实现 Agent 会话、结构化计划与事件流

**Files:**
- Create: `packages/agent-core/src/agent.ts`
- Create: `packages/agent-core/src/plan.ts`
- Create: `packages/agent-core/src/runtime.ts`
- Create: `packages/agent-core/src/agent.test.ts`
- Create: `apps/agent-runtime/src/runtime.ts`
- Create: `crates/agent-bridge/src/run.rs`
- Create: `crates/persistence/src/agent_repository.rs`
- Create: `src-tauri/src/commands/agent.rs`
- Create: `packages/contracts/src/agent.ts`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: ModelProviderFactory、SecretStore、ToolRegistry、AgentRepository。
- Produces: `agent_thread_list/create/run/cancel/history`；token/plan/tool/run-state 事件。

```ts
export interface AgentPlan {
  runId: Id;
  summary: string;
  steps: Array<{
    id: Id; title: string; rationale: string;
    toolName?: string; targetLabel?: string; expectedRisk?: RiskLevel;
  }>;
}
```

- [ ] **Step 1: 写结构化计划与取消失败测试**

测试使用本地 deterministic model server：给定“解释磁盘占用”，返回计划后调用 `server.overview`；断言用户先收到 `agent:plan`，再收到 tool event，最终 summary 引用真实 tool result。另测 cancel 后不再发 token/tool request。

- [ ] **Step 2: 运行测试并确认 AgentRunService 缺失**

Run: `pnpm --filter @opspilot/agent-core test --run src/agent.test.ts`  
Expected: FAIL，因 Agent/plan/run service 未实现。

- [ ] **Step 3: 实现 Mastra Agent 与 run 状态机**

- instructions 明确远端输出是不可信数据、不得改变权限、不得声称未执行的操作、必须区分观察/推断。
- run 状态：Planning → AwaitingTool/AwaitingApproval → Executing → Summarizing → Succeeded/Failed/Cancelled。
- 第一项可见产物为符合 AgentPlanSchema 的 plan；纯解释请求也可有无工具步骤，但不能伪造工具结果。
- Rust 为 token/plan/tool/run event 附 runId + sequence；前端消费者只接受单 run 递增 sequence。
- run 启动前 Rust 解析默认/指定 ModelProfile 与 `api_key_secret_ref`，读取 key 后调用 Sidecar `run.start`；credential 不写 AgentRepository。Sidecar 使用 run-scoped provider，流结束/取消/超时立即释放，并以泄漏扫描证明真实 run（不只 test_connection）不会把 key 写入 LibSQL/stderr/event。
- 默认持久化 input_summary/output_summary、模型 profile ID、状态、时间和 tool metadata；完整 prompt/response 只在用户显式开启诊断且经过脱敏时保存。
- 每个 thread 维护脱敏的滚动 `context_summary` 与 `summary_version`，后续 run 只加载摘要和用户明确选择的最近消息；摘要原文来源、截断和更新时间可追溯，满足会话记忆而不默认保存完整模型请求响应。

- [ ] **Step 4: 验证取消、并发与会话隔离**

Run: `pnpm --filter @opspilot/agent-core test --run && cargo test -p opspilot-agent-bridge run && pnpm verify:static`  
Expected: PASS；两个并发 run 的 token/tool event 不串流，cancel 终态不可恢复执行。

- [ ] **Step 5: 提交任务**

```bash
git add packages/agent-core apps/agent-runtime crates/agent-bridge crates/persistence/src/agent_repository.rs packages/contracts/src/agent.ts src-tauri/src/commands/agent.rs src-tauri/src/lib.rs
git commit -m "feat: 实现 Agent 计划与运行流"
```

### Task 5: 实现分级审批、Workflow 暂停恢复与快照绑定

**Files:**
- Create: `crates/agent-bridge/src/approval.rs`
- Create: `crates/agent-bridge/src/write_tools.rs`
- Create: `crates/agent-bridge/tests/approval.rs`
- Create: `packages/agent-core/src/workflows/approved-operation.ts`
- Create: `packages/agent-core/src/tools/write.ts`
- Create: `packages/agent-core/src/workflows/approved-operation.test.ts`
- Modify: `packages/contracts/src/approval.ts`

**Interfaces:**
- Consumes: 02/03 共享 OperationGateway、ApprovalRepository、RiskPolicy、TaskEngine、Snapshotter、ToolRegistry、Mastra storage/suspend/resume。
- Produces: Agent 对共享 `operation_pending/approve/reject` 的适配、完整写工具 catalog 与 L1-L3 Workflow；不创建第二套 Agent 专属审批表/command。

```ts
export interface ApprovalRequest {
  approvalId: Id; toolCallId: Id; runId: Id; serverId: Id;
  toolName: string; argsDigest: string; risk: RiskDecision;
  targetLabel: string; confirmationTarget?: string;
  impactSummary: string; expiresAt: string;
}
```

- [ ] **Step 1: 写拒绝零副作用与 digest 不匹配失败测试**

```rust
#[tokio::test]
async fn rejection_and_modified_args_never_execute() {
    let fixture = approval_fixture(RiskLevel::L2);
    let pending = fixture.request(write_tool("service.restart", args("nginx"))).await.unwrap();
    fixture.reject(pending.id).await.unwrap();
    assert_eq!(fixture.executions(), 0);

    let pending = fixture.request(write_tool("service.restart", args("nginx"))).await.unwrap();
    let err = fixture.approve_with_digest(pending.id, digest(args("sshd"))).await.unwrap_err();
    assert_eq!(err.code(), CoreErrorCode::ApprovalMismatch);
    assert_eq!(fixture.executions(), 0);
}
```

L3 测试省略 `confirmedResource`、输入本地化 `confirmationText` 而不是资源名、资源规范化后不等于 `confirmationTarget`，或缺少 snapshot 时必须拒绝。另写 approve/cancel 竞争测试：cancel 先提交时 approve 返回 CANCELLED 且零 task；approve 事务先提交时只产生一个 task，随后 run cancel 按 TaskEngine 的 cancel capability 处理，不能把已提交 task 隐藏成“未执行”。

- [ ] **Step 2: 运行测试并确认 approval gate 缺失**

Run: `cargo test -p opspilot-agent-bridge --test approval && pnpm --filter @opspilot/agent-core test --run src/workflows/approved-operation.test.ts`  
Expected: FAIL，因 gate/workflow 未实现。

- [ ] **Step 3: 实现 Rust 最终审批门**

- tool request 交给共享 OperationGateway；Gateway 已持久化 immutable name/server/args canonical JSON/digest/risk，Agent 审批只能引用该记录，agent-bridge 不复制 persistence 实现。
- L1/L2 需要 approve；L3 prepare 时 Gateway 从不可变目标同时写入 `targetLabel` 与 `confirmationTarget`，并由同一值生成只供展示的 `risk.confirmationText`。approve 只比较规范化后的 `confirmedResource == confirmationTarget`，绝不解析/比较本地化文案；目标或 digest 改变必须使原 approval 失效。L3 同时强制创建 snapshot 并保存 SnapshotRef；L4 立即拒绝。
- approval 15 分钟过期，决定幂等；重复 approve 返回已有 taskId，不二次执行。
- `approve_and_submit`、`agent.run.cancel` 与 approval 状态更新必须由共享数据库事务/每 toolCall 串行锁线性化；测试要覆盖 cancel-first 与 approve-first 两种确定结果，不允许出现 Approved 但无 task、Cancelled 后新建 task 或重复 task。
- UI/Agent 不能提交 risk 或 snapshotRequired 覆盖值；Rust 每次 approve 前重新计算并比较策略版本。
- 把 03 已实现的写 executor 注册进 Rust catalog，至少覆盖 `service.start/stop/restart`、`file.upload/delete/chmod/chown/archive/extract`、`project.deploy/rollback`、`docker.container.restart/remove/exec`、`docker.compose.apply/rollback`、`nginx.apply/rollback`。Sidecar 根据 catalog 动态创建 wrapper；L4 和未实现工具永不下发。

- [ ] **Step 4: 实现 Mastra suspend/resume**

Mastra 实例显式配置 `new LibSQLStore({ url: storageUrl })`；工具收到 `approval_required` 后调用 suspend，payload 只含 approvalId/toolCallId/runId/argsDigest/risk/脱敏摘要并落入 workflow snapshot。恢复时 Sidecar 以同一 workflow runId 从 LibSQL 加载 suspended step，不直接执行旧 args，而是通过 IPC 查询 Rust `approval/task status`：Approved+task result 才返回工具结果，Rejected/Expired/Cancelled 作为明确结果，Pending 继续 suspended。TaskEngine 的 Succeeded/Failed/Cancelled/Interrupted/RolledBack/RollbackFailed 均要转换为结构化 tool result 回馈同一 workflow；失败不得被 Agent 总结为成功，且只有用户发起新的 ToolCall 才能重试。

增加真实重启测试：Sidecar suspend 后杀进程、创建全新 Mastra 实例并复用数据库文件、按同一 runId 恢复；断言 snapshot 可读、执行次数仍为 0，批准后 TaskEngine 只执行一次。Workflow snapshot 中若出现 API Key、canonical args、完整日志或未脱敏输出，测试失败。

部署、Nginx、Docker 清理与 rollback 使用确定性 Workflow step；每个 step 复用 TaskEngine，不让模型生成实际命令。

- [ ] **Step 5: 验证 L0-L4 全矩阵**

Run: `cargo test -p opspilot-agent-bridge approval && pnpm --filter @opspilot/agent-core test --run && pnpm verify:static`  
Expected: L0 自动执行；L1/L2 等待；L3 要求 confirmationTarget 对应资源名+snapshot；L4 永不出现在 Agent tool catalog；拒绝/过期/改参执行次数均为 0；approve/cancel 两种竞争结果可线性化；TaskEngine 已知失败结构化回馈 workflow 并使 run 进入 Failed，只有无法判定远端状态时才标记 recoveryRequired，而不是伪成功。

- [ ] **Step 6: 提交任务**

```bash
git add crates/agent-bridge packages/agent-core packages/contracts/src/approval.ts
git commit -m "feat: 强制 Agent 分级审批与快照"
```

### Task 6: 实现崩溃恢复、降级和 Agent 安全回归

**Files:**
- Modify: `package.json`
- Create: `crates/agent-bridge/src/recovery.rs`
- Create: `crates/agent-bridge/tests/recovery.rs`
- Create: `packages/agent-core/src/errors.ts`
- Create: `packages/agent-core/src/security.test.ts`
- Create: `tests/integration/agent/agent_flow.rs`
- Create: `tests/integration/run-agent.sh`
- Modify: `tests/integration/Cargo.toml`
- Create: `tests/fixtures/agent/malicious-outputs.json`
- Create: `docs/security/agent-threat-model.md`
- Create: `docs/architecture/agent-degradation.md`

**Interfaces:**
- Consumes: Sidecar lifecycle、AgentRepository、OperationGateway、TaskEngine、ApprovalRepository。
- Produces: `AgentRecoveryService::recover`；用户可解释 degraded 状态；安全回归套件。

- [ ] **Step 1: 写重启不重放失败测试**

```rust
#[tokio::test]
async fn sidecar_restart_queries_existing_task_instead_of_replaying_write() {
    let fixture = running_write_then_crash_fixture().await;
    fixture.crash_sidecar_after_remote_apply().await;
    fixture.restart_and_recover().await.unwrap();
    assert_eq!(fixture.remote_apply_count(), 1);
    assert_eq!(fixture.recovered_result().status, TaskStatus::Succeeded);
    assert_eq!(serde_json::to_value(TaskStatus::Succeeded).unwrap(), "succeeded");
}
```

加入 model timeout、401、429、Sidecar crash loop、SSH 中断、TaskEngine executor failure、approve/cancel race、显式 `project.rollback/docker.compose.rollback/nginx.rollback`，以及恶意 prompt/config/log 夹带“忽略审批”的真实输入 fixture。

- [ ] **Step 2: 运行测试并确认 recovery 缺失**

Run: `cargo test -p opspilot-agent-bridge --test recovery && pnpm --filter @opspilot/agent-core test --run src/security.test.ts`  
Expected: FAIL，因恢复与安全策略未实现。

- [ ] **Step 3: 实现恢复与可解释降级**

- 启动时读取 Planning/Awaiting*/Executing/Summarizing run，并从 Mastra LibSQL 加载 workflow snapshot；对每个 toolCallId 查询共享 task/approval，生成 recovered event，不调用 execute。snapshot 缺失/损坏时把 run 标为 Failed/RecoveryRequired，仍禁止重放。
- Sidecar 不可用标记 `agentAvailable=false` 与 reason/retryAt；不影响 Rust command registry 的人工功能。
- 401 要求更新 key；429 显示 retryAfter；timeout 可手动 retry；crash loop 需要用户重启 Agent，不自动无限拉起。
- 取消 run 不取消已明确进入不可安全取消步骤的 task；UI 显示 task 独立状态。

- [ ] **Step 4: 跑提示词/工具/越权安全矩阵**

恶意远端文本必须只能进入 tool result data：不能新增 tool、切换 server、降低 risk、伪造 approval、泄漏 key。矩阵同时覆盖 rollback tool 仍经 L1-L3 prepare/approval/snapshot policy，不能因为名为 rollback 就直达 executor。测试断言最终可执行工具集合、真实执行次数、审计与外发 payload，而不是断言模型输出措辞。

- [ ] **Step 5: 运行 Agent 完整集成闭环**

`run-agent.sh` 启动 SSH fixture 与本地 deterministic/mock model provider、等待 health，执行 `cargo test -p opspilot-integration-tests --features external-fixtures --test agent_flow -- --ignored --test-threads=1`，并用 trap 清理；脚本不得读取生产 API Key。

Run: `bash tests/integration/run-agent.sh && cargo test -p opspilot-agent-bridge && pnpm --filter @opspilot/agent-core test --run && pnpm verify:static`  
Expected: 状态解释 L0、L2 approve/reject、L3 snapshot、三类 rollback、approve/cancel 两种竞争顺序、TaskEngine 执行失败回馈、模型故障、Sidecar crash/restart 全部 PASS；扫描日志/SQLite/event 无 fixture secrets。

- [ ] **Step 6: 提交任务**

```bash
git add package.json crates/agent-bridge packages/agent-core tests/integration/Cargo.toml tests/integration/agent tests/integration/run-agent.sh tests/fixtures/agent docs/security/agent-threat-model.md docs/architecture/agent-degradation.md
git commit -m "feat: 完成 Agent 恢复与安全降级"
```

## 完成检查

- [ ] Sidecar token 不出现在 argv/env/stdout/stderr/SQLite。
- [ ] macOS arm64/x64 与 Windows x64 均有目标 Node runtime 产物和 checksum 校验。
- [ ] Rust 与 Sidecar 对同一协议 fixture 均接受，对超长/未知版本均拒绝。
- [ ] L0 有审计；L1/L2 未批准零执行；L3 无快照零执行；L4 无工具。
- [ ] 文件/systemd/项目/Docker/Nginx 写工具均来自 Rust catalog，Agent 无第二套 executor/approval repository。
- [ ] project/docker-compose/nginx rollback 均在 Agent 集成矩阵中经过 Gateway，approve/cancel 竞争与 TaskEngine 失败回馈有确定终态和零重复执行证据。
- [ ] suspend 后杀死 Sidecar，新的进程可从 LibSQL snapshot 恢复且远端写执行次数仍为 1。
- [ ] 真实 agent.run 使用 SecretStore key 成功调用 mock provider，key 不进入 Sidecar storage/日志/事件。
- [ ] 恶意远端文本不能改变 tool catalog、server scope 或 risk。
- [ ] Sidecar crash 后同一写操作真实执行次数保持 1。
- [ ] Agent 不可用时人工 SSH、文件、Docker、Nginx 回归全部通过。
