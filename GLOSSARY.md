# GLOSSARY

本文件定义 Harbor（前 OpsPilot）项目中所有领域术语的**唯一权威含义**。任何代码、文档、议题、变量名中出现这些词，必须与此处定义一致。

---

## Server

一台可通过 SSH 连接的远程 Linux 主机，是用户操作的核心对象。

**字段**：`id` / `name` / `host` / `port` / `user` / `auth_type` / `secret_ref` / `group_id` / `favorite` / `last_connected_at` / `created_at`。

`secret_ref` 可为 `NULL`，仅用于表达“凭据待配置”；非空值必须是指向系统凭据库的 SecretRef。

**不属于 Server 的信息**：标签（tags）、备注（notes）、自定义颜色——v1 不提供这些字段。

---

## Group

Server 的逻辑分组（如"生产"、"测试"、"个人"），用于在左侧栏中组织服务器列表。

**约束**：单层级，不支持嵌套；一个 Server 最多属于一个 Group；不属于任何 Group 的 Server 显示在"未分组"中。

---

## Credential / SecretRef

**Credential**：连接 Server 所需的敏感信息（密码或私钥），**永远只存放在系统 Keychain**（macOS Keychain / Windows Credential Manager），不写入 SQLite / 日志 / 审计。

**SecretRef**：指向 Keychain 中某条 Credential 的不透明引用（UUID 字符串），只有它被存入 SQLite 的 `servers.secret_ref` 字段。

**凭据待配置**：`servers.secret_ref = NULL` 的显式状态，表示 Server 元数据已存在但尚未关联任何 Credential。它不是空字符串、占位引用或可尝试使用的秘密；连接前必须先由用户补充密码或私钥。

---

## Workspace

用户当前正在操作的 Server 上下文。打开某个 Server 即进入其 Workspace；同时只能有一个 Workspace 处于激活状态。

**组成**：顶部信息条 + 4 个 Tab（Terminal / Files / Monitoring / Docker）。

---

## Tab

Workspace 内的四个功能视图之一：**Terminal / Files / Monitoring / Docker**。Tab 间切换时保持挂载，不销毁状态。

---

## Session

Terminal Tab 内的一个独立 SSH 终端连接（对应一个 xterm.js 实例）。同一个 Workspace 可同时打开多个 Session（嵌套 Tab），最多 8 个并发。

**与 SSH 连接的关系**：一个 Session 对应一条独立的 SSH channel；多条 Session 可复用同一条 SSH 连接（多路复用），也可独立建连，实现细节由 `ssh-core` 决定。

---

## Favorite

Server 的布尔标记，置为 `true` 的 Server 在左侧栏跨 Group 置顶显示，用于快速访问高频服务器。

---

## LastConnectedAt

Server 最近一次成功建立 SSH 连接的时间戳（Unix epoch，秒）。用于：

1. 未 favorite 的 Server 按此字段倒序排列；
2. UI 上显示"3 分钟前连接过"等相对时间。

每次成功连接时更新；连接失败不更新。

---

## Command History

客户端在 Terminal Session 中执行过的命令记录，**仅存于浏览器 IndexedDB**（不入 SQLite），用于 Ctrl+R 模糊搜索。每条记录包含：命令文本、Server ID、执行时间。

---

## SSH Config Import

从 `~/.ssh/config` 解析明确 Host 条目并批量导入为 Server 的功能。仅导入 `Host`、`HostName`、`Port` 与 `User`；通配 Host、不完整条目和未支持连接语义不会被猜测或静默执行。顶层、通配 Host 或 Match 中无法安全解释的继承语义会使明确条目标为不可导入。已存在的 `(host, port, user)` 三元组与同批重复项自动跳过。导入不复制私钥、不创建 Credential、不信任主机指纹，新 Server 进入“凭据待配置”状态。

---

## Sidebar

应用左侧栏，包含：搜索框、`+ 添加服务器`按钮、`从 SSH Config 导入`按钮、按 Group 组织的 Server 列表。是用户与 Server 交互的唯一入口。

---

## Monitoring Snapshot

Server 在某一时刻的系统状态采样，包含 CPU %、内存 %、磁盘 %、负载 1m、运行时间、Top 10 进程。**只在内存中保留最近 5 分钟**（约 150 个采样点，2 秒间隔），不持久化到磁盘。

---

## Docker Container

Server 上的 Docker 容器。Harbor 仅提供：**列出 / 查看日志 / start / stop / restart / exec 跳终端** 六类操作。不管理镜像、网络、卷、Compose。

---

## Remote Path

Server 上的文件系统路径。**必须经过 `RemotePath::try_new` 校验**才能用于 SFTP / 命令拼接，防止注入攻击。校验规则定义在 `crates/ssh-core`。

---

## 易混淆术语对照

| 术语 A | 术语 B | 区别 |
|---|---|---|
| Server | Workspace | Server 是数据模型（静态）；Workspace 是 UI 上下文（动态，某时刻最多一个激活）。 |
| Tab | Session | Tab 是 Workspace 内的 4 个功能视图之一；Session 是 Terminal Tab 内的多个 SSH 终端连接。 |
| Credential | SecretRef | Credential 是敏感数据本体（只在 Keychain）；SecretRef 是指向它的指针（可入 SQLite）。 |
| Group | Tag | v1 只有 Group（单层级、互斥）；没有 Tag（多对多）。 |

---

## 已删除术语（仅作历史参考）

以下术语曾存在于旧 OpsPilot 中，v1 重构后**不再使用**，代码与文档中不应再出现：

- **Agent / AgentRuntime / AgentBridge / AgentTool**：AI 助手相关（已完全移除）。
- **TaskEngine / OperationGateway / Approval**：AI 自治执行所需的任务引擎与审批网关（纯人工 UI 操作不需要）。
- **Audit**：操作审计（v1 自用工具不做）。
- **Project / ReleaseDeployer**：项目部署流水线（v1 不做）。
- **Nginx Site**：Nginx 站点管理（v1 不做）。
- **Tunnel**：SSH 隧道（v1 不做）。
- **WorkspacePage**：旧的"工作区页面"概念，已被新 Workspace 取代。
