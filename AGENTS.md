# AGENTS.md

面向 AI 编码代理与人类开发者的仓库指南。与 `README.md`、`docs/` 冲突时，以本文件为当前约定。

## 项目概览

OpsPilot 是一款本地优先的桌面运维工作台：Tauri 2 桌面容器承载 React 19 前端，Rust Core 通过 SSH/SFTP 管理 Linux 服务器；本地 Mastra Agent Sidecar（`apps/agent-runtime`）提供 AI 辅助分析，但所有服务器写操作都由 Rust Core 的类型化工具受控执行，统一进入风险门禁、审批网关与审计日志。受管服务器无需安装常驻 Agent，也无需开放额外公网管理端口。

## 技术栈

| 层级 | 技术 |
|---|---|
| 桌面容器 | Tauri 2 |
| 前端 | React 19 + TypeScript + Vite + xterm.js + Monaco Editor |
| AI Agent | Mastra（`apps/agent-runtime`，Node Sidecar） |
| 核心运行时 | Rust + Tokio + russh / russh-sftp |
| 数据库 | SQLite + sqlx（`crates/persistence`） |
| 敏感信息 | 系统凭据库（macOS Keychain / Windows Credential Manager），数据库只存 `secret_ref` |
| 测试 | Vitest、Playwright、WebdriverIO、`cargo test` |

## 仓库结构

```text
apps/
  agent-runtime/        # 本地 Mastra Agent Sidecar 入口
  desktop/              # React + Vite 桌面前端（Tauri 渲染进程）
src-tauri/              # Tauri 入口、命令层与权限配置（Rust）
crates/                 # Rust 核心库（workspace）
  domain/               # Server/Project/Task 领域模型、错误类型
  ssh-core/             # SSH/SFTP/连接管理/known_hosts（RemotePath 校验在此）
  remote-adapters/      # Linux/systemd/Docker/Nginx/Git 适配器
  task-engine/          # 任务、步骤、取消、回滚、审批
  persistence/          # SQLite 与迁移
  secrets/              # 系统安全凭据库
  audit/                # 审计与脱敏
  agent-bridge/         # Agent 工具注册、风险门禁、审批与 IPC
packages/               # 前端共享包（contracts / agent-core / config / model-providers）
tests/                  # smoke / 集成 / E2E
docs/                   # 架构、安全、产品文档
```

## 常用命令

```bash
pnpm install                 # 安装依赖（pnpm 10.15.0，Node 24）
pnpm dev                     # 构建 agent-runtime 后启动 Tauri 开发窗口
pnpm build:desktop           # 构建桌面前端
pnpm lint                    # eslint --max-warnings 0
pnpm typecheck               # 全仓 TypeScript 类型检查
pnpm test                    # 包测试 + smoke
pnpm test:integration        # 集成测试
pnpm verify:static           # lint + typecheck + cargo fmt --check + clippy -D warnings
pnpm test:e2e:renderer       # 渲染进程 E2E（Playwright）
```

Rust 侧：

```bash
cargo check -p opspilot-desktop
cargo test -p opspilot-desktop --lib
cargo clippy -p opspilot-desktop --all-targets -- -D warnings
cargo fmt --check
```

提交前至少通过：`pnpm lint`、`pnpm typecheck`、相关包测试、`cargo fmt --check`、`cargo clippy -D warnings`。

## 代码规范

- **提交信息**：Conventional Commits；`type` 用英文关键字，`scope` 用英文小写 kebab-case；`subject`/`body` 默认中文（除非用户本次明确要求英文）。示例：`feat(desktop): 文件管理器支持文件夹上传`。
- **TypeScript/React**：eslint `--max-warnings 0`；Hook 依赖数组完整，避免陈旧闭包；`key` 稳定；异步流程处理 loading/错误/竞态。
- **Rust**：rustfmt + clippy（`-D warnings`，零告警）；错误统一用 `CoreError`（携带 code/retryable）；远程路径一律经 `RemotePath::try_new` 校验。
- **工具一致性**：新增写工具必须实现 `ToolExecutor` 并接入风险门禁与审批网关；工具描述（`agent_tool_descriptors`）、JSON Schema、Rust 解析、前端调用四者必须一致，数量/大小上限前后端对齐。

## 安全边界（不可违反）

- 密码、私钥口令、Token、模型 API Key 等敏感信息**绝不**写入 SQLite、日志、审计或提交进 Git；只进系统凭据库。
- 不提交 `.env`、密钥文件、构建产物（`target/`、`node_modules/`、`dist/`）与测试残留目录（`playwright-report/`、`test-results/` 已在 `.gitignore` 中排除）。
- 前端不直接执行 Shell / 文件系统操作；所有能力经 `CoreClient` 与 Rust Core 通信。
- Agent 只能调用 Rust Core 注册的白名单工具；写操作必须审批，高风险操作需二次确认与快照。
- 主机指纹未知或变化时阻断连接，不得静默信任。
- 文件上传/重命名等"冲突校验"语义：提交必须无覆盖（如 `hardlink@openssh.com` 原子提交），失败时回滚已提交部分。

## Agent 工作守则

- 只根据实际 `git diff` 描述与审查变更，不臆造未读到的内容；大型 Diff 要分批读完再下结论。
- 不擅自执行 `git add`、`git commit`、`git push`、修改锁文件或格式化整个仓库；用户明确要求且经过预览/确认流程才执行提交。
- 修改代码前先读目标文件；改完必须运行相关检查（lint / typecheck / 测试 / fmt / clippy），并在回复中报告结果。
- 涉及安全、权限、并发、数据库、公共 API 的改动，需说明影响与验证方式。
- 发现问题按等级汇报（P0 阻塞 / P1 高优先 / P2 中 / P3 建议），给出文件与行号，不为凑数制造问题。
