# OpsPilot 项目 TodoList

状态：未开始  
依据：[项目总实施路线图](./2026-08-06-opspilot-master-roadmap.md)  
完成规则：只有对应计划中的测试、回归和验收证据齐全后才能勾选；“代码已写”不算完成。

## M0 / FND：基础设施与安全底座

- [ ] FND-01 初始化 Git、`pnpm workspace`、Cargo workspace 和 `feat/p0-foundation` 分支。
- [ ] FND-02 固定 Node.js 24 LTS、Corepack/pnpm、Rust 1.97.1 与 lockfile 策略。
- [ ] FND-03 创建 React/Vite 桌面应用、Tauri 2 壳和最小 Capability。
- [ ] FND-04 建立 `packages/contracts` 的 ID、错误、事件、风险、完整 TaskStatus、ToolCall 和 DTO 契约。
- [ ] FND-05 建立 Rust `domain` crate，并用 `pnpm contracts:check` 通过 TS/Rust 双向 fixture（含 9 个 TaskStatus）测试。
- [ ] FND-06 建立 SQLite migration、WAL、外键和迁移前备份。
- [ ] FND-07 建立系统凭据库抽象，证明秘密不落 SQLite。
- [ ] FND-08 建立字段级脱敏、审计写入、阻断 audit UPDATE/DELETE 的触发器和敏感日志扫描。
- [ ] FND-09 建立 macOS/Windows CI 的 lint、typecheck、unit、Rust test、clippy、Playwright renderer、Tauri debug build 和 WebdriverIO native E2E。
- [ ] FND-10 通过 M0 全局验证门并保存输出。

## M1 / CON：服务器、安全连接、终端与文件

- [ ] CON-01 实现服务器 CRUD、分组、标签和输入校验。
- [ ] CON-02 实现密码、私钥、ssh-agent、OpenSSH certificate 与 `secret_ref` 认证配置和各自 fixture。
- [ ] CON-03 实现带一次性/过期 `verification_id` 的 TOFU 指纹确认、known_hosts 持久化和变化阻断。
- [ ] CON-04 实现 SSH 连接状态机、KeepAlive、连接池和手动重连。
- [ ] CON-05 实现 Shell Channel、PTY resize、终端输入输出和会话隔离。
- [ ] CON-06 建立最小 OperationGateway/ToolCall/Approval 持久化，并让 SFTP 浏览、上传、下载、取消、显式重试、哈希与冲突策略全部经过该入口。
- [ ] CON-07 实现本地/远程/SOCKS 转发的结构化规则与端口冲突检查。
- [ ] CON-08 实现系统 OpenSSH 回退，禁止副作用命令自动重放。
- [ ] CON-09 Docker SSH fixture 覆盖密码、密钥、跳板、断线和指纹变化。
- [ ] CON-10 在 Agent/模型关闭时重新运行连接集成测试。

## M1-M2 / OPS：任务引擎与运维适配器

- [ ] OPS-01 扩展唯一 OperationGateway，实现 Task/Step 状态机、三类取消能力、显式重试、Interrupted 恢复和 ID/digest/scope 一致性。
- [ ] OPS-02 实现 Snapshot、校验和、原子写入、恢复和审计关联。
- [ ] OPS-03 实现 L0-L4 风险策略与不可变参数摘要。
- [ ] OPS-04 实现 Linux capability 探测、CPU/内存/磁盘/网络指标。
- [ ] OPS-05 实现 systemd 服务与监听端口只读/受控写操作。
- [ ] OPS-06 实现项目模型、检测器和通用命令/Docker Compose 项目。
- [ ] OPS-07 实现部署计划、release 目录、health check 和回滚。
- [ ] OPS-08 实现 Docker 容器列表、操作、日志、Exec 与 stats。
- [ ] OPS-09 实现 Compose config Diff、up/down/restart/pull/build，并保存 config/image digest/service set 后验证回滚。
- [ ] OPS-10 实现 Nginx discover/read/plan/validate/apply/rollback 全流程。
- [ ] OPS-11 对命令注入、路径穿越、符号链接、sudo 和 Docker 权限做安全测试。
- [ ] OPS-12 故障注入验证写操作失败不会留下半应用状态。

## M1-M2 / AGT：Mastra Agent、工具与审批

- [ ] AGT-01 构建 Agent runtime bundle，并由 Rust 启动官方 Node 24 Sidecar runtime。
- [ ] AGT-02 完成 JSONL stdio IPC、session token、版本握手、心跳和关闭协议。
- [ ] AGT-03 实现 Provider Profile、API Key 凭据引用、连通性测试和真实 agent.run 的 run-scoped key 注入/清除。
- [ ] AGT-04 实现上下文裁剪与服务器/日志/配置字段级脱敏。
- [ ] AGT-05 注册至少一组 L0 状态工具，Rust 二次校验 schema 与 server scope。
- [ ] AGT-06 实现 Agent thread/run、token/plan/tool 事件流和结果总结。
- [ ] AGT-07 从 Rust catalog 注册文件/systemd/项目/Docker/Nginx 写工具，复用共享 OperationGateway 实现 L1/L2 审批、拒绝零副作用和参数摘要绑定。
- [ ] AGT-08 实现 L3 二次确认、资源名、强制快照与回滚引用。
- [ ] AGT-09 用 app-private LibSQL 持久化 Mastra Workflow snapshot，实现杀死 Sidecar 后 suspend/resume 与 Rust 状态查询恢复。
- [ ] AGT-10 实现模型断网、限流、超时、Key 失效与 Sidecar 崩溃降级。
- [ ] AGT-11 安全测试提示词注入、工具参数注入、跨服务器越权和审批绕过。
- [ ] AGT-12 在 Sidecar 重启后证明写操作不自动重放。

## M2 / UI：桌面工作区与 E2E

- [ ] UI-01 建立设计 token、左侧导航、全局服务器切换和任务状态区。
- [ ] UI-02 实现服务器总览页，对齐桌面设计稿图 15-1。
- [ ] UI-03 实现服务器管理页和指纹确认，对齐图 15-2。
- [ ] UI-04 实现多标签/分屏终端、无语义风险判定的粘贴保护、广播输入默认关闭/持续目标提示和链接处理，对齐图 15-3。
- [ ] UI-05 实现 SFTP 双栏、Monaco 预览、保存前 Diff 和传输任务。
- [ ] UI-06 实现项目工作区和部署时间线，对齐图 15-4。
- [ ] UI-07 实现 Docker 工作区，对齐图 15-5。
- [ ] UI-08 实现 Nginx 计划/Diff/校验/回滚工作区，对齐图 15-6。
- [ ] UI-09 实现 Agent 对话、计划、审批和 Trace 工作区，对齐图 15-7。
- [ ] UI-10 实现任务中心、审计、设置、诊断与降级状态。
- [ ] UI-11 完成键盘、焦点、对比度、缩放和生产环境持续标识检查。
- [ ] UI-12 分开保存 Playwright renderer、WebdriverIO Tauri native 与 Rust external-fixture 证据，跑通添加服务器至 Agent 审批/Nginx 回滚的 MVP 主路径。

## M3 / BETA：可靠部署、监控与发布

- [ ] BETA-01 完成 release/current 部署、Compose 版本和回滚故障注入。
- [ ] BETA-02 完成健康检查、资源曲线、阈值和应用打开期间桌面告警。
- [ ] BETA-09 通过 100 metadata/16 transports/32 terminal channels/8 polling workers 的容量与背压预算。
- [ ] BETA-03 完成加密导出/导入；默认排除秘密，敏感导出要求独立口令。
- [ ] BETA-04 完成诊断包预览，证明不含凭据和未脱敏日志。
- [ ] BETA-05 在 Apple Silicon、`macos-15-intel`、Windows x64 原生 runner 构建并运行 Sidecar/bundle smoke；缺 runner 时发布门失败。
- [ ] BETA-06 建立 SBOM、依赖审计、签名、notarization/AuthentiCode，以及 stable/beta/nightly 独立 update key/manifest allowlist。
- [ ] BETA-07 验证安装、卸载、升级、数据库迁移失败、recovery bootstrap 签名降级和 binary 不可启动时的人工恢复安装器。
- [ ] BETA-08 逐条关闭设计文档标题“`## 20. MVP 验收标准`”（按标题匹配）的验收差距。

## M4 / MOBILE：移动设计验证（非 MVP 发布）

- [ ] MOB-01 为 7 张移动设计稿建立 viewport fixture 和 Storybook/Playwright 页面。
- [ ] MOB-02 覆盖首页、服务器、终端、项目、Docker、Nginx、Agent 7 个响应式视图。
- [ ] MOB-03 验证触控目标、软键盘、安全区、横竖屏、网络中断和无障碍。
- [ ] MOB-04 形成移动端凭据、SSH、Agent 位置、同步、丢失设备和撤销威胁模型。
- [ ] MOB-05 在威胁模型批准前禁止发布带写权限的移动客户端。

## P3-P4 / EXT：明确延后但需闭环的工作

- [ ] EXT-01 定义版本化 Adapter API，并以一个只读证书探测适配器验证隔离。
- [ ] EXT-02 定义计划任务安全模型，禁止任务绕过现有 RiskDecision/Approval。
- [ ] EXT-03 为证书自动化编写 ACME 凭据、DNS Provider 和回滚规格。
- [ ] EXT-04 为 E2EE 同步编写设备身份、密钥轮换、冲突与撤销规格。
- [ ] EXT-05 为团队版编写 tenant、RBAC、审批、审计保留和密钥托管规格。
- [ ] EXT-06 上述规格分别通过 brainstorming 与安全评审后，再创建独立实施计划。

## 最终交付检查

- [ ] FINAL-01 所有计划无 `TBD`、`implement later`、含糊“补充测试”等占位文本。
- [ ] FINAL-02 `pnpm contracts:check` 证明 TS/Rust/SQLite 中 ID、9 个状态、风险、错误码和事件名一致。
- [ ] FINAL-03 全部自动测试、lint、typecheck、clippy、build 有本次运行的新鲜证据。
- [ ] FINAL-04 14 张设计稿均映射到实现或明确的非 MVP 验证任务。
- [ ] FINAL-05 所有秘密泄漏、安全审批、主机指纹和回滚验收均有失败路径测试。
- [ ] FINAL-07 所有远端写操作均能由 audit 反查同一 ToolCall/run/digest/Approval/Snapshot/Task，且无直达 executor command。
- [ ] FINAL-06 macOS 与 Windows 安装包证据、迁移记录、SBOM 和发布说明齐全。
