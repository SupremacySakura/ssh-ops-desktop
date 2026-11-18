# Harbor

Harbor 是一款面向个人开发者的本地优先纯 SSH 桌面运维台，运行在 macOS 与 Windows。它以服务器为唯一工作上下文，在同一工作区内完成终端、文件、监控与 Docker 操作；凭据只进入系统凭据库，远程访问通过 Rust Core 的 SSH/SFTP 边界完成。

## 当前状态

Harbor v1 的五个核心能力已接线：服务器目录、终端、文件、监控与 Docker。工作区内的四个 Tab 始终挂载，切换 Tab 或服务器不会销毁终端会话、文件草稿或监控采样状态。

- **服务器目录**：按分组浏览、搜索、收藏置顶与最近连接排序；支持服务器与分组的增删改。密码或私钥只写入系统凭据库，SQLite 仅保存 `secret_ref`。
- **SSH Config 导入**：预览 `~/.ssh/config` 中明确的 Host，跳过通配 Host、不完整条目、已存在项与批内重复项，再批量导入待配置服务器。导入不复制私钥、不信任主机指纹，也不执行 `Include`、`Match`、`ProxyJump`、`ProxyCommand` 等未实现的连接语义。
- **终端**：russh 建立 SSH 连接；每台服务器最多 8 个并发会话，支持多标签、resize、重连、粘贴确认与按服务器隔离的 IndexedDB 命令历史。首次连接必须显式核对并信任主机指纹，指纹变化时保持阻断。
- **文件**：SFTP 目录树、面包屑与文件列表（大小、修改时间、权限）；上传、下载、新建文件夹、重命名（文件与目录）、删除；文本文件经 Monaco 在线编辑并保存回远程。上传与文件重命名使用无覆盖提交，部分失败会回滚已提交文件；目录重命名会显式提示 SFTP v3 的竞态窗口。传输上限见 `docs/adr/0002-file-transfer-ipc-limits.md`。
- **监控**：CPU、内存、磁盘、负载与运行时间五张概览卡，近 5 分钟 CPU/内存曲线，以及可按 CPU 或内存排序的 Top 10 进程；每 2 秒采样，最多 150 个点，只保存在内存中。
- **Docker**：列出容器名称、镜像、状态、端口与启动时间；查看日志；start、stop、restart；exec 跳转到终端 Tab 并新建会话，容器没有默认 shell 时可输入经校验的命令名或绝对路径。
- **命令面板**：⌘K / Ctrl+K 搜索服务器、添加服务器或打开 SSH Config 导入。

旧 OpsPilot 的已删除子系统见 `docs/adr/0001-remove-ai-and-task-engine.md`，活动代码不再保留对应入口。当前 Tauri 命令面共 **33** 个，以 `src-tauri/build.rs` 的 manifest 为准；主窗口只获得这些命令对应的权限，以及终端/连接事件所需的 `core:event:allow-listen`、`core:event:allow-unlisten`。

## 技术栈

| 层级 | 技术 |
|---|---|
| 桌面容器 | Tauri 2 |
| 前端 UI | React 19 + TypeScript + Vite |
| 样式与状态 | Tailwind CSS v4 + Radix + Zustand |
| 终端与编辑器 | xterm.js + Monaco Editor |
| 核心运行时 | Rust + Tokio |
| SSH 传输 | russh + russh-sftp |
| 本地数据库 | SQLite + sqlx |
| 敏感信息 | macOS Keychain / Windows Credential Manager |
| 测试 | Vitest + Playwright + 跨边界集成测试 + Rust tests |

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
pnpm test:integration
pnpm contracts:check
pnpm verify:static
pnpm test:e2e:renderer
pnpm tauri build --debug
```

Rust：

```bash
cargo check --workspace
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --check
```

`pnpm test:e2e:renderer` 只运行 Vite fixture 与 Chromium，并使用注入的 fake `CoreClient`。它不能替代 Tauri、Rust Core、系统 Keychain 或真实 SSH/SFTP/Docker 的证据；这些边界由 `cargo test --workspace` 与人工验收覆盖。

## 安全原则

- **敏感信息不进 SQLite**：密码、私钥口令与 Token 只存储于系统安全凭据库，数据库仅保存可空的 `secret_ref`；`NULL` 只表示凭据待配置，不是凭据或占位引用。
- **主机身份校验**：首次连接展示主机指纹并要求确认，指纹变化时默认阻断；变化确认与旧指纹绑定，并以一次性条件更新替换。
- **前端最小权限**：Tauri Capability 只开放当前功能需要的命令；前端通过类型化 `CoreClient` 与 Rust Core 通信，不直接执行 Shell 或文件系统操作。
- **远程路径校验**：SFTP 路径必须经过 `RemotePath::try_new`，不得直接拼接未校验输入。
- **无隐式信任**：未知主机或凭据库不可用时失败关闭，不以默认值绕过检查。

更多细节见 `docs/architecture/security-boundaries.md` 与 `docs/architecture/ssh-compatibility.md`。

## 许可证

本项目采用 **MIT License**，详见 [LICENSE](LICENSE)。

Copyright (c) 2026 SupremacySakura
