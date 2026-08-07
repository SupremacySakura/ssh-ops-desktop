# SSH 服务器运维桌面软件：完整产品与技术设计文档

项目代号：SSH Ops Desktop（暂定）

文档版本：V1.1｜日期：2026-08-06｜定位：macOS / Windows 本地优先、AI Agent 驱动的 SSH 与服务器项目管理工具

## 0. 执行摘要

本产品是一款运行在 macOS 与 Windows 上的桌面运维软件，核心能力是统一管理 Linux 服务器、SSH 终端、远程文件、项目部署、Docker 与 Nginx。产品始终内置运行于桌面端本地的 Mastra AI Agent：Agent 通过用户配置的远程大模型 API 辅助分析、规划与运维，实际服务器操作由 Rust Core 通过 SSH/SFTP 和类型化工具受控执行；受管服务器无需安装常驻 AI Agent。

- 目标用户：个人开发者、独立开发者、小型研发团队、需要管理多台云服务器的前端/全栈工程师。

- 核心价值：将 AI 辅助诊断与操作、终端、文件管理、项目部署、容器管理、反向代理配置和服务器监控放进同一个安全工作台。

- MVP 闭环：配置远程模型 → 添加服务器 → 安全连接 → Agent 分析并生成计划 → 用户审批写操作 → 执行终端/文件/部署/Nginx 操作 → 查看结果与审计 → 必要时回滚。

- 推荐技术：Tauri 2 + React/TypeScript + 本地 Mastra Sidecar + Rust Core + SQLite + OS 安全凭据存储 + xterm.js。

- 关键原则：不保存明文密码；严格校验主机指纹；所有高风险操作先预览、再校验、后执行，并提供审计与回滚。

## 1. 产品背景与定位

现有 SSH 客户端擅长终端连接，但通常缺少项目、Docker、Nginx 和部署管理；服务器面板类产品能力丰富，但需要在服务器安装长期运行的管理面板，并暴露额外端口。该产品位于二者之间：以桌面端为控制中心，以 SSH 为默认通道，不要求服务器暴露新的公网管理端口。

产品不是第一天就复刻完整宝塔，而是先解决开发者最频繁的服务器运维链路，再通过适配器与插件逐步扩展数据库、中间件、证书、定时任务和团队协作。

## 2. 设计假设与范围

首个正式版本以管理 Linux 服务器为主，客户端运行于 macOS 与 Windows。远程 Windows Server、Kubernetes 集群、数据库可视化管理、多租户团队权限和云端持续告警暂不进入 MVP。

产品默认本地单用户使用，不依赖账户体系或云端后端；服务器资料存储在本机 SQLite，密码、私钥口令和令牌存储在系统安全凭据库。后续可增加端到端加密的跨设备同步。

## 3. 目标用户与核心场景

核心用户包括个人开发者、独立站长、小型团队的全栈工程师、管理多台测试/生产服务器的研发人员，以及希望用图形化方式管理 Docker 与 Nginx、但又不愿安装重型服务器面板的用户。

最高频场景包括：快速切换多台服务器；在多标签终端执行命令；上传/编辑配置文件；查看服务器资源；管理 Docker Compose 项目；创建 Nginx 站点与反向代理；拉取代码并部署；查看应用日志；在变更失败时恢复上一版本。

## 4. 技术路线对比与推荐

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| Tauri 2 + React + Rust | 安装包与内存占用较低；Rust 适合实现 SSH、并发任务和安全边界；Capability 可限制前端权限 | Rust 学习与调试成本更高；部分生态需要自行封装 | 推荐 |
| Electron + React + Node.js | 开发速度快；Node SSH/PTY 生态成熟；团队前端经验可直接复用 | 包体和内存更大；主进程、预加载与渲染进程安全边界要求高 | 适合快速原型 |
| Swift + WinUI 双原生 | 系统体验和平台能力最好 | 两套代码、两套团队、维护成本最高 | 不适合第一阶段 |

推荐采用 Tauri 2。前端只负责 UI 与状态展示，所有 SSH、文件系统、凭据、命令执行和更新能力都由 Rust Core 暴露为最小权限命令。为兼容复杂的 ~/.ssh/config、硬件密钥或 ProxyCommand，可保留系统 OpenSSH 回退通道。

## 5. 总体架构

系统由桌面 UI、本地 Mastra Agent Sidecar、安全 IPC 桥接、Rust Core、本地数据层、SSH 连接引擎和远程执行层组成。Mastra Agent 是桌面产品的必选组成部分，通过 Base URL、API Key 与 Model 调用远程大模型；Rust Core 向 Agent 暴露类型化白名单工具，并负责参数校验、风险判定、审批门禁、快照、SSH/SFTP 执行和审计。受管服务器保持无常驻 AI Agent，不需要开放额外公网管理端口。

## 6. 产品功能架构

- AI 运维 Agent：自然语言对话、服务器状态解释、故障诊断、操作计划、工具调用、审批、结果总结、会话记忆和可追溯审计。

- 服务器管理：分组、标签、批量导入、连接测试、主机指纹、跳板机、代理、收藏与最近使用。

- SSH 终端：多标签、分屏、会话恢复、命令片段、广播输入、搜索、复制、主题、端口转发。

- 远程文件：SFTP 双栏、上传下载、断点续传、编辑、权限、压缩解压、目录搜索。

- 服务器概览：系统信息、CPU、内存、磁盘、网络、负载、服务、端口、用户与安全提示。

- 项目管理：项目模型、代码仓库、运行方式、部署流程、环境变量、域名、日志、健康检查和回滚。

- Docker：容器、镜像、网络、卷、Compose Stack、日志、Exec、资源统计和清理。

- Nginx：站点、反向代理、静态站点、HTTPS、配置编辑、语法校验、平滑重载和历史版本。

- 任务与审计：任务队列、进度、取消、重试、操作记录、失败原因和变更快照。

- 设置与备份：模型 Base URL/API Key/Model、主题、终端偏好、默认命令、代理、数据导入导出、自动更新、隐私和诊断日志。

## 7. 详细功能设计

### 7.1 服务器管理

服务器卡片展示名称、环境、IP/域名、系统、在线状态、延迟、最近连接时间和风险提示。支持按环境、业务、地域、云厂商和负责人标签筛选。

连接配置包括 Host、Port、Username、认证方式、私钥引用、跳板机链、代理、连接超时、KeepAlive、字符编码和默认工作目录。支持读取 ~/.ssh/config，但导入后仍需显式确认主机指纹。

主机指纹采用 TOFU + 明确确认策略：首次连接展示算法与指纹；发生变化时默认阻断连接，禁止使用“静默接受全部主机密钥”。

### 7.2 SSH 终端

使用 xterm.js 渲染终端，Rust 侧维护 SSH Channel、PTY 尺寸和输入输出流。每个终端标签对应独立 Session，可在同一服务器上复用底层连接，也可隔离为独立连接。

支持多标签、左右/上下分屏、重命名、固定标签、会话搜索、URL 识别、命令历史、常用片段、粘贴保护和大段文本确认。广播输入必须有醒目的目标服务器提示，默认关闭。

端口转发支持本地转发、远程转发和动态 SOCKS；转发规则可保存为服务器模板，并展示实时连接数和占用端口。

### 7.3 远程文件管理

提供本地/远程双栏文件管理器和服务器内单栏模式。操作包括上传、下载、拖拽、重命名、移动、复制、删除、权限修改、所有者修改、压缩、解压和软链接识别。

文本文件通过 Monaco Editor 打开，支持语法高亮、编码识别、换行符提示、保存前 Diff、远程文件版本快照。大文件默认只预览部分内容，日志文件使用流式 tail。

传输任务进入统一任务中心，支持并发限制、失败重试、断点续传、哈希校验和冲突处理。

### 7.4 服务器概览与系统管理

概览展示系统版本、内核、架构、运行时长、CPU/内存/磁盘/网络、Load Average、inode、时间同步和可用更新提示。指标由 Rust Core 通过 SSH 和远端适配器按需或定时采集；本地 Mastra Agent 可解释异常、关联日志并提出后续检查建议，但不直接绕过采集与权限边界。

服务管理覆盖 systemd 服务列表、状态、启动、停止、重启、开机自启和日志查看。端口页面展示监听端口、进程、协议与地址，并允许跳转到对应服务或容器。

涉及用户、SSH 配置、防火墙和系统升级的功能作为高级模块，默认只读；写操作需要二次确认和备份。

### 7.5 项目管理

项目是产品的核心业务对象，不等同于一个目录。项目绑定服务器、根目录、源码仓库、运行类型、部署策略、环境变量、域名、健康检查、日志源和回滚策略。

内置项目类型：Docker Compose、静态站点、Node.js、Go、Python、通用命令。每种类型提供默认检测逻辑和部署模板，但所有命令均可审阅和修改。

项目详情页包含状态概览、部署、环境变量、日志、进程/容器、域名、文件、任务历史和设置。

### 7.6 Docker 管理

Docker 模块优先通过 SSH 隧道访问远端 Docker Engine API，并根据服务端 API 版本协商；无法访问 API 时回退到 docker CLI 适配器。不得直接将 Docker TCP API 暴露到公网。

容器功能包括列表、筛选、启动、停止、重启、删除、Exec、日志、Inspect、统计、端口和挂载查看。镜像支持拉取、构建、删除、历史和磁盘占用；网络与卷支持查看、创建和清理。

Compose Stack 支持识别 compose.yaml、展示服务拓扑、up/down/restart/pull/build、查看合并配置、变更 Diff 和失败日志。破坏性清理操作默认不批量勾选。

### 7.7 Nginx 管理

Nginx 模块先探测二进制、主配置路径、include 路径与发行版目录结构，再生成站点索引。既支持结构化表单，也支持源码编辑；无法可靠解析的配置只进入源码模式。

新增或修改配置时必须执行：保存临时文件 → 展示 Diff → nginx -t 校验 → 原子替换 → 平滑 reload → 健康检查。任一步失败都恢复上一个版本。

支持反向代理、静态站点、WebSocket、基础缓存、上传限制、访问日志、错误日志、HTTP 到 HTTPS 跳转和常用安全头。复杂 Lua/OpenResty 配置仅提供编辑与校验，不做错误的结构化抽象。

### 7.8 任务中心与审计

所有耗时操作统一抽象为 Task：等待、运行、成功、失败、取消、回滚中、已回滚。任务包含服务器、项目、风险级别、步骤、日志、开始/结束时间和关联快照。

审计日志记录“谁在何时对哪台服务器做了什么”，本地单用户模式中的“谁”为本机配置身份。敏感字段、密码、Token 和私钥内容必须脱敏。

任务支持取消和重试，但需区分可安全重试与不可安全重试；例如文件上传可重试，数据库迁移或删除操作不能盲目重试。

### 7.9 监控与告警

MVP 提供应用打开期间的资源曲线和桌面通知，不承诺应用关闭后的持续告警。本地 Mastra Agent 可分析指标、日志和健康检查结果并建议处理动作；应用关闭后的长期监控属于未来云端通知中继能力，不依赖在服务器安装 AI Agent。

可配置 CPU、内存、磁盘、负载、容器退出、项目健康检查失败和证书到期阈值。告警需带服务器、项目、指标、当前值、持续时间和建议动作。

### 7.10 设置、备份与诊断

设置包含模型 Provider、Base URL、API Key、Model、连通性测试、外观、终端字体、快捷键、默认 Shell、SSH KeepAlive、并发任务数、代理、更新通道、日志级别和隐私选项。API Key 只存入系统安全凭据库，界面仅显示脱敏状态。

支持加密导出服务器元数据和项目配置。默认不导出密码、私钥和令牌；用户显式选择导出敏感数据时，必须设置独立加密口令。

诊断包包含应用版本、操作系统、非敏感配置、崩溃日志和最近错误，生成前提供内容预览。遥测默认关闭，若启用也只收集匿名稳定性指标。

### 7.11 AI 运维 Agent

Mastra Agent 作为桌面端本地 Sidecar 随应用安装和启动，负责意图理解、计划生成、工具选择、Workflow 编排、会话记忆和结果总结。React/WebView 只负责对话、计划预览、审批、进度与结果展示，不直接持有模型密钥、SSH 凭据或任意 Shell 权限。

首版模型配置采用供应商无关的 Base URL + API Key + Model，优先兼容 OpenAI-compatible 接口，并为 Anthropic、Gemini 等原生 Provider 保留适配层。模型不可达、Key 失效、额度不足或网络中断时，AI 功能进入可解释的降级状态，终端、文件、Docker、Nginx、任务和审计等人工功能仍可使用。

Agent 只能调用 Rust Core 注册的类型化白名单工具。开放式诊断与分析使用 Agent 推理；部署、Nginx 变更、Docker 清理和回滚等确定性任务使用可暂停、审批和恢复的 Workflow。只读工具可自动执行；写操作必须展示计划与影响范围；高风险操作必须二次确认、输入资源名、生成快照并保留回滚路径。

风险等级由 Rust Core 的确定性策略计算，大模型不能降低风险等级或绕过审批。每次工具调用记录会话、目标服务器、工具、参数摘要、风险、审批、结果和快照引用；发送给远程模型的日志、配置和命令结果按最小上下文原则裁剪并脱敏。

## 8. 项目模型与部署体系

项目建议采用“检测器 + 运行适配器 + 部署工作流”三层设计。检测器识别 package.json、go.mod、requirements.txt、Dockerfile、compose.yaml 等；运行适配器负责进程状态和日志；部署工作流负责源码、构建、发布、健康检查与回滚。

- 项目基础字段：id、server_id、name、environment、root_path、runtime_type、repository_url、branch。

- 运行字段：start_command、stop_command、restart_command、process_manager、service_name、compose_file。

- 发布字段：deploy_strategy、build_command、release_root、current_symlink、keep_releases、pre/post hooks。

- 网络字段：domains、internal_port、health_check_url、nginx_site_id、certificate_id。

- 可观测字段：log_sources、metrics_source、last_deploy_id、last_healthy_at。

推荐发布策略：

- 原地更新：适合开发环境，流程简单，但回滚能力弱。

- Release 目录 + current 软链接：每次发布创建独立版本目录，健康检查通过后切换软链接；推荐用于 Node/Go/Python。

- Docker Compose：以镜像标签和 Compose 配置版本作为发布单元；回滚到上一镜像标签与配置快照。

- 静态站点：构建到新目录后原子切换站点根目录或软链接。

## 9. 推荐技术栈

| 层级 | 推荐技术 | 用途 |
|---|---|---|
| 桌面容器 | Tauri 2 | 跨平台窗口、系统集成、签名更新、最小权限桥接 |
| 前端 | React + TypeScript + Vite | 桌面 UI 与业务交互 |
| 路由/请求 | TanStack Router / Query | 路由、缓存、异步状态 |
| 本地状态 | Zustand | 会话、布局、选择态、终端标签 |
| UI | Tailwind CSS + shadcn/ui（或自研组件层） | 高密度桌面管理界面 |
| 终端 | xterm.js + fit/search/web-links addons | 终端渲染与交互 |
| 编辑器 | Monaco Editor | 远程配置与代码文件编辑 |
| 图表 | ECharts | 资源监控与任务趋势 |
| 核心运行时 | Rust + Tokio | SSH、并发、任务、文件与安全边界 |
| SSH | russh 为主；系统 OpenSSH 回退 | Shell、Exec、SFTP、Tunnel、复杂兼容场景 |
| AI Agent 运行时 | Mastra + TypeScript/Node Sidecar | 本地 Agent、工具调用、Workflow、记忆、审批暂停与结果总结 |
| 模型接入 | OpenAI-compatible Base URL + Provider 适配层 | 远程模型调用、模型切换、超时与错误归一化 |
| 本地 IPC | Tauri/Rust 受认证 IPC + 共享 TypeScript Schema | Mastra 与 Rust Core 的类型化工具桥接、取消和事件流 |
| 本地数据库 | SQLite + sqlx/rusqlite + migrations | 服务器、项目、任务、审计与偏好 |
| 敏感信息 | macOS Keychain / Windows Credential Manager | 密码、私钥口令、Token、模型 API Key |
| 测试 | Vitest + React Testing Library + Rust tests + Playwright/E2E | 单元、集成与端到端 |
| 构建发布 | GitHub Actions + Tauri Bundler/Updater | macOS/Windows 构建、签名、更新 |

## 10. 核心技术流程

### 10.1 SSH 连接流程

- 加载服务器元数据与 ~/.ssh/config 合并结果，但敏感凭据只从系统安全凭据库按引用读取。

- 解析直连、代理、跳板机链和认证方式，建立 TCP/ProxyJump 链路。

- 获取服务端主机密钥并与已保存 known_hosts 记录比对；首次连接要求确认，变化时阻断。

- 按顺序尝试 ssh-agent、私钥、证书、键盘交互和密码认证；不在日志中输出认证材料。

- 建立可复用 Connection，并按需创建 Shell、Exec、SFTP、Forward Channel。

- 网络异常时进入可控重连，不自动重复执行可能产生副作用的命令。

### 10.2 安全变更流程

文件、systemd、项目、Docker 与 Nginx 等写操作统一按 `ToolCall → OperationGateway → RiskDecision → Approval → Snapshot（若需）→ TaskEngine → Audit` 执行。Rust Core 负责重算风险并固化目标、参数摘要与确认契约；拒绝、审批不匹配或 L4 风险均不得进入执行器，执行或健康检查失败时按已固化快照回滚并记录同一组关联 ID。

### 10.3 Nginx 变更流程

- 读取当前配置与 include 关系，生成版本快照。

- 将新配置写入同目录临时文件，并保持所有者和权限。

- 执行 nginx -t 或带 -c 的等价校验。

- 校验成功后使用原子 rename 替换，再执行平滑 reload。

- 访问健康检查 URL 或检查 master/worker 状态；失败则恢复快照并再次 reload。

### 10.4 项目部署流程

- 前置检查：连接、磁盘、Git 状态、运行时、权限、端口和依赖。

- 生成部署计划，展示将执行的命令、文件变更、目标版本和预计影响范围。

- 获取源码或镜像，执行构建，写入新 release 目录。

- 运行迁移/钩子（默认需单独确认），切换进程或 current 软链接。

- 执行健康检查，成功后记录发布；失败则切回旧版本并保留日志。

### 10.5 AI 运维操作流程

- 用户以自然语言提出诊断、查询或操作目标，Mastra Agent 结合当前服务器、项目和会话上下文生成可审查计划。

- Agent 只能选择 Rust Core 已注册的类型化白名单工具；Rust Core 重新校验服务器范围、参数、工作目录、超时、权限和风险等级。

- L0 只读工具可自动执行；L1/L2 写操作暂停等待用户确认；L3 高风险操作要求二次确认、输入资源名、强制快照并展示回滚路径；L4 不向 Agent 暴露结构化执行工具。

- 审批通过后由 Rust Core 通过 SSH/SFTP 或领域适配器执行，长任务进入任务引擎并持续返回进度、日志、取消和重试状态。

- 执行结果先结构化、裁剪和脱敏，再交给 Agent 生成总结、风险提示与后续建议；完整审计由 Rust Core 写入本地数据库。

- 模型超时、断网或 Agent 进程异常时停止新的推理与工具申请，但已经进入 Rust 任务引擎的操作保持独立状态；恢复后从任务与审批记录重建上下文。

## 11. 本地数据模型

建议使用 SQLite，启用外键约束和 WAL 模式。数据库只保存非敏感元数据；敏感值通过 secret_ref 指向系统安全凭据库。

| 表 | 作用 | 关键字段 |
|---|---|---|
| servers | 服务器连接与展示信息 | id, name, host, port, username, auth_type, secret_ref, group_id, jump_host_id, host_key_fingerprint, last_connected_at |
| server_groups | 服务器分组 | id, name, sort_order |
| tags / server_tags | 多维标签 | tag_id, server_id |
| projects | 项目核心模型 | id, server_id, name, root_path, runtime_type, deploy_strategy, repository_url, branch |
| project_env_refs | 环境变量引用 | project_id, key, secret_ref/value_cipher_ref, is_secret |
| terminal_profiles | 终端偏好 | id, name, shell, cwd, theme, font_size |
| tunnels | 端口转发规则 | id, server_id, type, bind_host, bind_port, target_host, target_port |
| nginx_sites | Nginx 站点索引 | id, server_id, name, config_path, domains, enabled, project_id |
| docker_stacks | Compose 项目 | id, server_id, name, compose_path, project_id |
| tasks | 统一任务 | id, type, server_id, project_id, status, risk_level, progress, started_at, finished_at |
| task_steps | 任务步骤与日志引用 | id, task_id, name, status, log_path, error_code |
| snapshots | 配置/发布快照 | id, resource_type, resource_id, server_id, checksum, storage_path, created_at |
| audit_logs | 审计日志 | id, action, resource_type, resource_id, server_id, result, redacted_payload, created_at |
| agent_threads | Agent 会话索引与上下文策略 | id, title, server_id, project_id, model_profile_id, created_at, updated_at |
| agent_runs | 单次 Agent/Workflow 运行 | id, thread_id, task_id, status, input_summary, output_summary, started_at, finished_at |
| agent_tool_calls | 工具调用与风险元数据 | id, run_id, tool_name, server_id, args_redacted, risk_level, status, result_summary |
| approvals | 写操作审批记录 | id, tool_call_id, decision, approver, confirmed_resource, decided_at |
| model_profiles | 非敏感模型配置 | id, provider, base_url, model, api_key_secret_ref, timeout_ms, enabled |
| app_settings | 本地设置 | key, value_json |

## 12. Core API 与事件设计

前端不得直接执行任意系统命令。Rust Core 对外暴露领域化命令，并对参数做类型校验、权限判断、风险分级和审计。

- 服务器：server.list / server.test_connection / server.connect / server.disconnect。

- 终端：terminal.open / terminal.write / terminal.resize / terminal.close。

- 文件：file.list / file.upload / file.download / file.preview / file.save_with_diff。

- Docker：docker.list_containers / docker.logs / docker.exec / docker.compose_plan / docker.compose_apply。

- Nginx：nginx.discover / nginx.read_site / nginx.plan_change / nginx.validate / nginx.apply / nginx.rollback。

- 项目：project.detect / project.create / deploy.plan / deploy.run / deploy.rollback。

- 任务：task.list / task.cancel / task.retry / task.logs。

- 模型：model.profile_list / model.profile_save / model.test_connection / model.set_default；API Key 只通过 secret_ref 读写。

- Agent：agent.thread_list / agent.thread_create / agent.run / agent.cancel / agent.resume / agent.history。

- 审批：approval.pending / approval.approve / approval.reject；审批只能作用于绑定的 tool_call_id 和参数摘要。

- 工具桥接：agent.tool_describe / agent.tool_request；Rust Core 负责 schema 校验、服务器授权、风险分级与实际执行。

长连接数据使用事件流：terminal:data、task:progress、task:log、metrics:update、docker:stats、connection:state、agent:token、agent:plan、agent:tool_request、agent:approval_required、agent:run_state。事件负载需包含 session_id/task_id/run_id，避免多个标签或 Agent 运行之间串流。

## 13. 安全设计

| 安全领域 | 设计要求 |
|---|---|
| 凭据安全 | 密码、私钥口令、Token、模型 API Key 存储在系统安全凭据库；数据库仅保存引用。私钥文件默认只引用原路径，不复制；导入副本时使用应用私有目录和严格权限。 |
| 主机身份 | 严格校验主机密钥。首次连接显示指纹；密钥变化时阻断并要求用户人工核验。 |
| 命令注入 | 所有结构化操作通过参数数组或经过审计的命令模板执行，禁止简单字符串拼接。路径、域名、容器名和服务名分别校验。 |
| 最小权限 | 默认使用普通用户；需要 sudo 时先检测 sudo -n，不能无密码执行则通过交互式 PTY 请求，不把密码拼进命令或日志。 |
| 前端隔离 | Tauri Capability 只开放明确的命令与窗口权限；不在 WebView 暴露任意文件、Shell 或网络能力。 |
| 远程内容 | 不在高权限 WebView 中加载未知远程网页；外部链接交给系统浏览器，并校验协议。 |
| 更新安全 | 安装包代码签名；macOS notarization；Windows Authenticode；自动更新包必须签名并支持回滚。 |
| 审计与脱敏 | 日志写入前使用字段级脱敏规则，过滤密码、Authorization、Cookie、私钥、环境变量敏感值。 |
| Agent 隔离 | Mastra Sidecar 只通过带会话认证的本地 IPC 连接 Rust Core，不监听公网；WebView 不接触模型密钥、SSH 凭据和任意 Shell；Sidecar 与桌面安装包一起签名、更新和校验。 |
| 模型数据安全 | 发送给远程模型的服务器、日志、配置和命令结果遵循最小上下文原则并字段级脱敏；禁止发送私钥、密码、Token、Cookie、Authorization 和完整环境变量。 |
| Agent 工具安全 | Agent 只调用类型化白名单工具；Rust Core 独立校验参数、目标服务器与风险等级，防止提示词注入、工具参数注入、跨服务器越权和审批绕过。 |
| 危险操作 | 删除、清理、覆盖配置、开放端口、修改 SSH/防火墙等操作必须显示影响范围，支持输入资源名确认。 |

## 14. 可靠性、错误处理与回滚

- 建立统一错误码：连接类、认证类、权限类、命令类、解析类、校验类、冲突类、超时类和取消类。错误对用户显示可操作建议，同时保留可复制的技术详情。

- 连接状态机：Idle → Connecting → HostVerifying → Authenticating → Ready → Reconnecting/Closed/Error。

- 任务状态机：Pending → Running → Succeeded/Failed/Cancelled；有快照的失败任务可进入 RollingBack → RolledBack/RollbackFailed。

- 所有配置写入采用临时文件 + fsync + 原子替换；部署采用 release 目录或镜像标签，不直接覆盖唯一可运行版本。

- 网络重连只恢复读取流和交互终端，不自动重放具有副作用的 Exec 命令。

- 应用崩溃后启动时扫描未完成任务，将其标记为 Interrupted，并提供“检查远端状态”，而不是假定失败或成功。

- 模型不可达、Key 无效、额度不足、限流或响应超时时，Agent 运行进入明确的 Failed/WaitingRetry 状态，并允许重试或切换模型；人工运维功能不受影响。

- Mastra Sidecar 崩溃时由桌面主进程限次拉起；已经进入 Rust 任务引擎的操作保持独立状态，禁止因 Agent 重启而重复执行写操作。

- Agent/Workflow 状态机：Planning → AwaitingTool/AwaitingApproval → Executing → Summarizing → Succeeded/Failed/Cancelled；审批与工具调用使用幂等 ID，恢复时先查询真实任务状态。

## 15. UX 与界面设计

- 总体采用高密度桌面工作台：左侧主导航，中间资源列表，右侧详情/工作区；终端和编辑器可占满主工作区。

- 顶部提供全局服务器切换、快速连接、命令面板和全局任务状态。

- 颜色不作为唯一状态表达：在线/离线、成功/失败同时使用图标和文字。生产环境服务器使用持续可见的环境标识。

- 所有危险按钮放在二级操作区，避免与常用启动/重启按钮相邻；批量操作明确展示选中数量和服务器环境。

- 终端快捷键遵循平台习惯；macOS 使用 Command，Windows 使用 Ctrl，并允许自定义。

- 首次使用提供引导：添加服务器、确认指纹、打开终端、创建第一个项目、配置域名。

## 16. 非功能要求与目标

| 领域 | 目标 |
|---|---|
| 启动体验 | 冷启动目标小于 2 秒（普通开发机）；应用可先显示框架，再异步加载服务器状态。 |
| 连接性能 | 本地网络首次 SSH 连接通常在数秒内完成；连接测试和失败原因应可见。 |
| 资源占用 | 空闲内存显著低于典型 Electron 同类实现；监控轮询在后台自动降频。 |
| 可扩展性 | 单机管理 100+ 服务器元数据；同时活跃连接和终端数量由用户配置并发上限。 |
| 可用性 | 所有关键任务有进度、取消、错误详情和可恢复路径。 |
| 兼容性 | 客户端覆盖当前仍受支持的 macOS 与 Windows；远端优先支持主流 Linux 发行版和 systemd。 |
| 可访问性 | 键盘可操作、焦点可见、终端颜色对比可配置、缩放不破坏核心布局。 |
| 隐私 | 本地优先，默认不上传服务器、命令或日志数据。 |

模型调用例外：仅在用户启用 Agent 并发起请求时，将完成任务所需的最小、已脱敏上下文发送到用户配置的远程模型；设置页必须清楚展示 Provider、Base URL、模型和数据边界。

## 17. 测试策略

- 前端单元测试：表单校验、状态机、筛选、权限提示、Diff 视图和任务展示。

- Rust 单元测试：SSH 配置解析、命令参数转义、路径校验、任务状态机、脱敏器和快照逻辑。

- Agent 单元测试：Mastra Tool Schema、Provider 配置、上下文裁剪、输出解析、Workflow 分支和错误映射。

- 集成测试环境：用 Docker Compose 启动多种 Linux/SSH 服务器、Nginx、Docker-in-Docker 或受控 Docker 守护进程，覆盖密码、密钥、跳板机和断线。

- 契约测试：前端 DTO 与 Rust command/event schema 自动生成或共享，防止字段漂移。

- IPC 契约测试：覆盖 Mastra Sidecar 与 Rust Core 的工具发现、请求、响应、流式事件、取消、超时、版本不匹配和幂等恢复。

- E2E：添加服务器、首次指纹确认、打开终端、上传文件、创建项目、修改 Nginx、查看 Docker 日志和回滚。

- 安全测试：命令注入 payload、恶意文件名、路径穿越、符号链接、主机密钥变化、日志敏感信息泄漏、提示词注入、工具参数注入、跨服务器越权、模型密钥泄漏和审批绕过。

- Agent 集成测试：只读工具自动执行、写操作暂停审批、高风险二次确认、快照、拒绝后不执行、模型断网/限流/超时、Sidecar 崩溃与桌面重启恢复。

- 平台测试：macOS Intel/Apple Silicon，Windows x64；签名安装、卸载、升级、数据迁移和崩溃恢复。

## 18. 构建、发布与更新

- 采用 pnpm workspace + Cargo workspace；React 前端、本地 Mastra Agent Runtime 与共享 TypeScript contracts 位于 pnpm workspace，Rust Core 位于 Cargo workspace。Mastra Sidecar 作为桌面应用受控子进程一起打包、签名和更新。

- CI 分别在 macOS 与 Windows runner 构建，执行测试、依赖审计、生成 SBOM、签名并产出安装包。

- CI 增加 Agent Runtime 构建、Mastra/Rust IPC 契约测试、Provider 模拟测试、Sidecar 完整性校验和模型调用离线回归；测试不得依赖真实生产 API Key。

- macOS 产出 .dmg/.app，进行 Developer ID 签名与 notarization；Windows 产出 MSI/NSIS 安装包并进行 Authenticode 签名。

- 自动更新分稳定、Beta、Nightly 通道；更新清单和包必须签名。数据库迁移先备份，迁移失败时保持旧版本可启动。

- 崩溃日志默认只保存在本地；用户主动反馈时生成可预览的诊断包。

## 19. 版本规划

阶段不使用固定工期承诺，而以可验收能力作为进入下一阶段的门槛。

| 阶段 | 目标 | 核心交付 |
|---|---|---|
| P0 技术验证 | 证明跨平台终端、安全连接与本地 Agent 工具桥接可行 | Tauri 框架、服务器 CRUD、Keychain、known_hosts、xterm.js、SSH Shell/SFTP、Mastra Sidecar、远程模型连通性、只读 Tool 调用与本地 IPC |
| P1 MVP | 形成 Agent 辅助的个人开发者完整运维闭环 | 模型配置、Agent 对话/计划/只读工具、写操作审批、服务器、终端、文件、概览、项目基础、Docker 基础、Nginx 站点、任务与审计、签名安装包 |
| P2 Beta | 提高 Agent 执行与部署可靠性 | Workflow 暂停恢复、Release 部署、健康检查、回滚、Compose Stack、监控与桌面告警、导入导出、Provider 扩展 |
| P3 正式版 | 形成可长期使用的产品 | 稳定更新、插件/适配器机制、证书管理、计划任务、更多运行时、完善诊断与文档 |
| P4 商业化 | 支持团队和多设备 | 端到端加密同步、团队空间、RBAC、审批、云端告警中继、企业审计 |

## 20. MVP 验收标准

- 用户可以在 macOS 和 Windows 安装并启动应用，创建、编辑、分组和删除服务器。

- 支持密码与私钥认证；敏感信息不以明文出现在 SQLite、日志和导出文件中。

- 首次主机密钥需要确认，主机密钥变化时连接被阻断。

- 支持稳定的多标签交互终端、窗口缩放、复制粘贴、断线提示和手动重连。

- 支持 SFTP 浏览、上传、下载、编辑和保存前 Diff。

- 可展示服务器 CPU、内存、磁盘、系统信息、服务和端口的基础状态。

- 可创建 Docker Compose 或通用命令项目，查看状态、日志并执行部署任务。

- 可查看容器、启动/停止/重启、查看日志和进入 Exec。

- 可创建或编辑 Nginx 站点，变更前有 Diff，语法校验失败不会覆盖原配置。

- 所有耗时操作进入任务中心，失败有明确原因；Nginx 与项目发布具备可验证的回滚路径。

- 用户可以配置 Base URL、API Key 与 Model，测试远程模型连接；API Key 不出现在 SQLite、日志或 WebView 状态中。

- 本地 Mastra Agent 能解释至少一组服务器状态，生成可审查计划并调用 Rust Core 只读工具；工具目标和结果进入审计记录。

- Agent 请求写操作时必须暂停并展示目标、命令/参数和影响范围；拒绝后不得执行，高风险操作必须二次确认并生成快照。

- 模型断网、Key 失效或 Sidecar 异常时给出明确降级提示，终端、文件、Docker 和 Nginx 等人工功能仍可使用。

## 21. 主要风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Linux 发行版与工具差异 | 命令路径、服务名、配置目录不同 | 建立 Remote Capability 探测与发行版适配器，不在 UI 中假设固定路径 |
| SSH 生态兼容复杂 | 硬件密钥、代理、跳板机、特殊算法导致失败 | russh 主通道 + 系统 OpenSSH 回退；保留诊断信息 |
| Nginx 配置无法完全结构化 | 误解析可能破坏配置 | 结构化能力只覆盖可证明安全的子集；复杂配置进入源码模式 |
| sudo 权限与交互 | 后台任务可能卡住或泄漏密码 | 先检测 sudo -n；需要密码时使用显式交互 PTY；禁止明文传参 |
| Docker 权限过高 | 等价于远程 root 级能力 | 明确风险提示；不暴露 Docker TCP；审计所有写操作 |
| 功能过多导致 MVP 失控 | 长期无法交付稳定版本 | 以闭环为边界；数据库/K8s/团队功能明确延后 |
| 跨平台签名与更新 | 安装警告和更新失败 | 尽早建立签名流水线，更新与数据库迁移做回滚测试 |
| 本地数据损坏 | 服务器和项目配置丢失 | SQLite 事务、WAL、周期备份、迁移前备份、可导出配置 |
| 远程模型不可用或成本失控 | Agent 无法完成任务或产生意外费用 | Provider 连通性检测、超时/限流/重试、用量提示、单次上下文限制、模型切换和人工功能降级 |
| 敏感运维数据外发 | 服务器信息、日志或配置泄漏给模型供应商 | 最小上下文、字段级脱敏、发送前预览策略、Provider/Base URL 明示、默认不保存完整请求响应 |
| 提示词注入与工具误调用 | 恶意远端内容诱导 Agent 越权或执行危险操作 | 不信任远端文本、类型化白名单工具、Rust Core 独立风险判定、审批门禁、目标绑定与审计 |
| Agent 与 Core 状态不一致 | 重连或崩溃导致重复写操作 | 幂等 tool_call_id、任务状态查询、Sidecar 重启不重放、审批与快照持久化 |

## 22. 商业化与扩展方向

- 免费版：本地服务器管理、终端、文件、基础 Docker/Nginx 和有限项目数量。

- 专业版：无限项目、部署回滚、监控告警、批量操作、加密备份和高级适配器。

- 团队版：共享服务器目录、RBAC、审批、操作审计、密钥托管集成和组织策略。

- 插件市场：数据库、Redis、消息队列、对象存储、云厂商、CI/CD、Kubernetes 等适配器。

- Mastra AI Agent 是所有版本的基础交互与辅助运维能力；不同版本可按模型配置数量、上下文容量、高级 Workflow、团队审批与审计策略区分，但真正执行始终经过 Rust Core 的结构化权限、风险判断与用户确认。

## 23. 推荐仓库结构

```text
ssh-ops-desktop/
├─ apps/
│  ├─ desktop/                 # React 前端
│  └─ agent-runtime/           # 本地 Mastra Sidecar 入口、生命周期与 IPC
├─ src-tauri/                  # Tauri 入口与权限配置
├─ crates/
│  ├─ domain/                  # Server/Project/Task 领域模型
│  ├─ ssh-core/                # SSH、SFTP、Tunnel、known_hosts
│  ├─ remote-adapters/         # Linux/Systemd/Docker/Nginx/Git 适配器
│  ├─ task-engine/             # 任务、步骤、取消、回滚
│  ├─ persistence/             # SQLite、migration、repository
│  ├─ secrets/                 # Keychain/Credential Manager
│  ├─ audit/                   # 审计与脱敏
│  └─ agent-bridge/            # Agent 工具注册、风险门禁、审批与 IPC
├─ packages/
│  ├─ ui/                      # 共享桌面组件
│  ├─ contracts/               # DTO / schema / generated types
│  ├─ agent-core/              # Mastra agents、tools、workflows、memory
│  ├─ model-providers/         # OpenAI-compatible 与原生 Provider 适配
│  └─ config/                  # ESLint/TS/Vite 配置
├─ tests/
│  ├─ fixtures/
│  ├─ integration/
│  └─ e2e/
└─ docs/
   ├─ architecture/
   ├─ security/
   └─ adapters/
```

## 24. 关键架构决策记录

1. **采用 Tauri 2 而非 Electron 作为正式技术路线**：降低桌面运行时开销，并将高权限能力集中在 Rust Core。

2. **桌面端必须内置本地 Mastra Agent**：Agent 通过用户配置的远程模型辅助规划与运维，使用 Rust Core 类型化工具执行；受管服务器无需安装常驻 AI Agent，也不暴露额外公网管理端口。

3. **russh + 系统 OpenSSH 双通道**：兼顾可控的嵌入式能力与 OpenSSH 复杂生态兼容性。

4. **敏感信息不进入 SQLite**：减少数据库泄漏和备份泄漏的影响范围。

5. **Docker API 只通过 SSH 隧道或 Unix Socket**：避免远端 Docker daemon 裸露在网络上。

6. **Nginx 写操作强制校验与回滚**：配置错误可能直接造成所有站点不可用。

7. **项目是一级领域对象**：项目管理是区别普通 SSH 客户端的核心价值。

8. **MVP 不做数据库管理与团队协作**：控制范围，优先完成高频运维闭环。

9. **模型只负责推理，Rust Core 掌握执行与风险边界**：只读工具可自动执行，写操作确认，高风险操作二次确认、快照和审计；大模型不能降低风险等级。

10. **模型接入供应商无关**：首版使用 Base URL + API Key + Model 并优先兼容 OpenAI-compatible 接口，保留原生 Provider 扩展点。

## 25. 参考依据

- [R1] Tauri 2 Architecture / Capability 官方文档：Tauri 使用 Rust Core 与 WebView，并通过 Capability 控制窗口和 WebView 对核心命令的细粒度访问。

- [R2] Electron 官方 Security / Context Isolation 文档：若选择 Electron 原型，应启用 contextIsolation、sandbox，禁用远程内容的 Node 集成，并严格限制 IPC。

- [R3] xterm.js 官方文档：提供 Web 终端渲染、终端序列支持与 addon 扩展机制。

- [R4] Docker Engine API 官方文档：Docker daemon 提供版本化 HTTP API，客户端应根据服务端 API 版本协商。

- [R5] OpenSSH ssh_config 手册：支持 ProxyJump、known_hosts 与 StrictHostKeyChecking 等连接和主机身份校验能力。

- [R6] Nginx 官方命令行文档：nginx -t 用于配置语法和引用文件检查，nginx -s reload 用于平滑重载。

- [R7] SQLite 官方 WAL 与 Foreign Key 文档：本地数据库可使用 WAL，提高读写并发，并显式启用外键约束。

- [R8] Rust russh / keyring / portable-pty 文档：分别提供异步 SSH 客户端、跨平台系统安全凭据库和跨平台 PTY 能力。

- [R9] [Mastra 官方 Agent Framework 文档](https://mastra.ai/ai-agent-framework)：提供 TypeScript Agent、模型路由、工具调用、记忆、工具审批、可观测与评测能力。

- [R10] [Mastra 官方 Workflows 文档](https://mastra.ai/ai-workflows)：提供顺序、并行、分支、循环、暂停/恢复和 Human-in-the-Loop 工作流能力。

## 附录 A：操作风险分级

| 等级 | 示例 | 默认交互 |
|---|---|---|
| L0 只读 | 查看状态、日志、配置、目录 | Agent 可直接执行并记录审计 |
| L1 可逆 | 启动/停止服务、上传新文件、创建容器 | Agent 调用必须普通确认 |
| L2 有影响 | 重启生产服务、修改 Nginx、更新项目、删除单个容器 | 展示 Diff/影响范围并确认 |
| L3 高风险 | 删除卷/镜像、清理磁盘、修改 SSH/防火墙、覆盖配置 | 二次确认，输入资源名，必须生成快照 |
| L4 灾难性 | 格式化磁盘、递归删除系统目录、禁用 SSH | 产品不提供结构化按钮，仅允许用户在终端自行操作 |

## 附录 B：MVP Backlog（按优先级）

### P0 必须

- 跨平台应用壳与签名基础

- 本地 Mastra Agent Runtime 与生命周期

- Base URL / API Key / Model 配置与连通性测试

- Mastra/Rust Core 类型化 IPC 与只读 Tool 验证

- 服务器 CRUD/分组/标签

- 安全凭据库

- known_hosts 与指纹确认

- SSH 终端与多标签

- SFTP 浏览与传输

- 任务中心与日志脱敏

### P1 核心闭环

- Agent 对话、服务器状态解释与操作计划

- 写操作审批、高风险二次确认、快照与审计

- Agent/Workflow 取消、超时、错误与降级

- 服务器概览

- systemd 服务/端口

- 项目模型与通用部署

- Docker 容器/日志/Exec

- Compose Stack 基础

- Nginx 站点与安全写入流程

- 项目日志与健康检查

### P2 体验

- 分屏与广播输入

- 端口转发

- Monaco 编辑器与 Diff

- 发布回滚

- 导入 ~/.ssh/config

- 诊断包与加密导出

### P3 延后

- 长期告警

- 证书自动化

- 数据库管理

- 团队空间

- 插件市场

- 多 Agent 协作与团队级 Agent 策略
