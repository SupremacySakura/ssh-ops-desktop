# OpsPilot 基础设施与安全底座实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可重复构建的 Tauri/React/Rust monorepo，并交付共享契约、SQLite、系统凭据、审计脱敏和 macOS/Windows CI 基线。

**Architecture:** pnpm 管理桌面、Agent 与共享 TypeScript 包；Cargo workspace 管理 Tauri 和领域 crate。SQLite 只保存非敏感元数据，SecretStore 只保存系统凭据引用，前端通过最小 Tauri command/event 接口访问 Rust Core。

**Tech Stack:** Node.js 24 LTS、pnpm、React、Vite、Tauri 2、TypeScript、Vitest、Playwright（renderer）、WebdriverIO Tauri service（native）、Rust 1.97.1/Tokio、sqlx/SQLite、keyring、serde、thiserror、GitHub Actions。

## Global Constraints

- 本计划在绿色目录中执行：先初始化 Git，再创建 `feat/p0-foundation`，不得直接在 `main` 上开发。
- 使用 Node.js 24 LTS；提交 `pnpm-lock.yaml` 与 `Cargo.lock`。
- JavaScript 依赖必须使用与 lockfile 一致的精确版本，禁止在可提交清单中使用 `latest` 或 `*`。
- UI 产品名为 `OpsPilot`，包前缀为 `@opspilot/*`，Rust crate 前缀为 `opspilot-*`。
- SQLite 必须启用 WAL 和外键；秘密只能保存 `secret_ref`。
- WebView 不获得 shell/fs/http 通配权限；应用命令必须显式注册。
- 每个任务执行 RED → GREEN → REFACTOR，并在提交前运行受影响 workspace 的完整测试。

---

## 文件责任映射

| 路径 | 唯一责任 |
|---|---|
| `apps/desktop` | React 桌面 UI、路由和 Tauri 调用适配 |
| `apps/agent-runtime` | Mastra Sidecar 入口；本计划只建包边界 |
| `packages/contracts` | TS 端 DTO、Zod schema、事件名和 fixture |
| `packages/config` | 共享 ESLint/TypeScript/Vitest 配置 |
| `src-tauri` | Tauri 启动、Capability、command/event 注册 |
| `crates/domain` | Rust ID、领域枚举、错误与跨模块值对象 |
| `crates/persistence` | SQLite pool、migration 与 repository 实现 |
| `crates/secrets` | 系统凭据库与测试内存实现 |
| `crates/audit` | 字段级脱敏和 append-only 审计 |
| `tests/contract-fixtures` | TS/Rust 双向序列化样例 |
| `tests/e2e/renderer` | Chromium + fixture 的纯前端视觉/交互测试 |
| `tests/e2e/native` | WebdriverIO 驱动真实 Tauri binary 的原生壳测试 |

### Task 1: 初始化 monorepo、工具链与测试入口

**Files:**
- Create: `.gitignore`
- Create: `.editorconfig`
- Create: `.nvmrc`
- Create: `eslint.config.mjs`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `Cargo.toml`
- Create: `rust-toolchain.toml`
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/index.html`
- Create: `apps/desktop/vite.config.ts`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/tsconfig.app.json`
- Create: `apps/desktop/tsconfig.node.json`
- Create: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/src/main.tsx`
- Create: `apps/desktop/src/vite-env.d.ts`
- Create: `apps/agent-runtime/package.json`
- Create: `apps/agent-runtime/tsconfig.json`
- Create: `apps/agent-runtime/src/index.ts`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/config/package.json`
- Create: `packages/config/tsconfig.json`
- Create: `packages/config/src/index.ts`
- Create: `crates/domain/Cargo.toml`
- Create: `crates/domain/src/lib.rs`
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/src/lib.rs`
- Create: `src-tauri/tauri.conf.json`
- Create: `tests/smoke/workspace.test.mjs`
- Create: `tests/integration/vitest.config.ts`

**Interfaces:**
- Consumes: 空工作区中的 `docs/` 设计与计划文件。
- Produces: `pnpm lint|typecheck|test`、`cargo test --workspace` 和后续计划使用的目录边界。

- [ ] **Step 1: 初始化 Git 和隔离分支**

```bash
git init -b main
git switch -c feat/p0-foundation
```

- [ ] **Step 2: 写 workspace 失败测试**

```js
// tests/smoke/workspace.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function json(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('package managers discover every runnable workspace', () => {
  const pnpm = json('pnpm', ['--recursive', 'list', '--depth', '-1', '--json']);
  const packageNames = new Set(pnpm.map(({ name }) => name));
  assert.deepEqual(packageNames, new Set([
    '@opspilot/desktop', '@opspilot/agent-runtime',
    '@opspilot/contracts', '@opspilot/config'
  ]));

  const cargo = json('cargo', ['metadata', '--no-deps', '--format-version', '1']);
  assert.ok(cargo.packages.some(({ name }) => name === 'opspilot-domain'));
  assert.ok(cargo.packages.some(({ name }) => name === 'opspilot-desktop'));
});
```

- [ ] **Step 3: 运行测试并确认正确失败**

Run: `corepack enable && node --test tests/smoke/workspace.test.mjs`  
Expected: FAIL，pnpm/Cargo 无法发现尚未创建的 workspace，不是测试语法错误。

- [ ] **Step 4: 创建最小 workspace 清单**

```json
// package.json
{
  "name": "ssh-ops-desktop",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.15.0",
  "engines": { "node": ">=24 <25" },
  "scripts": {
    "dev": "pnpm --filter @opspilot/desktop dev",
    "tauri": "tauri",
    "lint": "eslint . --max-warnings 0",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm test:packages && pnpm test:smoke",
    "test:packages": "pnpm -r test",
    "test:smoke": "node --test tests/smoke/workspace.test.mjs",
    "verify:static": "pnpm lint && pnpm typecheck && cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings",
    "test:integration": "vitest run --config tests/integration/vitest.config.ts"
  },
  "devDependencies": {
    "@eslint/js": "10.0.1",
    "@tauri-apps/cli": "2.11.4",
    "eslint": "10.8.0",
    "globals": "17.9.0",
    "typescript": "6.0.3",
    "typescript-eslint": "8.66.0",
    "vitest": "4.1.10"
  }
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - apps/*
  - packages/*
```

```toml
# Cargo.toml
[workspace]
resolver = "2"
members = ["src-tauri", "crates/*"]

[workspace.package]
edition = "2024"
license = "UNLICENSED"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"
tokio = { version = "1", features = ["macros", "rt-multi-thread", "sync", "time"] }
uuid = { version = "1", features = ["v4", "serde"] }
```

```toml
# rust-toolchain.toml
[toolchain]
channel = "1.97.1"
profile = "minimal"
components = ["rustfmt", "clippy"]
targets = ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc"]
```

不运行交互式 `pnpm tauri init`。直接创建清单并固定：Cargo package=`opspilot-desktop`、lib=`opspilot_desktop_lib`、Tauri `productName="OpsPilot"`、`identifier="com.opspilot.desktop"`、`frontendDist="../apps/desktop/dist"`、`devUrl="http://localhost:1420"`；workspace smoke test必须核对这些值。React/Vite 基线启用 `@vitejs/plugin-react`，由本任务列出的文件直接创建，禁止执行会等待人工输入的 initializer。为其余 workspace 创建最小源码与真实可运行的 ESLint、TypeScript、Vitest 入口；禁止用解析 `package.json` 或 `tsc --version` 冒充检查。根 `pnpm test` 必须同时运行 package tests 与 workspace smoke。只公布本任务已经存在且可执行的脚本；`contracts:check`、external integration 与 e2e 入口由实际创建对应文件的后续任务再加入。`tests/integration/vitest.config.ts` 在尚无集成用例时启用 `passWithNoTests`，后续计划添加首个用例时删除该选项。不要删除现有 `docs/`。

- [ ] **Step 5: 安装依赖并运行双栈基线**

Run: `corepack enable && pnpm install && pnpm test && pnpm lint && pnpm typecheck && pnpm --filter @opspilot/desktop build && cargo test --workspace`  
Expected: 全部 PASS；Vite 从 `index.html` 构建出 desktop dist，生成并提交两个 lockfile。

- [ ] **Step 6: 提交任务**

```bash
git add .gitignore .editorconfig .nvmrc eslint.config.mjs package.json pnpm-workspace.yaml pnpm-lock.yaml Cargo.toml Cargo.lock rust-toolchain.toml apps packages src-tauri crates tests/smoke tests/integration/vitest.config.ts
git commit -m "chore: 初始化 OpsPilot 工作区"
```

### Task 2: 固化 TypeScript/Rust 共享契约

**Files:**
- Modify: `package.json`
- Create: `packages/contracts/src/ids.ts`
- Create: `packages/contracts/src/errors.ts`
- Create: `packages/contracts/src/events.ts`
- Create: `packages/contracts/src/risk.ts`
- Create: `packages/contracts/src/task.ts`
- Create: `packages/contracts/src/tool.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/contracts.test.ts`
- Modify: `crates/domain/src/lib.rs`
- Create: `crates/domain/src/id.rs`
- Create: `crates/domain/src/error.rs`
- Create: `crates/domain/src/risk.rs`
- Create: `crates/domain/tests/contract_fixtures.rs`
- Create: `tests/contract-fixtures/core-error.json`
- Create: `tests/contract-fixtures/tool-scope-violation.json`
- Create: `tests/contract-fixtures/risk-decision.json`
- Create: `tests/contract-fixtures/task-status.json`
- Create: `tests/contract-fixtures/tool-call.json`

**Interfaces:**
- Consumes: workspace 测试入口。
- Produces: `Id`、`CoreErrorCode`、`RiskLevel`、`RiskDecision`、完整 `TaskStatus`、`ToolCall`、稳定事件名；所有后续计划只能复用这些类型。

- [ ] **Step 1: 写 TS 契约失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { CoreErrorSchema, RiskDecisionSchema } from './index';

describe('cross-runtime contracts', () => {
  it('rejects an approval decision without a reason', () => {
    const parsed = RiskDecisionSchema.safeParse({
      level: 'L2', approvalRequired: true, snapshotRequired: false
    });
    expect(parsed.success).toBe(false);
  });

  it('serializes a stable connection error', () => {
    expect(CoreErrorSchema.parse({ code: 'SSH_HOST_KEY_CHANGED', message: 'blocked', retryable: false }))
      .toEqual({ code: 'SSH_HOST_KEY_CHANGED', message: 'blocked', retryable: false });
  });
});
```

- [ ] **Step 2: 运行 TS 测试并确认导出缺失**

Run: `pnpm --filter @opspilot/contracts test --run`  
Expected: FAIL，提示 `CoreErrorSchema`/`RiskDecisionSchema` 未导出。

- [ ] **Step 3: 实现最小 Zod 契约**

```ts
export const RiskLevelSchema = z.enum(['L0', 'L1', 'L2', 'L3', 'L4']);
export const RiskDecisionSchema = z.object({
  level: RiskLevelSchema,
  approvalRequired: z.boolean(),
  snapshotRequired: z.boolean(),
  confirmationText: z.string().min(1).optional(),
  reason: z.string().min(1),
});

export const CoreErrorCodeSchema = z.enum([
  'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'CANCELLED', 'TIMEOUT', 'CAPABILITY_UNAVAILABLE',
  'SECRET_UNAVAILABLE', 'SSH_CONNECTION', 'SSH_AUTHENTICATION',
  'SSH_HOST_KEY_UNKNOWN', 'SSH_HOST_KEY_CHANGED', 'REMOTE_PERMISSION',
  'REMOTE_COMMAND', 'REMOTE_PARSE', 'APPROVAL_REQUIRED',
  'APPROVAL_MISMATCH', 'TOOL_SCOPE_VIOLATION',
  'MODEL_UNAVAILABLE', 'SIDECAR_UNAVAILABLE', 'INTERNAL'
]);

export const TaskStatusSchema = z.enum([
  'pending', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted',
  'rolling_back', 'rolled_back', 'rollback_failed'
]);

export const ToolCallSchema = z.object({
  toolCallId: IdSchema,
  runId: IdSchema,
  serverId: IdSchema,
  name: z.string().regex(/^[a-z][a-z0-9_.-]+$/),
  schemaVersion: z.literal(1),
  args: z.unknown(),
});
```

事件常量只能从 `events.ts` 导出：`connection:state`、`terminal:data`、`task:progress`、`task:log`、`metrics:update`、`docker:stats`、`agent:token`、`agent:plan`、`agent:tool_request`、`agent:approval_required`、`agent:run_state`。

- [ ] **Step 4: 写 Rust fixture 失败测试**

```rust
#[test]
fn rust_types_read_typescript_fixtures() {
    let risk: RiskDecision = serde_json::from_str(include_str!(
        "../../../tests/contract-fixtures/risk-decision.json"
    )).unwrap();
    assert_eq!(risk.level, RiskLevel::L2);
    assert!(risk.approval_required);
}
```

Run: `cargo test -p opspilot-domain --test contract_fixtures`  
Expected: FAIL，因 `RiskDecision`/`RiskLevel` 尚未定义。

- [ ] **Step 5: 实现 Rust 对等类型并双向核对**

Rust 使用 `#[serde(rename_all = "SCREAMING_SNAKE_CASE")]` 表示错误码，风险级别显式命名 `L0..L4`，字段使用 `#[serde(rename_all = "camelCase")]`；`TaskStatus` 必须使用 `#[serde(rename_all = "snake_case")]`，确保 `Succeeded/RollingBack/RolledBack/RollbackFailed` 分别序列化为固化的小写值。增加测试把 Rust 值序列化后与全部 fixture 的 `serde_json::Value` 相等比较，并逐个反序列化全部 9 个状态；`tool-scope-violation.json` 必须在 TS/Rust 两端稳定解析为 `TOOL_SCOPE_VIOLATION`，不得复用 `APPROVAL_MISMATCH`。

先在根 `package.json` 增加 `contracts:check`，仅在 TS 测试与 Rust `contract_fixtures` target 均已创建后公开该入口：`pnpm --filter @opspilot/contracts test --run && cargo test -p opspilot-domain --test contract_fixtures`。

Run: `pnpm contracts:check`  
Expected: 全部 PASS。

- [ ] **Step 6: 提交任务**

```bash
git add package.json packages/contracts crates/domain tests/contract-fixtures
git commit -m "feat: 定义跨运行时核心契约"
```

### Task 3: 建立 SQLite migration 与 repository 基线

**Files:**
- Create: `crates/persistence/Cargo.toml`
- Create: `crates/persistence/src/lib.rs`
- Create: `crates/persistence/src/database.rs`
- Create: `crates/persistence/migrations/0001_core.sql`
- Create: `crates/persistence/tests/database.rs`
- Modify: `Cargo.toml`

**Interfaces:**
- Consumes: `opspilot-domain::Id` 和 `CoreError`。
- Produces: `Database::open(path) -> Result<Database, CoreError>`、`Database::pool()`；后续 repository 共享同一个 pool。

- [ ] **Step 1: 写数据库策略失败测试**

```rust
#[tokio::test]
async fn enables_wal_foreign_keys_and_core_tables() {
    let db = Database::open_in_memory().await.unwrap();
    let journal: String = sqlx::query_scalar("PRAGMA journal_mode").fetch_one(db.pool()).await.unwrap();
    let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys").fetch_one(db.pool()).await.unwrap();
    assert_eq!(journal.to_lowercase(), "memory"); // in-memory SQLite cannot use WAL
    assert_eq!(foreign_keys, 1);
    let tables: Vec<String> = sqlx::query_scalar(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).fetch_all(db.pool()).await.unwrap();
    assert!(tables.contains(&"servers".into()));
    assert!(tables.contains(&"audit_logs".into()));
}
```

另写文件数据库测试断言 `journal_mode=wal`，并写外键删除失败测试。

- [ ] **Step 2: 运行测试并确认 Database 缺失**

Run: `cargo test -p opspilot-persistence --test database`  
Expected: FAIL，因 `Database` 未定义。

- [ ] **Step 3: 编写核心 migration**

`0001_core.sql` 必须创建 `server_groups`、`servers`、`tags`、`server_tags`、`app_settings`、`audit_logs`；`servers.secret_ref` 可空但不能存秘密值，`server_tags` 使用联合主键与级联删除，时间统一存 UTC RFC3339 字符串。

```sql
CREATE TABLE servers (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  host TEXT NOT NULL CHECK(length(trim(host)) > 0),
  port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
  username TEXT NOT NULL,
  auth_type TEXT NOT NULL CHECK(auth_type IN ('password','private_key','ssh_agent','certificate')),
  secret_ref TEXT,
  group_id TEXT REFERENCES server_groups(id) ON DELETE SET NULL,
  jump_host_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
  host_key_fingerprint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_connected_at TEXT
);
```

`audit_logs` 的 append-only 不能只依赖 repository API；migration 同时创建阻断 UPDATE/DELETE 的触发器：

```sql
CREATE TRIGGER audit_logs_no_update
BEFORE UPDATE ON audit_logs BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;
CREATE TRIGGER audit_logs_no_delete
BEFORE DELETE ON audit_logs BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;
```

- [ ] **Step 4: 实现连接、PRAGMA 和 migration**

文件数据库连接建立时执行 `foreign_keys=ON`、`journal_mode=WAL`、`busy_timeout=5000`；使用 `sqlx::migrate!()`。`open_in_memory()` 使用单连接 pool，避免多个独立内存库。

- [ ] **Step 5: 验证迁移、外键与 append-only 保护**

Run: `cargo test -p opspilot-persistence && cargo test --workspace`  
Expected: 全部 PASS；直接 SQL `UPDATE audit_logs` 与 `DELETE FROM audit_logs` 均因触发器失败且原记录保留；文件数据库测试清理临时目录；无依赖外部服务的 ignored test。

- [ ] **Step 6: 提交任务**

```bash
git add Cargo.toml Cargo.lock crates/persistence
git commit -m "feat: 建立 SQLite 持久化底座"
```

### Task 4: 建立系统凭据、脱敏与审计边界

**Files:**
- Create: `crates/secrets/Cargo.toml`
- Create: `crates/secrets/src/lib.rs`
- Create: `crates/secrets/src/keyring_store.rs`
- Create: `crates/secrets/src/memory_store.rs`
- Create: `crates/audit/Cargo.toml`
- Create: `crates/audit/src/lib.rs`
- Create: `crates/audit/src/redactor.rs`
- Create: `crates/audit/tests/redaction.rs`
- Create: `crates/persistence/migrations/0002_secret_refs.sql`
- Modify: `Cargo.toml`

**Interfaces:**
- Consumes: `Id`、`CoreError`、`Database`。
- Produces: `SecretStore`、`SecretKind`、`Redactor`、`AuditWriter::append(AuditEvent)`。

```rust
#[async_trait::async_trait]
pub trait SecretStore: Send + Sync {
    async fn put(&self, kind: SecretKind, owner_id: Id, value: SecretValue)
        -> Result<SecretRef, CoreError>;
    async fn get(&self, secret_ref: &SecretRef) -> Result<SecretValue, CoreError>;
    async fn delete(&self, secret_ref: &SecretRef) -> Result<(), CoreError>;
}
```

- [ ] **Step 1: 写秘密泄漏失败测试**

```rust
#[tokio::test]
async fn audit_never_persists_registered_secrets() {
    let redactor = Redactor::new(["p@ssw0rd", "sk-live-123"]);
    let value = serde_json::json!({
      "password": "p@ssw0rd", "authorization": "Bearer sk-live-123", "safe": "nginx"
    });
    assert_eq!(redactor.json(value), serde_json::json!({
      "password": "[REDACTED]", "authorization": "[REDACTED]", "safe": "nginx"
    }));
}
```

再写测试：SQLite 全库文本不包含原始秘密；`SecretValue` Debug 固定输出 `[REDACTED]`。

- [ ] **Step 2: 运行测试并确认 Redactor 缺失**

Run: `cargo test -p opspilot-audit --test redaction`  
Expected: FAIL，因 `Redactor` 尚未定义。

- [ ] **Step 3: 实现秘密与脱敏最小闭环**

- `KeyringSecretStore` 的 service 名固定 `com.opspilot.desktop`，account 使用不可猜测的 `secret_ref`。
- `MemorySecretStore` 只用于测试，使用 `zeroize::Zeroizing<String>`。
- `0002_secret_refs.sql` 创建只含引用元数据的 `secret_refs(ref PRIMARY KEY, kind, owner_type, owner_id, created_at, updated_at)`，`kind` 限定为 password/private_key/passphrase/model_api_key/certificate，`(owner_type, owner_id, kind)` 唯一；表中禁止 value、account、path 或 credential metadata。先把已有非空 `servers.secret_ref` 以 owner_type=`server`、owner_id=`servers.id`、按 auth_type 映射的 kind 回填引用行，再以 copy/rename 方式重建 `servers`，让 `servers.secret_ref` 成为 `REFERENCES secret_refs(ref) ON DELETE RESTRICT`，保留 0001 数据并用 `PRAGMA foreign_key_check` 验证；后续领域表同样只以外键保存不透明 `ref`。删除 owner 时由显式 SecretStore 清理流程先删系统凭据、再删引用行；migration 不能级联删除外部系统凭据。
- 字段名大小写不敏感匹配 `password|passphrase|token|cookie|authorization|api_key|private_key|secret|env|environment_variables|environmentVariables`。其中 `env`/`environment_variables` 只表示“环境变量映射”：保留变量键名、全部值脱敏；`environment: 'production'|'staging'|...` 这类部署环境标签不是秘密，不得整字段误删。
- 注册的秘密值按最长优先替换，避免短 token 破坏长 token；字符串、JSON、错误链都经过同一 Redactor。
- 审计只写 `action/resource/server/result/redacted_payload/created_at`，不接受原始 `SecretValue` 类型。

- [ ] **Step 4: 验证系统实现与内存替身契约一致**

为两个实现运行同一组 trait contract tests；系统 keyring 测试标记为平台集成测试并使用随机 account，结束后删除测试项。

Run: `cargo test -p opspilot-secrets -p opspilot-audit -p opspilot-persistence`  
Expected: 全部 PASS，测试日志中无 fixture 秘密。

- [ ] **Step 5: 提交任务**

```bash
git add Cargo.toml Cargo.lock crates/secrets crates/audit crates/persistence/migrations/0002_secret_refs.sql
git commit -m "feat: 隔离凭据并建立审计脱敏"
```

### Task 5: 接通最小 Tauri 壳并建立双平台 CI

**Files:**
- Modify: `package.json`
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/commands/health.rs`
- Create: `src-tauri/src/commands/mod.rs`
- Create: `src-tauri/capabilities/main.json`
- Modify: `src-tauri/tauri.conf.json`
- Create: `apps/desktop/src/api/core.ts`
- Create: `apps/desktop/src/App.test.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Create: `.github/workflows/ci.yml`
- Create: `docs/architecture/security-boundaries.md`
- Create: `playwright.config.ts`
- Create: `tests/e2e/renderer/app-shell.spec.ts`
- Create: `tests/e2e/native/wdio.conf.ts`
- Create: `tests/e2e/native/app-shell.e2e.ts`

**Interfaces:**
- Consumes: `Database`、`SecretStore` 和核心契约。
- Produces: `core.health() -> { version, databaseReady, secretStoreReady }`；后续 UI 的统一 invoke 包装器。

- [ ] **Step 1: 写前端健康状态失败测试**

```tsx
it('shows explicit readiness returned through the CoreClient boundary', async () => {
  const core = fixtureCoreClient({
    health: { version: '0.1.0', databaseReady: true, secretStoreReady: true }
  });
  render(<App core={core} />);
  expect(await screen.findByText('Core 已就绪')).toBeVisible();
  expect(screen.getByText('版本 0.1.0')).toBeVisible();
});
```

- [ ] **Step 2: 运行测试并确认命令适配器缺失**

Run: `pnpm --filter @opspilot/desktop test --run src/App.test.tsx`  
Expected: FAIL，页面没有 `Core 已就绪` 或 `core_health` 未调用。

- [ ] **Step 3: 实现最小命令与 Capability**

Rust command 只返回 readiness，不返回路径、环境变量或密钥状态详情。`main.json` 只包含主窗口所需 `core:event:default`、`core:window:default`；不添加 `shell:*`、`fs:*` 或远程 URL capability。所有应用命令在 `build.rs` 的 manifest 和 `invoke_handler` 中显式列出。

- [ ] **Step 4: 创建 renderer/native 两层桌面测试**

- Playwright 只启动 Vite + fixture client，验证 AppShell renderer；文件名、报告标题都带 `renderer`，不得声称驱动 Tauri、Rust、SSH 或系统 WebView。
- WebdriverIO 使用 `@wdio/tauri-service` 的 `driverProvider: 'embedded'` 驱动 `pnpm tauri build --debug` 产出的真实 binary，测试 `core_health` IPC、窗口启动/关闭与数据库 readiness。
- `tauri-plugin-wdio-webdriver`/`tauri-plugin-wdio` 只在 `debug_assertions` 下编译和注册；release binary/capability 扫描必须证明不存在测试 driver 入口。
- 本任务在根清单中以精确版本加入 Playwright/WebdriverIO 依赖，并在对应配置与测试文件创建后增加 `test:e2e:renderer`、`test:e2e:native` 和兼容聚合别名 `test:e2e`；禁止提前暴露不可执行入口。

- [ ] **Step 5: 创建双平台 CI**

CI 使用 `macos-14` 与 `windows-2025` 矩阵、Node 24、Corepack、`rust-toolchain.toml` 固定的 Rust 1.97.1；步骤顺序固定为 install → format/lint → typecheck → contracts check → TS tests → Rust tests → clippy → renderer E2E → `pnpm tauri build --debug` → native E2E。缓存键包含 `pnpm-lock.yaml`、`Cargo.lock` 与 toolchain channel，不缓存凭据或打包签名材料。

- [ ] **Step 6: 运行完整 M0 门**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test --run
pnpm contracts:check
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm test:integration
pnpm test:e2e:renderer
pnpm tauri build --debug
pnpm test:e2e:native
git diff --check
```

Expected: 全部退出码 0；构建产物中没有 `.env`、测试 keyring 项或 fixture secrets。

- [ ] **Step 7: 提交任务**

```bash
git add package.json pnpm-lock.yaml src-tauri apps/desktop .github/workflows/ci.yml docs/architecture/security-boundaries.md playwright.config.ts tests/e2e/renderer/app-shell.spec.ts tests/e2e/native
git commit -m "feat: 接通安全桌面壳与双平台 CI"
```

## 完成检查

- [ ] 所有 Task 1-5 的 RED 失败原因有记录。
- [ ] `pnpm-lock.yaml`、`Cargo.lock` 与 migration 均已提交。
- [ ] TS/Rust fixture 双向序列化一致，9 个 TaskStatus 与 ToolCall 字段均由 `pnpm contracts:check` 覆盖。
- [ ] SQLite 文件库为 WAL，外键测试真实失败后通过。
- [ ] 测试、数据库、日志和前端状态均找不到 fixture 秘密。
- [ ] WebView Capability 不包含 shell/fs/http 通配权限。
- [ ] Playwright renderer 与 WebdriverIO native 结果分开命名，native 在 macOS/Windows 都驱动真实 debug binary。
- [ ] M0 全局验证门有本次运行输出。
