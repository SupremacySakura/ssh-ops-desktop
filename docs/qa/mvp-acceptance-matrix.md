# OpsPilot MVP 验收矩阵

证据日期：2026-08-08（Asia/Shanghai）

状态定义：`PASS` 表示当前仓库内已有匹配层级的自动证据；`PARTIAL` 表示代码路径已实现，但仍缺真实远端、原生安装或双平台人工证据；`BLOCKED` 表示需要仓库外的证书、账号或运行环境。

| # | MVP 验收项 | 状态 | 当前证据 | 尚需发布前补齐 |
|---|---|---|---|---|
| 1 | macOS/Windows 安装启动；服务器创建、编辑、分组、删除 | PARTIAL | `server-list-page.test.tsx`；`server_repository.rs`；双平台 CI 配置 | Windows 原生安装/卸载记录；签名候选包 |
| 2 | 密码与私钥认证；秘密不进入 SQLite、日志、导出 | PARTIAL | `ssh-core/tests/auth.rs`；`persistence/tests/server_credentials.rs`；`model.rs` secret-store 测试；审计脱敏测试 | 密码/私钥 Docker SSH external fixture；导出功能不属于当前 MVP 代码路径 |
| 3 | TOFU 首次确认；主机密钥变化阻断 | PASS | `ssh-core/tests/known_hosts.rs`；`server-list-page.test.tsx` | 发布候选包上的人工指纹核对 |
| 4 | 多标签交互终端、缩放、复制粘贴、断线提示、手动重连 | PARTIAL | xterm.js + FitAddon；`ssh-core/tests/terminal.rs`；`terminal-page.test.tsx`；序号/缺段处理测试 | 真实 SSH 断线、剪贴板和 Windows WebView2 人工检查 |
| 5 | SFTP 浏览、上传、下载、编辑、保存前 Diff | PARTIAL | `file-manager-page.test.tsx`；`ssh-core/tests/sftp.rs`；`file.write` 冲突检查/原子替换 | 真实 SFTP 大文件、断线与权限失败 fixture |
| 6 | CPU、内存、磁盘、系统信息、服务、端口状态 | PARTIAL | `remote-adapters/tests/linux_parsing.rs`；`dashboard-page.test.tsx` | 主流 Linux external fixture |
| 7 | Docker Compose/通用项目；状态、日志、部署任务 | PARTIAL | `project-page.test.tsx`；`deploy_workflow.rs`（release 回滚、Compose validate/up） | Compose 真实远端状态/日志视图；失败注入 fixture |
| 8 | Docker 容器列表、启停重启、日志、stats、Exec | PARTIAL | `docker-page.test.tsx`；`docker_parsing.rs`；隔离 PTY Docker Exec；OperationGateway 容器写操作 | 真实 Docker CLI fixture；distroless 容器无 `sh` 的人工提示验证 |
| 9 | Nginx 编辑、Diff、语法校验失败不覆盖 | PASS | `nginx-page.test.tsx`；`remote-adapters/tests/nginx_plan.rs` | 真实 Nginx/sudo fixture |
| 10 | 耗时操作进入任务中心；明确失败；Nginx/发布回滚 | PARTIAL | `task_repository.rs`；`task-center.test.tsx`；Nginx 与 release 故障注入测试 | 当前 OperationGateway 执行提交仍为同步 IPC；需真实长任务/取消体验证据 |
| 11 | Base URL/API Key/Model；连通测试；API Key 不进 SQLite/日志/WebView 状态 | PASS | `model_profiles.rs`；`model.rs`；`model-settings.test.tsx`；Sidecar model.test | 真实 Provider 凭据人工检查 |
| 12 | Mastra Agent 解释服务器状态、计划、Rust L0 工具与审计 | PARTIAL | Mastra 1.x runtime；LibSQL store；真实 OS/metrics/ports/services 上下文；`bundled_runtime.rs` 两轮 Tool fixture；Agent 审计 | 真实 Provider + SSH 联合 fixture；token/stream 事件尚未形成完整对话时间线 |
| 13 | Agent 写操作暂停审批；拒绝零副作用；L3 二次确认与快照 | PARTIAL | `task-engine/tests/gateway.rs`、`risk.rs`；`agent-page.test.tsx`；Nginx L3 目标确认/备份恢复 | 通用 SnapshotRef 尚未由 SQLite Gateway 持久化；Agent 审批后的 workflow resume 属后续可靠性工作 |
| 14 | 模型/Key/Sidecar 异常降级，人工功能可用 | PARTIAL | Agent 降级 UI 测试；Sidecar 握手/超时/错误映射；人工模块与 Agent 解耦 | Sidecar crash-loop watchdog 与真实断网/401/429 external fixture |

## 本次自动门禁

- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm test`：通过（修复工作区 smoke 基线后）。
- `cargo fmt --check`：通过。
- `cargo clippy --workspace --all-targets -- -D warnings`：通过。
- `cargo test --workspace`：通过（含本地 loopback Mastra fixture）。
- `pnpm tauri build --debug --no-bundle`：通过。

## 发布门外部依赖

- 必须在 Node.js 24 环境生成并打包 Node Sidecar；构建脚本会按 Rust target 自动复制当前 Node runtime 与对应 LibSQL 原生模块。
- macOS Developer ID/notarization 与 Windows Authenticode 证书不在仓库内，签名证据只能由受保护的发布环境生成。
- 真实 SSH/SFTP/Docker/Nginx external fixture 与双平台安装检查不得用 renderer/unit 证据替代。
