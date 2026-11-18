# 0001 — 移除 AI Agent、Task Engine 与 Audit

## Status

**Accepted** — 2026-11-17

## Context

OpsPilot v1 此前定位为"AI 驱动的运维平台"，包含以下子系统：

- `apps/agent-runtime`：本地 Mastra Node.js Sidecar，运行 AI Agent
- `crates/agent-bridge`：Agent 工具注册、风险门禁、IPC 桥接
- `crates/task-engine`：操作审批、回滚、快照、风险分级引擎
- `crates/audit`：操作审计与脱敏
- `packages/agent-core`、`packages/model-providers`：Agent 共享能力

这些子系统约占 Rust 代码 2400 LOC、TypeScript 代码数千 LOC，且相互耦合。在重构讨论中（见 `docs/agents/harbor-rebuild.md`），用户明确将产品定位从"AI 运维平台"调整为"纯 SSH 运维台"，受众为**个人自用**。

我们面临的核心权衡是：

**方案 A：保留这些子系统作为"未来扩展骨架"**
- 优点：未来重新引入 AI 时无需重写
- 缺点：持续维护成本高（依赖升级、测试维护）；代码中存在大量"看似重要但从未被调用"的路径，增加新开发者（包括未来的自己）的认知负担；`task-engine` 的"风险门禁 + 审批 + 回滚"对纯人工 UI 操作来说是过度设计——用户点击"删除文件"时弹原生确认对话框已足够

**方案 B：彻底删除**
- 优点：代码库减重约 1/3，心智模型大幅简化；剩余 5 个 crate（domain/ssh-core/persistence/secrets/remote-adapters）边界清晰
- 缺点：若未来重新引入 AI，需要重写这些子系统

## Decision

**采用方案 B**：彻底删除 `agent-runtime`、`agent-bridge`、`task-engine`、`audit`、`agent-core`、`model-providers`。

同时删除：
- `src-tauri/src/commands/agent.rs`、`operation.rs`、`task.rs`、`model.rs`（以及 `audit_list` 命令）
- 前端 `features/agent`、`features/tasks`、`features/settings` 中的模型配置部分
- SQLite 中所有 `tasks`、`audits`、`agent_*`、`model_profiles`、`projects` 表
- 前端 `packages/contracts` 中所有 agent/task/audit 相关 schema

## Consequences

### 正面

- Rust 代码从 ~9000 LOC 减至 ~6500 LOC
- crate 数量从 8 减至 5，依赖图简化
- 前端无 AI 相关状态管理，Zustand store 大幅简化
- 写操作（文件删除、容器停止）改用 Tauri 原生确认对话框，无需审批网关

### 负面

- 若未来要重新引入 AI 辅助，需重新设计 Agent 集成方式。但鉴于当前 AI 集成度仅为"单轮调用 + 弹审批"，重写成本不高于在旧骨架上改造。
- `persistence` crate 需要新建 v2 schema，无法复用现有迁移历史（可接受，因为本项目是个人自用工具）。

### 不可逆性

本决策**高度不可逆**：一旦删除并推送到 master，恢复这些子系统需要从 git 历史翻出旧代码并解决大量冲突。但鉴于：

1. 代码已提交至 git，历史随时可查
2. 新定位（纯 SSH 工具）与旧定位（AI 平台）心智模型差异巨大
3. 保留的 5 个 crate 与删除的 3 个 crate 之间接口清晰

我们认为这个代价是合理且必要的。

### 后续动作

- 在 `GLOSSARY.md` 中标记 Agent / TaskEngine / Audit 为"已删除术语"
- 在 `README.md` 中说明产品名变更为 Harbor，定位变更为"纯 SSH 运维台"
