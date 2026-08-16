# OpsPilot Desktop

OpsPilot 是一款面向个人开发者和小型团队的本地优先桌面运维工作台，运行在 macOS 与 Windows 上。它以 SSH/SFTP 为默认通道统一管理 Linux 服务器，并内置本地 Mastra AI Agent，通过远程大模型辅助分析、规划与运维；所有实际服务器操作均由 Rust Core 通过类型化工具受控执行，受管服务器无需安装常驻 AI Agent，也无需开放额外公网管理端口。

核心能力包括：多标签 SSH 终端、SFTP 文件管理、服务器概览、项目部署、Docker 管理、Nginx 站点配置、任务中心与审计，以及 AI 运维助手。

## 技术栈

| 层级 | 技术 |
|---|---|
| 桌面容器 | Tauri 2 |
| 前端 UI | React 19 + TypeScript + Vite |
| 终端渲染 | xterm.js |
| 核心运行时 | Rust + Tokio |
| SSH 传输 | russh（默认）+ 系统 OpenSSH 回退 |
| AI Agent | Mastra（本地 Node Sidecar） |
| 本地数据库 | SQLite + sqlx |
| 敏感信息 | macOS Keychain / Windows Credential Manager |
| 测试 | Vitest + Playwright + WebdriverIO + Rust tests |

## 项目结构

```text
ssh-ops-desktop/
├── apps/
│   ├── agent-runtime/          # 本地 Mastra Agent Sidecar 入口
│   └── desktop/                # React + Vite 桌面前端
├── src-tauri/                  # Tauri 入口、命令与权限配置
├── crates/                     # Rust 核心库
│   ├── domain/                 # Server/Project/Task 领域模型
│   ├── ssh-core/               # SSH/SFTP/Tunnel/known_hosts
│   ├── remote-adapters/        # Linux/systemd/Docker/Nginx/Git 适配器
│   ├── task-engine/            # 任务、步骤、取消、回滚
│   ├── persistence/            # SQLite 与迁移
│   ├── secrets/                # 系统安全凭据库
│   ├── audit/                  # 审计与脱敏
│   └── agent-bridge/           # Agent 工具注册、风险门禁、审批与 IPC
├── packages/
│   ├── agent-core/             # Agent 相关共享能力
│   ├── config/                 # 共享构建/类型配置
│   ├── contracts/              # DTO / Schema / 生成类型
│   └── model-providers/        # 模型 Provider 适配
├── tests/                      # 集成测试与 E2E
└── docs/                       # 架构、安全、产品文档
```

## 环境要求

- Node.js 24（见 `.nvmrc`）
- pnpm 10.15.0
- Rust 1.97.1（见 `rust-toolchain.toml`）
- macOS 或 Windows（开发/运行）；远端优先支持主流 Linux 发行版

## 开发命令

```bash
# 安装依赖
pnpm install

# 开发模式（先构建 agent-runtime，再启动 Tauri 开发窗口）
pnpm dev

# 构建桌面前端
pnpm build:desktop

# 类型检查
pnpm typecheck

# 静态检查
pnpm verify:static

# 单元与 smoke 测试
pnpm test

# 集成测试
pnpm test:integration

# 渲染进程 E2E
pnpm test:e2e:renderer

# 构建 native E2E 版本并运行
pnpm build:e2e:native && pnpm test:e2e:native
```

## 安全原则

- **敏感信息不进 SQLite**：密码、私钥口令、Token、模型 API Key 仅存储于系统安全凭据库，数据库只保存 `secret_ref`。
- **主机身份校验**：首次连接展示主机指纹并要求确认，密钥变化时默认阻断。
- **前端最小权限**：Tauri Capability 不开放任意 Shell、文件系统或网络访问；前端通过类型化 `CoreClient` 与 Rust Core 通信。
- **Agent 受控执行**：Agent 只能调用 Rust Core 注册的类型化白名单工具；写操作需审批，高风险操作需二次确认并生成快照。
- **审计与脱敏**：所有工具调用、写操作和任务进入审计日志，敏感字段在写入和发送给模型前脱敏。

更多细节见 `docs/architecture/security-boundaries.md` 与 `docs/architecture/ssh-compatibility.md`。

## 许可证

本项目采用 **MIT License**，详见 [LICENSE](LICENSE)。

Copyright (c) 2026 SupremacySakura

