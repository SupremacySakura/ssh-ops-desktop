# Harbor 安全边界

本文记录当前 Harbor 已实现的权限边界，以及后续功能不得绕过的约束。当前已实现服务器目录、SSH Config 导入、SSH 连接、终端、SFTP 文件（含写操作）、系统监控与 Docker 管理；命令面共 **33** 个，以 `src-tauri/build.rs` 的 manifest 为准。

## 信任区域

| 区域 | 可以持有 | 禁止持有或直接执行 |
|---|---|---|
| React/WebView | 展示状态、用户输入、类型化 `CoreClient` | 系统凭据、SQLite 路径、任意 shell、任意文件系统、无约束网络访问 |
| Tauri/Rust Core | SQLite pool、应用数据目录、SecretStore 适配器、显式注册的 command | 把原始秘密或内部路径返回给 WebView |
| 系统凭据库 | 由随机 `secret_ref` 定位的秘密值 | 业务元数据、可猜测的业务账号名 |
| SQLite | 服务器与分组元数据、`secret_ref`、内部 known_host_keys | 密码、私钥、口令、Token 等原始秘密 |

## WebView 与 IPC

- 主窗口 capability 只授予显式生成的 33 个命令权限：`core_health`、`clipboard_read_text`、服务器/分组目录、SSH Config 导入、连接、终端、文件（列表/读取/写入/下载/上传/新建目录/重命名/删除）、监控快照与 Docker（列表/日志/操作/exec），以及 terminal/connection 事件桥所需的 `core:event:allow-listen`、`core:event:allow-unlisten`；不包含 `core:event:default`、`shell:*`、`fs:*`、HTTP 通配权限或远程 URL 访问能力。
- 应用 command 同时在 `src-tauri/build.rs` 的 manifest、`src-tauri/src/lib.rs` 的 invoke handler、权限文件与主窗口 capability 中显式注册。
- `core_health` 只返回版本、数据库 readiness 和凭据库 readiness；不返回数据库路径、环境变量、系统凭据名称或后端错误详情。
- `clipboard_read_text` 只在用户显式粘贴时读取系统文本剪贴板，内容仅返回给终端视图，不写日志、SQLite 或事件；超过 4 MiB 时拒绝，空剪贴板返回空字符串。
- React 只依赖 `CoreClient` 接口；Tauri `invoke` 被限制在适配器内。IPC 拒绝时 UI 按 `CoreError.code` 映射中文文案；`INTERNAL`、`REMOTE_PARSE`、`REMOTE_COMMAND` 与非 `CoreError` 一律使用固定文案，不向用户暴露原始后端错误。`VALIDATION`/`CONFLICT` 仅当消息本身是中文时才展示。

新增 command 时，WebView 输入必须在 Rust 边界重新校验。写入、删除、重命名等危险操作必须由前端原生确认对话框把关；不要恢复旧 OperationGateway、审批、任务或审计链。

## SQLite 与凭据

- SQLite 文件位于 Tauri 的应用私有数据目录，并启用 WAL、外键与 busy timeout。
- schema 只包含 `groups`、`servers` 与内部 `known_host_keys`。不创建旧子系统、标签或隧道表。
- `servers.secret_ref` 是可空的不透明引用；非空值只指向系统凭据库，`NULL` 仅表示“凭据待配置”，不得写入空字符串、占位引用或猜测的凭据。
- 迁移将 `servers` 重建为允许可空 `secret_ref` 的表，并在同一事务中备份和恢复 `known_host_keys`，避免服务器表重建级联丢失已信任指纹。
- 删除分组时通过外键 `ON DELETE SET NULL` 清空服务器分组，不级联删除服务器。
- `KeyringSecretStore` 使用固定 service 和不可猜测 account；readiness probe 只读取保留的探测 account，不创建、修改、枚举或泄露凭据。
- `SecretValue` 使用可清零容器，`Debug` 输出固定为 `[REDACTED]`。
- 删除服务器时先删除数据库行，成功后再显式清理非空 `secret_ref` 对应的系统凭据；凭据清理失败必须作为 warning 返回给用户，不得静默丢弃。凭据待配置服务器不访问系统凭据库。数据库 migration 不级联删除凭据库条目。
- 凭据轮换在数据库更新成功后清理旧 `secret_ref`；清理失败同样以 warning 返回，旧凭据不会在用户不知情的情况下长期残留。
- `KeyringSecretStore` 使用 service `com.harbor.desktop`；读取时回退只读 legacy service `com.opspilot.desktop`，命中后尽力迁移到新 service。删除同时清理两个 service，`NoEntry` 视为已完成。readiness probe 只读取 `__harbor_readiness_probe__`。

## SSH Config 导入

- Rust 只读取默认 `~/.ssh/config`（测试可注入路径），限制为 1 MiB、普通文件与 UTF-8；错误信息不包含文件正文或私钥内容。
- 解析器只导入明确的 `Host`、`HostName`、`Port` 与 `User`。通配 Host、`Match` 条件块、缺少 User、非法端口和无法安全解释的主机名会被跳过并产生 warning。
- `Include`、`Match`、`ProxyJump`、`ProxyCommand` 以及会改变连接目标或主机身份语义的指令必须显式标记为 unsupported；不能静默按直连导入。若这些语义位于顶层、通配 Host 或 Match 条件块中，无法证明具体条目不受影响时，preview 会把全部明确 Host 标为 unsupported，而不是猜测其继承结果。
- Preview 与 apply 只在 Rust 内存中保存服务端行 ID，并与窗口和 15 分钟 TTL 绑定。Apply 只接受 preview ID 与选中行 ID，重新读取文件并校验 SHA-256 后再写入；源文件变化返回 `CONFLICT`。
- Apply 使用事务内 `ON CONFLICT DO NOTHING` 跳过已存在与批内重复的 `(host, port, user)`，不会因单条重复让整批失败。
- 导入不复制 `IdentityFile` 内容、不创建系统凭据、不执行代理指令，也不写入 `known_host_keys`。新服务器以 `secret_ref = NULL` 和“凭据待配置”状态进入目录。

## SSH 主机身份

- 未知主机指纹以 `HostKeyRequired` 结果阻断连接，等待用户显式信任；不会返回“已连接”。
- 已信任指纹只比较 SHA-256；发现变化时以 `HostKeyChanged` 结果继续阻断，不得静默覆盖。
- 未知与变化确认都使用过期的一次性 `verificationId`，并与 server、host、port 和公钥绑定；不匹配、过期或重放一律失败关闭。
- 变化确认记录旧指纹；只有用户显式确认后，才会以“旧 SHA-256 仍匹配”为条件原子替换，避免并发确认覆盖新的信任状态。
- known_hosts 数据存储在内部 `known_host_keys` 表，不包含私钥或凭据本体。

## SSH 连接与终端

- 密码与私钥材料只在 Rust Core 连接期间从系统凭据库读取，不写入 SQLite、日志、事件或 WebView；数据库只保存可空的 `secret_ref`，`NULL` 必须在连接前以 `SECRET_UNAVAILABLE` 失败关闭。
- 每个连接与 terminal session 都校验 server/connection 归属：`terminal_write`、`terminal_resize`、`terminal_close` 必须携带 `ConnectionHandle`，与会话记录的连接比对，不匹配返回 `NOT_FOUND`；事件先于 open 响应到达时按 session 缓冲，`data` 可淘汰，`gap`/`closed` 必须保留且顺序稳定。
- 每台服务器最多 8 个 open 会话；关闭或断连事件只能关闭匹配连接，处理后会清理 Session 与输出缓冲，避免占用限额。
- `last_connected_at` 只在连接成功、连接注册与时间戳写入都成功后更新。
- 前端只通过 `CoreClient` 调用连接、终端与事件桥命令；`connection:state` 的 ready/error 事件不覆盖本地 connect 返回值，closed 只接受当前连接 ID 与更高序号。
- 四个 Tab（终端/文件/监控/Docker）始终挂载；切换 Tab 只改变可见性，不销毁 xterm、Monaco 草稿或监控缓冲。切换服务器时旧 Workspace 保持挂载但不可交互，后台采样与迟到响应必须按 server/connection generation 丢弃，不得污染当前服务器。

## 远程路径与文件操作

- 所有 SFTP 路径必须经 `RemotePath::try_new` 校验，拒绝空路径、控制字符与 `..` 越界。
- 文件、目录与上传目标在操作前逐级 `lstat`：路径中任一祖先或（读取/编辑时）最终组件为 symlink 即失败关闭，不静默跟随。SFTP v3 没有 `openat` 式 no-follow 句柄，`lstat` 与后续 open/rename 之间仍存在协议级竞态；已打开的读取会在 open 后复检最终组件，祖先竞态无法完全消除。
- 上传与文件重命名必须无覆盖提交；部分失败时回滚已提交文件，不能留下半完成状态。文件重命名在 hardlink 成功后若删除源文件确定性失败，必须删除已创建的目标并返回错误；只有结果未知（超时、断连、内部错误、取消）才保留目标，并在结果中显式报告残留。
- 目录重命名没有 SFTP v3 原子 no-replace 原语：必须先 `lstat` 确认目标不存在，再执行 rename，并始终在结果 warning 中声明预检查与 rename 之间的竞态窗口；不得把目录重命名描述为原子操作。
- 上传批次硬上限为单文件与整批各 16 MiB、最多 32 个文件；这是为控制 JSON/IPC 峰值内存的刻意限制，Rust、契约与 UI 必须同步，超限在读取文件前拒绝并给出中文提示。
- 前端不得直接调用系统 shell 或文件系统；远程操作只能经由 Rust Core 的类型化 command。

## 监控与 Docker

- `monitor_snapshot` 只读取当前已就绪连接的系统指标；采样每 2 秒一次，最多保留 150 个点，只存在前端内存，不写入 SQLite、日志或磁盘。
- 监控、文件与 Docker 操作只消费 Workspace 已建立的连接，不各自创建 SSH 连接；离线或重连时停止旧采样，迟到快照按 connection ID 丢弃。
- Docker 操作只允许列表、日志、start/stop/restart 与 exec；exec 复用终端会话限额与连接归属校验，不新建独立 shell 后端。
- Docker 命令参数不拼接用户输入到本地 shell；容器 ID 与 shell 经 Rust 侧校验后执行。shell 只接受简单命令名或绝对路径，拒绝空白、控制字符与 shell 元字符。

## 测试边界

- Playwright renderer 测试只运行 Vite fixture 与 Chromium，使用注入的 fake `CoreClient`，不声称覆盖 Tauri、Rust、系统 WebView、Keychain 或 SSH。
- Rust 命令测试使用 `CoreServices` + 内存 SQLite + `MemorySecretStore`；真实系统凭据库不可用时，必须报告未就绪而不是伪造 readiness。
- 测试专用 capability 与测试驱动 feature 已删除；不得在普通构建或发布构建中重新加入测试入口。

## CI 边界

- CI 使用 `macos-15` 与 `windows-2025` 原生 runner、Node 24、固定 pnpm 10.15.0 和 `rust-toolchain.toml` 中的 Rust 1.97.1。
- `GITHUB_TOKEN` 只具有 `contents: read`；workflow 不读取仓库 secrets，不执行签名、notarization、发布或部署。
- 缓存键绑定 `pnpm-lock.yaml`、`Cargo.lock` 与 `rust-toolchain.toml`，并按操作系统与架构隔离。
- 缓存只包含 pnpm store 与 Cargo registry/git checkout；不缓存 `node_modules`、应用数据目录、系统凭据库、`.env`、签名证书或打包密钥。

## 变更检查清单

增加新 capability、command、SecretKind、持久化字段或 CI 缓存路径时，至少回答以下问题：

1. WebView 是否获得了比完成该交互所需更多的权限？
2. Rust 是否重新校验了来自 WebView 的目标、参数与作用域？
3. 原始秘密、内部路径或未脱敏错误是否可能进入 IPC、SQLite、日志、测试报告或缓存？
4. 危险写操作是否绕过前端确认或 Rust 侧的路径与状态校验？
5. 未知或变化的主机指纹是否仍然无法被静默信任？
6. macOS 与 Windows 是否都具有本次运行的新鲜构建和测试证据？

## 上游依据

- [Tauri Capability](https://v2.tauri.app/security/capabilities/)
- [Tauri build 命令清单](https://v2.tauri.app/develop/calling-rust/)
- [GitHub Actions 最小权限](https://docs.github.com/en/actions/reference/security/secure-use)
- [GitHub Actions 依赖缓存](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
