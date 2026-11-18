# Task 5 Review Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复 Task 5 复审确认的 CR-002、CR-003、CR-004、CR-005，同时保留 native E2E 对真实系统凭据存储可用性的严格验证。

**Architecture:** React 应用用显式的加载、成功、失败状态收敛 Core 健康检查；Rust 健康命令直接返回由内部探测结果组成的健康快照；测试版本从各自可信来源或专用 fixture 获取；WebdriverIO Tauri 插件由实际导入它的 desktop workspace 声明。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、Rust、Tauri、WebdriverIO、pnpm workspace

## Global Constraints

- 保留当前工作区及暂存区中的 Task 5 改动，不执行 `git add`、`git commit`、`git push` 或分支集成。
- 每个行为修复先观察失败测试，再写最小实现并重新验证。
- UI 不展示来自 IPC 或后端的原始错误内容。
- native E2E 继续要求 `secretStoreReady === true`，但给缺少系统凭据存储的环境提供明确诊断。

### Task 1: CR-002 — Core 健康检查失败状态

**Files:**
- Modify: `apps/desktop/src/App.test.tsx`
- Modify: `apps/desktop/src/App.tsx`

- [x] 在 `App.test.tsx` 添加 `core.health()` 拒绝时的回归测试，断言出现通用 `role="alert"` 错误且“正在检查 Core”消失。
- [x] 运行 `pnpm --filter @opspilot/desktop test --run src/App.test.tsx`，确认新测试因没有错误状态而失败。
- [x] 将 `App` 的健康状态改为 `loading | loaded | error` 判别联合；在 effect 内用 `try/catch` 处理拒绝，并保留卸载/依赖变化后的失效保护。
- [x] 重新运行定向测试，确认成功路径和拒绝路径均通过。

### Task 2: CR-004 与 CR-003 — Rust 返回契约和版本来源

**Files:**
- Modify: `src-tauri/src/commands/health.rs`
- Modify: `apps/desktop/src/App.test.tsx`
- Modify: `tests/e2e/renderer/fixture/main.tsx`
- Modify: `tests/e2e/renderer/app-shell.spec.ts`
- Modify: `tests/e2e/native/app-shell.e2e.ts`

- [x] 先将 Rust 测试改为直接接收 `CoreHealth`，并用 `env!("CARGO_PKG_VERSION")` 断言版本；运行定向 Cargo 测试，确认当前 `Result` 契约导致编译失败。
- [x] 将 `read_core_health` 与 Tauri `core_health` 命令改为直接返回 `CoreHealth`，移除生产代码中不再使用的 `CoreError`。
- [x] 运行定向 Cargo 测试，确认成功。
- [x] 将 App 单元测试版本改为 `test-version`，renderer fixture/spec 改为 `renderer-fixture`，避免把应用发布版本写死在测试替身中。
- [x] native E2E 从 `src-tauri/tauri.conf.json` 读取预期版本；保持真实 DB 和凭据存储就绪断言，并为凭据存储不可用添加明确前置条件错误。

### Task 3: CR-005 — WebdriverIO Tauri 插件依赖归属

**Files:**
- Modify: `package.json`
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`

- [x] 从根 workspace 的 `devDependencies` 移除精确版本 `@wdio/tauri-plugin`。
- [x] 在实际动态导入该包的 `@opspilot/desktop` 中添加同一精确版本。
- [x] 运行 pnpm install 更新 lockfile 和 workspace 链接（离线 store 不完整，最终联网解析但复用本地包内容并禁用生命周期脚本）。
- [x] 检查 lockfile importer，确认根 importer 不再声明该包、desktop importer 已声明。
- [x] 运行 desktop typecheck 和 native E2E 前端构建，确认包能从正确 workspace 解析。

### Task 4: 全量验证和差异审计

**Files:**
- Verify only

- [x] 运行 frontend unit tests、renderer E2E、native E2E。
- [x] 运行 Cargo workspace tests。
- [x] 运行 TypeScript typecheck、ESLint、Rust fmt check、Clippy warnings-as-errors。
- [x] 运行 `git diff --check` 与 `git diff --cached --check`。
- [x] 审阅最终 diff，确认只包含批准范围内的修复且暂存状态未被主动改变。
