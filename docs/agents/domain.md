# Domain docs

本仓库采用**单上下文**布局：根目录一个 `GLOSSARY.md` 和一个 `docs/adr/`。前端（React/Tauri）、Rust Core（`crates/*`）、共享包（`packages/*`）与 Agent Sidecar（`apps/agent-runtime`）共同服务同一产品，领域词汇全局共享。

## 使用规则

- **`GLOSSARY.md`**：定义领域术语（Server、Project、Task、Approval、Audit、RemotePath、ToolExecutor、Risk Gate 等）。所有代码、文档、议题中使用术语时必须与词汇表一致；新增/重命名术语时先更新词汇表，再改代码。
- **`docs/adr/`**：架构决策记录。每个 ADR 一个文件，命名 `NNNN-short-title.md`（四位数字递增），包含：状态（proposed/accepted/deprecated/superseded）、上下文、决策、后果。做出不可逆或跨模块决策前先写 ADR。
- **读写顺序**：AI 代理开始任何任务前，先读 `GLOSSARY.md`；涉及架构改动前，先检索 `docs/adr/` 是否已有相关决策。
- **不要分散**：不要在 `apps/*/`、`crates/*/`、`packages/*/` 下另建 `GLOSSARY.md` 或 `docs/adr/`；所有术语与决策集中维护。

## 当前状态

- `GLOSSARY.md`：已创建，包含 Server / Group / Workspace / Tab / Session / Favorite 等核心术语与已删除术语。
- `docs/adr/`：已创建，首条 ADR 为 `0001-remove-ai-and-task-engine.md`。
