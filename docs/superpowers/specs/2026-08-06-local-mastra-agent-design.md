# 本地 Mastra 运维 Agent 架构修订规格

状态：已批准  
日期：2026-08-06
文档版本：1.1.1  
同步基线：`SSH服务器运维桌面软件-完整产品与技术设计文档-V1.1.md`

## 目标

SSH Ops Desktop 必须内置基于 Mastra 的本地 AI Agent，用于辅助服务器管理、诊断、运维与操作。AI Agent 是产品基础能力并进入 MVP，不再作为后续可选模块。

受管服务器无需安装 AI Agent。所有远端操作仍由桌面端 Rust Core 通过 SSH、SFTP、端口转发及受控适配器执行。

## 术语

- **本地 Mastra Agent**：随桌面应用安装并在本机运行的 TypeScript/Node Agent 运行时。
- **远程大模型**：通过用户配置的 Base URL、API Key 与 Model 调用的模型服务。
- **受管服务器无 Agent**：服务器侧不安装常驻 AI 进程；这不代表桌面产品没有 AI Agent。
- **运维工具**：由 Rust Core 暴露给 Mastra 的类型化、白名单化能力，而不是 WebView 中的任意 Shell 权限。

## 架构

采用“本地 Mastra Sidecar + Rust Core 工具桥接”：

1. React/WebView 负责对话、计划预览、审批、进度和结果展示。
2. Mastra Sidecar 负责意图理解、计划生成、工具选择、工作流编排、会话记忆和结果总结。
3. Rust Core 负责凭据访问、工具参数校验、风险判定、审批门禁、快照、SSH/SFTP 执行、任务调度、审计和脱敏。
4. Mastra 与 Rust Core 通过仅限本机、带会话认证的 IPC 通道通信。
5. API Key 存入 macOS Keychain 或 Windows Credential Manager，不进入 SQLite、日志、前端状态或遥测。

## 模型接入

首版提供供应商无关配置：Base URL、API Key、Model。优先兼容 OpenAI-compatible 接口，模型适配层保留 Anthropic、Gemini 等原生 Provider 扩展点。

模型请求遵循最小上下文原则。服务器地址、用户名、日志、配置、环境变量和命令结果在发送前执行字段级脱敏；私钥、密码、Token、Cookie、Authorization 和完整环境变量不得发送给远程模型。

## 操作闭环

用户意图 → Mastra 生成计划 → 创建带 `toolCallId/runId/schemaVersion` 的类型化 ToolCall → Rust `OperationGateway` 校验 scope/schema 并重算风险 → 自动读取或持久化审批 → 必要时生成快照 → TaskEngine 经 SSH/SFTP 执行 → 返回结构化结果 → Agent 总结 → 写入同一关联链审计。

开放式分析与诊断使用 Agent 推理；部署、Nginx 变更、Docker 清理、回滚等确定性任务使用可暂停和恢复的 Workflow。

## 权限与风险

- L0 只读：可自动执行，但必须记录工具、目标和结果摘要。
- L1 可逆写操作：展示计划与影响范围，按用户策略确认。
- L2 有影响写操作：必须显式确认并记录变更前后差异。
- L3 高风险：二次确认、输入资源名、强制快照、失败回滚路径和完整审计。
- L4 灾难性：不向 Agent 暴露结构化执行工具，只允许用户在人工终端操作。

风险等级由 Rust Core 的确定性策略计算，大模型不能降低风险等级或绕过审批。Agent 默认只能调用白名单工具；任意命令执行必须展示命令、目标服务器、工作目录、超时和影响范围。

## 故障与降级

- 模型不可达、Key 无效、额度不足或响应超时时，AI 功能显示明确错误并允许重试或切换模型。
- AI 不可用时，服务器、终端、文件、Docker、Nginx、任务和审计等人工功能仍可使用。
- Agent 进程崩溃时由桌面主进程限次拉起；进行中的 Rust 任务保持独立状态，不因 Agent 重启而丢失。
- 长任务由任务引擎管理，支持进度、取消、重试、超时、断点状态和回滚。

## 数据与审计

SQLite 保存 Agent 会话索引、任务状态、审批记录、工具调用元数据和脱敏后的摘要。敏感凭据只保存系统凭据库引用。默认不保存完整模型请求与响应；诊断模式也必须脱敏并由用户显式开启。

每次工具调用至少记录稳定字段 `toolCallId`、`runId`、`schemaVersion`、`serverId`、`toolName`、`argsDigest`、风险等级/策略版本、审批 ID/审批人/时间、taskId、执行结果、snapshotId 与 rollback 引用；人工与 Agent 调用使用同一组字段。`toolCallId + argsDigest` 必须能从审计反查 immutable ToolCall、Approval、Snapshot 和 Task，字段不得只藏在自由文本摘要。审计记录不得包含凭据、canonical args 或未脱敏日志。

## 测试与验收

- 单元测试：工具 schema、风险分类、脱敏、审批状态机、Provider 配置和错误映射。
- 契约测试：Mastra Sidecar 与 Rust Core IPC 请求、响应、取消、超时和版本兼容。
- 集成测试：只读自动执行、写操作审批、高风险二次确认、快照与回滚。
- 安全测试：提示词注入、工具参数注入、跨服务器越权、密钥泄漏、日志泄漏和审批绕过。
- 故障测试：模型断网、限流、超时、Agent 崩溃、桌面重启和 SSH 中断。

MVP 验收要求包括：本地 Mastra Agent 可配置远程模型、能够解释服务器状态、生成可审查计划、调用至少一组只读工具，并在写操作前正确触发审批门禁。

## 文档联动范围

修订执行摘要、总体架构、功能架构、详细功能、技术栈、核心流程、安全、可靠性、测试、构建发布、版本规划、仓库结构、架构决策和 MVP Backlog；删除“默认无 Agent”“可选 Go Agent”“P2 才引入 Agent”等冲突表述。

本规格与 V1.1 主设计、总路线图“固化的跨层接口”、04 Agent 实施计划共同构成一个版本单元。任何修改 `toolCallId/runId/schemaVersion`、OperationGateway、风险/审批、Sidecar IPC、Workflow 持久化或审计字段的变更，负责人必须在同一 PR 中更新这四处并在 `2026-08-06-opspilot-plan-audit-resolution.md` 记录迁移影响；若不能同步，版本评审不得批准。本规格版本采用 semver：契约不兼容变更升 major，新增兼容字段升 minor，文字澄清升 patch。
