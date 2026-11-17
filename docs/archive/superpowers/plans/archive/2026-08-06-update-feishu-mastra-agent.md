# 飞书文档 Mastra Agent 架构修订实施计划

> **Archive status:** 已于 2026-08-06 完成并归档；本文件仅保留执行证据，不得作为待执行计划派发。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `FEISHU_DOCUMENT_ID` 指定的飞书文档从“默认无 Agent / 可选远端 Go Agent”修订为“桌面端必选本地 Mastra Agent + 远程模型 + Rust Core 受控工具执行”。

**Architecture:** 使用 `feishu-cli doc content-update --mode replace_range` 按标题替换受影响章节，避免全文覆盖和重复追加。所有写调用显式使用当前 User Access Token；完成后用 `doc read` 校验旧表述已清除且新增架构闭环完整。

**Tech Stack:** 飞书 Docx、feishu-cli v1.37.1、Markdown、Mastra、Tauri 2、React/TypeScript、Rust/Tokio、SQLite、系统凭据库。

## Global Constraints

- 本地 Mastra Agent 是 MVP 必选能力，运行在桌面端，不安装到受管服务器。
- 模型接入采用 Base URL、API Key、Model；API Key 只保存于系统凭据库。
- React/WebView 不直接访问模型密钥、SSH 凭据或任意 Shell。
- 只读操作可自动执行；写操作确认；高风险操作二次确认、快照、审计。
- Rust Core 的确定性策略拥有最终风险判定权，大模型不能降低风险等级。
- AI 不可用时人工运维功能仍可使用。

---

### Task 1: 修订产品定位与功能架构

**Files:**
- Reference: [本地 Mastra Agent 设计](../../specs/2026-08-06-local-mastra-agent-design.md)
- Modify: `FEISHU_DOCUMENT_ID` 指定的飞书文档中的 `0. 执行摘要`、`5. 总体架构`、`6. 产品功能架构`

**Interfaces:**
- Consumes: 已批准的本地 Mastra Sidecar + Rust Core 工具桥接架构。
- Produces: 无“默认无 Agent / 可选 Agent”矛盾的产品级定位。

- [x] **Step 1:** 为三个章节分别生成完整 Markdown 替换载荷，保留原章节中与 Agent 无关的内容。
- [x] **Step 2:** 逐章执行 `feishu-cli doc content-update ... --mode replace_range --selection-by-title`。
- [x] **Step 3:** 用 `feishu-cli doc read ... --heading` 检查三个章节。

### Task 2: 增加 AI 运维 Agent 功能与执行流程

**Files:**
- Modify: 飞书文档的 `7. 详细功能设计`、`10. 核心技术流程`、`12. Core API 与事件设计`

**Interfaces:**
- Consumes: 风险分级、Rust Core 工具、任务引擎、审计与快照接口。
- Produces: `7.11 AI 运维 Agent`、`10.5 AI 运维操作流程`、Agent/Core 命令与事件定义。

- [x] **Step 1:** 在 `7.10 设置、备份与诊断` 后加入 `7.11 AI 运维 Agent`，覆盖模型配置、会话、计划、审批和降级。
- [x] **Step 2:** 在 `10.4 项目部署流程` 后加入 `10.5 AI 运维操作流程`，写明计划、校验、审批、快照、执行、总结、审计闭环。
- [x] **Step 3:** 替换 `12. Core API 与事件设计`，增加 `agent.*`、`model.*`、`approval.*` 命令与事件。

### Task 3: 修订技术、安全、数据与可靠性设计

**Files:**
- Modify: 飞书文档的 `9. 推荐技术栈`、`11. 本地数据模型`、`13. 安全设计`、`14. 可靠性、错误处理与回滚`、`16. 非功能要求与目标`、`17. 测试策略`、`18. 构建、发布与更新`

**Interfaces:**
- Consumes: 本地 IPC、系统凭据库、Provider 配置、脱敏、审批状态机和 Agent Sidecar 生命周期。
- Produces: 可实现、可验证的跨层技术约束。

- [x] **Step 1:** 将可选 Go Agent 技术栈替换为 Mastra/TypeScript Sidecar、Provider 适配层与本地 IPC。
- [x] **Step 2:** 增加 Agent 会话、运行、工具调用和审批记录的数据表设计。
- [x] **Step 3:** 增加模型数据最小化、提示词注入防护、风险不可降级和白名单工具约束。
- [x] **Step 4:** 增加模型/Agent 故障降级、Sidecar 拉起、长任务独立存续和取消语义。
- [x] **Step 5:** 增加 Agent 契约、审批、安全、故障与模型 Provider 测试。
- [x] **Step 6:** 将构建结构从独立 Go module 改为随桌面应用打包的 Mastra Sidecar。

### Task 4: 修订路线图、仓库结构与架构决策

**Files:**
- Modify: 飞书文档的 `19. 版本规划`、`20. MVP 验收标准`、`21. 主要风险与对策`、`22. 商业化与扩展方向`、`23. 推荐仓库结构`、`24. 关键架构决策记录`、`25. 参考依据`、`附录 B：MVP Backlog（按优先级）`

**Interfaces:**
- Consumes: 前三项任务形成的最终架构。
- Produces: 与 MVP 必选 Agent 一致的交付顺序、验收条件、风险和目录结构。

- [x] **Step 1:** 将 Mastra Agent 基础验证放入 P0，将可用 Agent 闭环放入 P1，删除 P2/P3 的“可选 Agent / AI 助手”。
- [x] **Step 2:** 增加 MVP Agent 验收：模型配置、只读工具、计划预览、写操作审批、降级运行。
- [x] **Step 3:** 增加模型供应商可用性、成本、数据外发、提示词注入与工具误调用风险。
- [x] **Step 4:** 更新商业化描述，明确 Agent 是基础能力而非专业版附加执行层。
- [x] **Step 5:** 将仓库中的 `apps/agent` 改为 `apps/agent-runtime`，增加 Mastra agents、tools、workflows、providers 和 IPC contracts。
- [x] **Step 6:** 更新 ADR 并增加 Mastra 官方 Agent、Workflow 与工具审批参考。

### Task 5: 全文一致性验证

**Files:**
- Verify: `FEISHU_DOCUMENT_ID` 指定的飞书文档

**Interfaces:**
- Consumes: 所有章节更新结果。
- Produces: 可交付的修订版飞书文档。

- [x] **Step 1:** 使用 `doc read --keyword '默认无 Agent|可选 Agent|可选 Go Agent|服务器 Agent|AI 运维助手' --context 2` 搜索冲突表述。
- [x] **Step 2:** 使用 `doc read --keyword 'Mastra|Base URL|API Key|风险等级|Sidecar|降级' --context 3` 验证关键约束。
- [x] **Step 3:** 使用 `doc read --outline` 确认新增标题层级正确且没有重复章节。
- [x] **Step 4:** 使用 `doc get -o json` 确认标题不变且 revision_id 已增加。
