# Domain docs

本仓库采用**单上下文**布局：根目录一个 `GLOSSARY.md` 和一个 `docs/adr/`。前端（React/Tauri）、Rust Core（`crates/*`）与共享包（`packages/*`）共同服务同一产品，领域词汇全局共享。

## 使用规则

- **`GLOSSARY.md`**：定义当前领域术语（Server、Group、Workspace、Tab、Session、Favorite、Command History、Monitoring Snapshot、Docker Container、Remote Path、SSH Config Import 等）。所有代码、文档、议题中使用术语时必须与词汇表一致；新增/重命名术语时先更新词汇表，再改代码。已删除的旧术语只在该文件的“已删除术语”一节作为历史存在。
- **`docs/adr/`**：架构决策记录。每个 ADR 一个文件，命名为四位数字加短标题（如 `docs/adr/0001-remove-ai-and-task-engine.md`），包含：状态（proposed/accepted/deprecated/superseded）、上下文、决策、后果。做出不可逆或跨模块决策前先写 ADR。
- **读写顺序**：AI 代理开始任何任务前，先读 `GLOSSARY.md`；涉及架构改动前，先检索 `docs/adr/` 是否已有相关决策。
- **不要分散**：不要在 `apps/*/`、`crates/*/`、`packages/*/` 下另建 `GLOSSARY.md` 或 `docs/adr/`；所有术语与决策集中维护。
- **产品事实**：`apps/desktop/PRODUCT.md` 记录产品定位与使用场景，`apps/desktop/DESIGN.md` 是视觉系统唯一权威；二者与 `GLOSSARY.md` 冲突时，术语含义以词汇表为准。

## 当前状态

- `GLOSSARY.md`：包含 Server / Group / Workspace / Tab / Session / Favorite 等核心术语，以及已删除术语的历史说明。
- `docs/adr/`：已创建，首条 ADR 为 `0001-remove-ai-and-task-engine.md`。
