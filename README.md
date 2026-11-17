# Harbor

Harbor 是一款面向个人开发者的本地优先纯 SSH 桌面运维台，运行在 macOS 与 Windows。它以服务器为唯一工作上下文，在同一工作区内完成终端、文件、监控与 Docker 操作；凭据只进入系统凭据库，远程访问通过 Rust Core 的 SSH/SFTP 边界完成。

## 当前状态

仓库已完成 Harbor v1 的基础切换，并落地服务器目录、SSH Config 导入、SSH 连接与多会话终端：

- 已移除旧 OpsPilot 的 AI Agent、Task Engine、Audit、Agent Runtime 与 Agent/Model 共享包。
- Rust workspace 只保留 `domain`、`ssh-core`、`persistence`、`secrets`、`remote-adapters` 与 Tauri 壳。
- SQLite schema 保存 `groups`、`servers` 与内部 `known_host_keys`，不迁移旧数据。
- Calibrated Panel 服务器目录支持分组、搜索、收藏与最近连接排序，以及服务器和分组的增删改。
- 服务器密码或私钥只写入系统凭据库，SQLite 仅保存 `secret_ref`；导入的服务器以 `secret_ref = NULL` 明确表示“凭据待配置”。
- 可从 `~/.ssh/config` 预览明确的 Host，跳过通配 Host、不完整条目、已存在项和批内重复项，再批量导入待配置服务器。
- SSH 连接由 Rust Core 建立；密码与私钥在连接时从系统凭据库读取，私钥内容不落 SQLite，也不返回 WebView。
- 每台服务器最多同时打开 8 个终端会话，支持 keep-alive、窗口自适应、重连与按服务器隔离的 IndexedDB 命令历史。
- 首次连接必须显式核对并信任主机指纹；指纹变化时保持阻断，只有用户再次确认后才以条件更新原子替换旧指纹。
- 命令面板可通过 ⌘K / Ctrl+K 搜索服务器、添加服务器或打开 SSH Config 导入。

文件、监控与 Docker 由后续议题接入；当前版本不提供这些交互。SSH Config 导入不会复制私钥、信任主机指纹或执行 `Include`、`Match`、`ProxyJump`、`ProxyCommand` 等尚未实现的连接语义。

## 技术栈

| 层级 | 技术 |
|---|---|
| 桌面容器 | Tauri 2 |
| 前端 UI | React 19 + TypeScript + Vite |
| 样式与状态 | Tailwind CSS v4 + Radix + Zustand |
| 终端渲染 | xterm.js |
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

- **敏感信息不进 SQLite**：密码、私钥口令与 Token 只存储于系统安全凭据库，数据库仅保存可空的 `secret_ref`；`NULL` 只表示凭据待配置，不是凭据或占位引用。
- **主机身份校验**：首次连接展示主机指纹并要求确认，指纹变化时默认阻断；变化确认与旧指纹绑定，并以一次性条件更新替换。
- **前端最小权限**：Tauri Capability 只开放当前功能需要的命令；前端通过类型化 `CoreClient` 与 Rust Core 通信。
- **远程路径校验**：SFTP 路径必须经过 `RemotePath::try_new`，不得直接拼接未校验输入。
- **无隐式信任**：未知主机或凭据库不可用时失败关闭，不以默认值绕过检查。

更多细节见 `docs/architecture/security-boundaries.md` 与 `docs/architecture/ssh-compatibility.md`。

## 许可证

本项目采用 **MIT License**，详见 [LICENSE](LICENSE)。

Copyright (c) 2026 SupremacySakura
