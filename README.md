# Harbor

Harbor 是一款面向个人开发者的本地优先纯 SSH 桌面运维台，运行在 macOS 与 Windows。它以服务器为唯一工作上下文，在同一工作区内完成终端、文件、监控与 Docker 操作；凭据只进入系统凭据库，远程访问通过 Rust Core 的 SSH/SFTP 边界完成。

## 当前状态

仓库正在执行 Harbor v1 的基础切换：

- 已移除旧 OpsPilot 的 AI Agent、Task Engine、Audit、Agent Runtime 与 Agent/Model 共享包。
- Rust workspace 只保留 `domain`、`ssh-core`、`persistence`、`secrets`、`remote-adapters` 与 Tauri 壳。
- SQLite v2 schema 为 `groups` 与 `servers`，不迁移旧数据。
- 应用启动为 Calibrated Panel 空壳：左侧品牌、搜索与空服务器状态，右侧空工作区，Core 健康检查可见。

服务器增删改查、SSH 连接、终端、文件、监控与 Docker 命令由后续议题接入；当前版本不提供这些交互。

## 技术栈

| 层级 | 技术 |
|---|---|
| 桌面容器 | Tauri 2 |
| 前端 UI | React 19 + TypeScript + Vite |
| 样式与状态 | Tailwind CSS v4 + Radix + Zustand |
| 终端渲染 | xterm.js（按后续议题接入） |
| 核心运行时 | Rust + Tokio |
| SSH 传输 | russh（默认）+ 系统 OpenSSH 回退 |
| 本地数据库 | SQLite + sqlx |
| 敏感信息 | macOS Keychain / Windows Credential Manager |
| 测试 | Vitest + Playwright + Rust tests |

## 项目结构

```text
ssh-ops-desktop/
├── apps/
│   └── desktop/                # React + Vite 桌面前端
├── src-tauri/                  # Tauri 入口、命令与权限配置
├── crates/
│   ├── domain/                 # Server/Group 领域模型与错误
│   ├── ssh-core/               # SSH/SFTP/known_hosts
│   ├── remote-adapters/        # Linux/systemd/Docker 适配器
│   ├── persistence/            # SQLite v2 与迁移
│   └── secrets/                # 系统安全凭据库
├── packages/
│   ├── config/                 # 共享构建/类型配置
│   └── contracts/              # 前端 DTO 与 Zod Schema
├── tests/                      # smoke、集成与渲染进程 E2E
└── docs/                       # 架构、ADR 与产品文档
```

## 环境要求

- Node.js 24（见 `.nvmrc`）
- pnpm 10.15.0
- Rust 1.97.1（见 `rust-toolchain.toml`）
- macOS 或 Windows；远端优先支持主流 Linux 发行版

## 开发命令

```bash
pnpm install
pnpm dev
pnpm build:desktop
pnpm lint
pnpm typecheck
pnpm test
pnpm verify:static
pnpm test:e2e:renderer
```

Rust：

```bash
cargo check --workspace
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --check
```

## 安全原则

- **敏感信息不进 SQLite**：密码、私钥口令与 Token 只存储于系统安全凭据库，数据库仅保存 `secret_ref`。
- **主机身份校验**：首次连接展示主机指纹并要求确认，指纹变化时默认阻断。
- **前端最小权限**：Tauri Capability 只开放当前功能需要的命令；前端通过类型化 `CoreClient` 与 Rust Core 通信。
- **远程路径校验**：SFTP 路径必须经过 `RemotePath::try_new`，不得直接拼接未校验输入。
- **无隐式信任**：未知主机或凭据库不可用时失败关闭，不以默认值绕过检查。

更多细节见 `docs/architecture/security-boundaries.md` 与 `docs/architecture/ssh-compatibility.md`。

## 许可证

本项目采用 **MIT License**，详见 [LICENSE](LICENSE)。

Copyright (c) 2026 SupremacySakura
