# Harbor 重构实施计划（SSOT）

本文档是 Harbor（前 OpsPilot）完全重构的**单一事实源**。所有实施工作必须以此文档为准；如实施过程中发现与本文档冲突，先停下来更新本文档再继续。

---

## 产品定位

**Harbor** 是一款面向个人开发者的**纯 SSH 运维台**，运行在 macOS 与 Windows 上。以 SSH/SFTP 为通道管理 Linux 服务器，提供终端、文件、监控、Docker 四个核心能力。

**不是**：AI 平台、团队协作工具、项目部署工具、Nginx 配置工具。

---

## UI 视觉方向（已确定）

**Calibrated Panel** — 来自 Braun / Dieter Rams 工业设计：暖灰表面、炭黑文字、单一信号橙、镌刻式标签、等宽数字、1px 发丝线。签名动作是"校准刻度"（CPU/内存/磁盘标尺）、完整的服务器铭牌行、工作区左缘常驻书脊。

**权威文件**

- `apps/desktop/DESIGN.md`：视觉系统唯一权威（色板、字体、间距、组件、状态、动效）。
- `apps/desktop/PRODUCT.md`：产品事实与使用场景。
- `design/harbor-calibrated-panel.html`：1440×900 首屏参考稿。

**核心 token**：`shell #E9E6DF` / `paper #FAF9F6` / `ink #1B1A17` / `muted #6F6B62` / `hairline #CFCAC0` / `accent #E85D04` / `screen #141311`；Inter Tight（UI）+ IBM Plex Mono（数据/终端）。

**约束**：无圆角卡片、渐变、玻璃拟态；橙色只标记"当前/值得注意"；旧 OpsPilot UI 是反参考。前端代码尚未按此方向实现，样式决策先于实现落地。

---

## 核心决策（D1-D24）

| # | 决策 | 选择 |
|---|---|---|
| D1 | 重构方式 | 产品重置：保留技术栈（Tauri 2 + React 19 + Rust + pnpm），功能/UI/IA 全部重新设计 |
| D2 | 受众 | 纯自用 |
| D4 | 产品定位 | 运维台（服务器列表为入口） |
| D5 | MVP 范围 | 服务器 + 终端 + 文件 + 监控 + Docker（5 个核心） |
| D6 | AI Agent | **完全移除** |
| D9 | Rust 瘦身 | 保留 `domain`/`ssh-core`/`persistence`/`secrets`/`remote-adapters`；删除 `agent-bridge`/`task-engine`/`audit` |
| D10 | 信息架构 | 单一工作台：左侧服务器列表，右侧 4 Tab |
| D11 | 多服务器 | 单聚焦，切走保活不切连接 |
| D12 | Server 模型 | 最小字段 + `favorite` + `last_connected_at` |
| D13 | 终端能力 | 多标签 + SFTP 跳转 + 客户端命令历史搜索 |
| D15 | 默认 Tab | 终端（打开服务器 = 立即 SSH） |
| D16 | 文件 Tab | 目录树 + 文件列表 + CRUD + Monaco 在线编辑 |
| D17 | 监控 Tab | 5 卡片 + CPU/内存 5min 折线 + top 10 进程 |
| D18 | Docker Tab | 列表 + 日志 + exec 跳终端 + start/stop/restart |
| D19 | 添加服务器 | 单表单 + `~/.ssh/config` 一键导入 |
| D20 | 仓库/产品名 | 仓库保留 `ssh-ops-desktop`；产品改名 **Harbor** |
| D21 | 重构策略 | 大爆炸：开 `rebuild` 分支，旧 master 留作参考 |
| D22 | 前端技术栈 | React 19 + Vite + **Zustand + Tailwind CSS + Radix UI** |
| D23 | 领域文档 | `GLOSSARY.md` + ADR 0001 |
| D24 | 测试 | Rust 单元 + Vitest + Playwright 渲染进程 E2E（删除 WebdriverIO） |

---

## 实施阶段

### Phase 0 — 文档与准备
- [x] 创建 `rebuild` 分支
- [x] 创建 `GLOSSARY.md`
- [x] 创建 `docs/adr/0001-remove-ai-and-task-engine.md`
- [x] 创建本文档

### Phase 1 — Rust Core 瘦身
- [ ] 删除 `crates/agent-bridge`、`crates/task-engine`、`crates/audit`
- [ ] 删除 `apps/agent-runtime`
- [ ] 删除 `packages/agent-core`、`packages/model-providers`
- [ ] 删除 `src-tauri/src/commands/{agent,operation,task,model}.rs`
- [ ] 精简 `packages/contracts`
- [ ] `persistence` 新建 v2 schema：`servers`、`groups`、`credentials_meta`、`command_history`
- [ ] 更新 `Cargo.toml` workspace
- [ ] 验证：`cargo check -p opspilot-desktop`、`cargo test -p opspilot-desktop --lib`、`cargo clippy --workspace --all-targets -- -D warnings` 全通过

### Phase 2 — 前端骨架重写
- [ ] 删除 `apps/desktop/src` 下所有现有代码
- [ ] 引入依赖：`zustand`、`tailwindcss` v4、`@radix-ui/react-*`、`@tanstack/react-query`
- [ ] 配置 Tailwind
- [ ] 建立新目录结构（feature-based）
- [ ] 实现 `AppShell`：左侧 `ServerListPane` + 右侧 `ServerWorkspacePane`

### Phase 3 — 核心 Feature 实现
- [ ] 服务器列表（搜索 / 分组 / favorite / 右键菜单）
- [ ] 服务器工作区（4 Tab + 默认进终端）
- [ ] 终端 Tab（xterm 多会话 + 命令历史 + SFTP 跳转）
- [ ] 文件 Tab（目录树 + 文件列表 + CRUD + Monaco 编辑）
- [ ] 监控 Tab（5 卡片 + 5min 折线 + top 10）
- [ ] Docker Tab（列表 + 日志 + start/stop/restart + exec 跳终端）
- [ ] 添加/编辑服务器（单表单 + ssh config 导入）

### Phase 4 — 测试与文档
- [ ] Rust 单元测试保留并通过
- [ ] 前端 Vitest 单测
- [ ] Playwright 渲染进程 E2E（关键用户流）
- [ ] 删除 `tests/e2e/native/`（WebdriverIO）
- [ ] 更新 `package.json` scripts
- [ ] 更新 `README.md`
- [ ] 更新 `AGENTS.md`

---

## 数据 Schema（v2）

见 `<proposed_plan>` 中的 SQL 定义。所有敏感信息（Credential）只存系统 Keychain，SQLite 只存 `secret_ref`。

---

## 范围外（Out of Scope）

- AI Agent 任何形式的保留
- Nginx 配置管理、项目部署、任务中心、审计日志、工作区
- 多服务器并行 / 分屏 / 批量操作
- SSH 隧道管理、端口转发 UI
- sz/rz 文件传输协议
- Docker Compose 管理
- 历史监控数据持久化（只看最近 5 分钟实时）
- 主题系统（v1 只有一套深色默认）
- 国际化（v1 只有中文）
- 自动更新机制
