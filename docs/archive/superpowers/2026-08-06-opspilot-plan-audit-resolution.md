# OpsPilot 计划审核处置记录

日期：2026-08-06  
最近复审：2026-08-07  
输入：外部《OpsPilot 实施计划审核报告》及《OpsPilot 计划修订版复审报告》  
范围：总路线图、01-06 子计划、TodoList、附属规格与已完成飞书计划

## 判定原则

- 只有能由计划原文、固化契约或上游官方能力证实的问题才回写。
- 修复入口/所有权/状态持久化等根因，不以增加一句“需要审批”掩盖跨层断裂。
- 浏览器 renderer、原生 Tauri 壳和真实远端 fixture 的测试证据分开命名。

## 审核条目处置

| 条目 | 判定 | 处置 |
|---|---|---|
| S1 写操作安全闭环 | 存在 | 固化唯一 `OperationGateway`；OperationPlan 改为 ToolCall 下游；02 建共享 ToolCall/Approval 持久化；03 注册 executor；04 动态注册写工具并复用共享入口。 |
| S2 TaskStatus/OperationPlan/hello/UI 契约漂移 | 存在 | 01 固化 9 状态与 snake_case fixture；OperationPlan 增加 IDs/digest/environment/scope；hello 明确私有 stdin token；UI 消费 confirmationText/L4。 |
| S2 契约一致性门 | 存在 | 新增 `pnpm contracts:check` 并进入 M0/CI/最终验收。 |
| S3 Playwright 驱动原生 Tauri | 存在，但“macOS 无自动化路径”已过时 | Playwright 限于 renderer；原生壳改用官方推荐的 WebdriverIO Tauri embedded provider，macOS/Windows 均驱动真实 binary。 |
| S3 workspace 默认触发 Docker 测试 | 存在 | 外部 fixture test 统一 feature-gated + ignored；`run-*.sh` 显式启动、探活、运行和清理。 |
| S3 M0 缺 Playwright/测试入口 | 存在 | 01 增加依赖、renderer/native 脚本、smoke spec，并把 integration/E2E/build 纳入 M0。 |
| S3 TOFU 无 verification_id | 存在 | Unknown 返回一次性、绑定目标、10 分钟过期的 verification_id；补过期/重放测试。 |
| S4 Mastra suspend 未持久化 | 存在 | Sidecar 配置 app-private LibSQL workflow storage；补杀进程后新实例 resume 测试。 |
| S4 审批挂起未持久化 | 部分存在 | Agent 计划已有 repository，但人工 Nginx/Compose 无共享所有权；现移到 02/03 Core 共享 repository，并补重启恢复。 |
| S4 真实 Agent run 无 API Key 注入 | 存在 | Rust 每次 run 从 SecretStore 读取，Sidecar 创建 run-scoped provider，终态清除并扫描存储/日志/事件。 |
| S4 Compose rollback 无基线设计 | 存在 | 03 保存 normalized config、image digest、service set、SecretRef key 与 health policy并真实恢复；06 只做强化故障矩阵。 |
| 01 初始化包名/交互命令 | 存在 | 不运行交互式 Tauri initializer，直接固定 Cargo/Tauri manifest 名称与 identifier。 |
| 01 append-only 仅口头约束 | 存在 | migration 增加阻断 audit UPDATE/DELETE 的触发器及直接 SQL 测试。 |
| 02 ssh_agent/certificate 缺实现任务 | 存在 | 增加系统 agent 与 OpenSSH certificate 解析/认证 fixture。 |
| 02 retry 与自动重放边界 | 存在 | retry 固定为用户动作、新 toolCallId/关联原调用；远端写不自动 retry/replay。 |
| 02 archive/extract 注入与逃逸 | 存在 | NUL 清单 + 静态 argv；staging、central-directory/link/device/realpath 校验后再落目标。 |
| 03 远端取消语义 | 存在 | 增加 Cooperative/StopAfterCurrentStep/NotCancelable；PID start token 校验；关闭 channel 不等于 kill。 |
| 03 Docker Task 粒度过大 | 存在 | 拆成只读传输/发现与写操作/Compose 两个独立任务。 |
| 03 `ss -H` 兼容 | 存在 | 按 `ss -H` → `ss` 去表头 → `netstat` 三段探测并加 fixture。 |
| 04 单文件 esbuild 可行性 | 未被计划证明 | 移除单 CJS 假设，采用 Rollup chunked ESM 与真实安装布局 bundle smoke，动态 chunk/native resource 缺失即阻断。 |
| 04 固定 30 秒超时 | 存在 | 改为 method-specific handshake/read/model idle/absolute/task-submit deadline。 |
| 04 Task 1 引用后置 AgentEvent | 存在 | Task 1 定义独立 AgentEventEnvelope，Task 4 再校验具体 payload。 |
| 05 5 个 E2E 文件未列入 Files | 存在 | 全部加入对应任务并移入 renderer 命名空间。 |
| 05 paste guard 前端判风险 | 存在 | 前端只按多行/控制字符/大小做统一传输提示，语义风险只显示 Rust 结果。 |
| 05 无桌面壳 build/native E2E | 存在 | M2 加 `tauri build --debug`、WebdriverIO native 与远端 external fixture 四组证据。 |
| 06 更新失败自动恢复旧 executable | 原计划无技术路径 | 增加 recovery bootstrap、上一版本签名包保留和受限签名降级；binary 完全不能启动时明确为人工恢复，不虚假承诺自动回退。 |
| 06 GitHub Intel runner 已退役/只能付费 | 不成立（当前官方有标准 `macos-15-intel`） | 固定使用 `macos-15-intel`；仓库不可用时发布门失败或配置受保护 x64 runner，不以交叉编译冒充原生验证。 |
| 06 三通道签名边界不清 | 表述有歧义 | stable/beta/nightly 使用独立 update key、manifest origin 和 Rust allowlist；OS code-sign identity 单独管理。 |
| 06 Adapter 只在 TS 校验风险 | 存在 | 增加 Rust manifest loader 校验；OperationGateway 每次 prepare 仍重算 Core risk。 |
| 附属已完成计划仍在 plans 根目录 | 存在 | 移入 `plans/archive/` 并加“不得派发”归档标记。 |
| 按“第 20 节”引用会漂移 | 存在 | 全部改为按标题“`## 20. MVP 验收标准`”匹配。 |
| M1 依赖/冷启动/100+ 容量/广播安全测试 | 存在或验收不充分 | M1 拆 M1a/M1b；2 秒只到 AppShell、Sidecar 单计；固定容量/并发/背压预算；广播输入增加专门测试。 |

## 修订版复审处置（2026-08-07）

| 条目 | 判定 | 处置 |
|---|---|---|
| 06 export/monitoring 同命令过滤 | 存在，开工前阻断 | 拆为 `cargo test -p opspilot-export` 与 `cargo test -p opspilot-remote-adapters monitoring`，确保错误口令、ciphertext 篡改等 export 用例实际运行。 |
| 01 Vite/App.tsx 文件链 | 存在，开工前阻断 | Task 1 补齐 index.html、Vite config、三份 tsconfig、App.tsx 与 vite-env；Task 5 的 Modify 现在有明确创建者。 |
| 04 越权误用 ApprovalMismatch | 存在，开工前阻断 | 01 新增 `TOOL_SCOPE_VIOLATION`；跨 server/project scope 在 schema/approval 前 fail closed，ApprovalMismatch 仅保留给 approval/digest/目标不一致。 |
| confirmedResource/confirmationText 关系 | 存在，开工前阻断 | PreparedOperation/ApprovalRequest 新增不可变 confirmationTarget；confirmationText 仅展示，approve 只比较 confirmedResource 与 confirmationTarget。 |
| 02 前端乱序测试放在 contracts | 存在 | 02 只验 Rust/TS fixture 序列化；05 Task 1 新建真实 SequenceTracker reducer 测试，并覆盖 old/gap/reconnect/retention gap。 |
| run-ssh 未挂默认 integration | 字面存在，但直接挂入不成立 | 默认 `test:integration` 的无 Docker 契约必须保留；新增 `test:integration:external:ssh`、`test:integration:external` 和 `test:integration:all` 显式聚合入口。 |
| importId preview 暂存语义 | 存在 | 固定为 session 隔离的进程内有界 LRU：15 分钟 TTL、10 import/10,000 行、源摘要绑定、一次性消费、重启失效。 |
| 02 Gateway 风险引擎与 L4 | 存在 | 02 Task 5 创建唯一 RiskEvaluator 并从 ServerRepository 取得 environment/scope；L4/未知分类返回 Blocked，零 Approval/Task/Snapshot；03 只扩展策略。 |
| 03 健康检查器无生产者 | 存在 | 03 Task 4 创建 HealthChecker/HealthCheckPolicy/契约与测试；03 Task 7 和 06 Task 1 改为消费/强化。 |
| 远端 Unix socket 隧道归属 | 存在 | 02 Task 6 生产进程内 UnixSocketForwarder/direct-streamlocal；03 Docker 只消费，能力不支持才回退 CLI，禁止 TCP daemon/socat。 |
| 04 rollback/竞争/失败回馈矩阵 | 存在 | Task 5-6 加入三类 rollback、approve/cancel 两种线性化顺序和 TaskEngine 全终态回馈 workflow；完成检查增加零重复执行证据。 |
| 04 跨计划修改 operation.rs | 存在 | 04 Task 5 移除该文件和提交项；总路线图明确等待 02/03 所有权任务，只在 agent-bridge 注册既有 executor。 |
| 05 sequence 空洞和重订阅 | 存在 | 增加 subscribe-and-buffer → replay/refetch → merge/dedupe；task event 补拉由 03 提供，状态流 Query 重同步，终端不可补拉时显式标记缺段。 |
| 06 HealthCheckPolicy deadline | 存在 | 03 baseline 与 06 强化结构统一增加 deadline；单次 timeout 不得越过剩余 deadline。 |
| 06 通知 capability | 存在 | 文件清单加入 plugin Cargo/TS/lib/capability/test；只授予 permission check/request/notify/listener，不使用 notification:default。 |
| 06 mobile E2E config | 存在 | 新建独立 mobile Playwright config/output/snapshot/webServer 和 `test:e2e:mobile`，不继承 renderer/Tauri fixture。 |
| 06 SBOM 工具未指定 | 存在 | 固定 cargo-cyclonedx 0.5.9 与 cdxgen 12.3.1；为 Rust、pnpm workspace、各 target 解包安装包生成并验证 CycloneDX。 |
| 02/03/04 缺静态检查步骤 | 存在 | 01 新建 `pnpm verify:static`；三份计划将它设为每个 Task 行为测试后、提交前的强制步骤。 |
| local Mastra 规格版本/审计锚点 | 存在 | 规格升 1.1.1，固化 toolCallId/runId/schemaVersion 等审计字段，并规定与 V1.1/路线图/04/处置记录同 PR 同步。 |
| Todo 后缀编号 | 存在 | `BETA-02a` 改为 `BETA-09`，`FINAL-05a` 改为 `FINAL-07`。 |
| 0002 migration/toolchain/environment | 存在 | 指定 secret_refs schema/禁止字段/清理顺序；Rust 固定 1.97.1；environment 区分环境变量映射与部署环境标签。 |
| 缺 test:e2e 旧别名 | 存在 | 保留 renderer/native 分层脚本，并增加兼容聚合 `test:e2e`；总路线图说明聚合顺序。 |

## 上游能力依据

- Tauri WebDriver：<https://v2.tauri.app/develop/tests/webdriver/>（WebdriverIO Tauri service embedded provider 支持 macOS/Windows；直接 tauri-driver 仍只支持 Windows/Linux）。
- Mastra Workflow snapshots：<https://mastra.ai/en/reference/workflows/snapshots>（suspend snapshot 需要配置 storage，LibSQL 可跨进程恢复）。
- Mastra bundling：<https://mastra.ai/blog/seamless-edge-deployments>（官方构建说明使用类 Rollup 的分析/预打包；因此计划不再假设任意 esbuild 单 CJS 一定可行）。
- Tauri Updater：<https://v2.tauri.app/plugin/updater/>（支持签名、运行时 pubkey 与自定义 version comparator；应用仍需自行设计失败恢复流程）。
- GitHub-hosted runner：<https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job>（当前标准 Intel label 包含 `macos-15-intel`）。
- Rust release notes：<https://doc.rust-lang.org/stable/releases.html>（`rust-toolchain.toml` 固定 1.97.1）。
- Tauri notification permissions：<https://v2.tauri.app/plugin/notification/>（只启用本计划实际使用的 notify/permission/listener 权限）。
- russh direct-streamlocal：<https://docs.rs/russh/latest/russh/client/struct.Handle.html>（02 的 Unix socket owner 可直接建立 `direct-streamlocal@openssh.com` channel 并转换为进程内 stream）。
- CycloneDX Rust Cargo：<https://github.com/CycloneDX/cyclonedx-rust-cargo/releases>；cdxgen：<https://github.com/cdxgen/cdxgen>（固定版本生成 Rust、pnpm 与安装包 SBOM）。
