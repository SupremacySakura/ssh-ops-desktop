# Harbor 安全边界

本文记录当前 Harbor 已实现的权限边界，以及后续功能不得绕过的约束。当前已实现服务器目录与 SSH Config 导入；不把尚未实现的 SSH 会话、SFTP 或终端能力写成已有能力。

## 信任区域

| 区域 | 可以持有 | 禁止持有或直接执行 |
|---|---|---|
| React/WebView | 展示状态、用户输入、类型化 `CoreClient` | 系统凭据、SQLite 路径、任意 shell、任意文件系统、无约束网络访问 |
| Tauri/Rust Core | SQLite pool、应用数据目录、SecretStore 适配器、显式注册的 command | 把原始秘密或内部路径返回给 WebView |
| 系统凭据库 | 由随机 `secret_ref` 定位的秘密值 | 业务元数据、可猜测的业务账号名 |
| SQLite | 服务器与分组元数据、`secret_ref`、内部 known_host_keys | 密码、私钥、口令、Token 等原始秘密 |

## WebView 与 IPC

- 主窗口 capability 只授予显式生成的 `core_health`、服务器目录和 SSH Config 导入权限，不包含 `shell:*`、`fs:*`、HTTP 通配权限或远程 URL 访问能力。
- 应用 command 同时在 `src-tauri/build.rs` 的 manifest、`src-tauri/src/lib.rs` 的 invoke handler、权限文件与主窗口 capability 中显式注册。
- `core_health` 只返回版本、数据库 readiness 和凭据库 readiness；不返回数据库路径、环境变量、系统凭据名称或后端错误详情。
- React 只依赖 `CoreClient` 接口；Tauri `invoke` 被限制在适配器内。IPC 拒绝时 UI 显示通用错误，不向用户暴露原始后端错误。

新增 command 时，WebView 输入必须在 Rust 边界重新校验。写入、删除、重命名等危险操作必须由前端原生确认对话框把关；不要恢复旧 OperationGateway、审批、任务或审计链。

## SQLite 与凭据

- SQLite 文件位于 Tauri 的应用私有数据目录，并启用 WAL、外键与 busy timeout。
- schema 只包含 `groups`、`servers` 与内部 `known_host_keys`。不创建 tasks、audits、agent、model、projects、tags 或 tunnel 表。
- `servers.secret_ref` 是可空的不透明引用；非空值只指向系统凭据库，`NULL` 仅表示“凭据待配置”，不得写入空字符串、占位引用或猜测的凭据。
- 迁移将 `servers` 重建为允许可空 `secret_ref` 的表，并在同一事务中备份和恢复 `known_host_keys`，避免服务器表重建级联丢失已信任指纹。
- 删除分组时通过外键 `ON DELETE SET NULL` 清空服务器分组，不级联删除服务器。
- `KeyringSecretStore` 使用固定 service 和不可猜测 account；readiness probe 只读取保留的探测 account，不创建、修改、枚举或泄露凭据。
- `SecretValue` 使用可清零容器，`Debug` 输出固定为 `[REDACTED]`。
- 删除服务器时，非空 `secret_ref` 对应的系统凭据必须显式清理；凭据待配置服务器不访问系统凭据库。数据库 migration 不级联删除凭据库条目。

## SSH Config 导入

- Rust 只读取默认 `~/.ssh/config`（测试可注入路径），限制为 1 MiB、普通文件与 UTF-8；错误信息不包含文件正文或私钥内容。
- 解析器只导入明确的 `Host`、`HostName`、`Port` 与 `User`。通配 Host、`Match` 条件块、缺少 User、非法端口和无法安全解释的主机名会被跳过并产生 warning。
- `Include`、`Match`、`ProxyJump`、`ProxyCommand` 以及会改变连接目标或主机身份语义的指令必须显式标记为 unsupported；不能静默按直连导入。若这些语义位于顶层、通配 Host 或 Match 条件块中，无法证明具体条目不受影响时，preview 会把全部明确 Host 标为 unsupported，而不是猜测其继承结果。
- Preview 与 apply 只在 Rust 内存中保存服务端行 ID，并与窗口和 15 分钟 TTL 绑定。Apply 只接受 preview ID 与选中行 ID，重新读取文件并校验 SHA-256 后再写入；源文件变化返回 `CONFLICT`。
- Apply 使用事务内 `ON CONFLICT DO NOTHING` 跳过已存在与批内重复的 `(host, port, user)`，不会因单条重复让整批失败。
- 导入不复制 `IdentityFile` 内容、不创建系统凭据、不执行代理指令，也不写入 `known_host_keys`。新服务器以 `secret_ref = NULL` 和“凭据待配置”状态进入目录。

## SSH 主机身份

- 未知主机指纹必须返回 `SSH_HOST_KEY_UNKNOWN` 并阻断连接，等待用户显式信任。
- 已信任指纹只比较 SHA-256；发现变化时返回 `SSH_HOST_KEY_CHANGED`，不得静默覆盖。
- 待确认的验证记录有过期时间，并与 server、host、port 和公钥绑定；不匹配或过期一律失败关闭。
- known_hosts 数据存储在内部 `known_host_keys` 表，不包含私钥或凭据本体。

## 远程路径与文件操作

- 所有 SFTP 路径必须经 `RemotePath::try_new` 校验，拒绝空路径、控制字符与 `..` 越界。
- 上传等冲突校验必须无覆盖提交；部分失败时回滚已提交文件，不能留下半完成状态。
- 前端不得直接调用系统 shell 或文件系统；远程操作只能经由 Rust Core 的类型化 command。

## 测试边界

- Playwright renderer 测试只运行 Vite fixture 与 Chromium，使用注入的 fake `CoreClient`，不声称覆盖 Tauri、Rust、系统 WebView、Keychain 或 SSH。
- Rust 命令测试使用 `CoreServices` + 内存 SQLite + `MemorySecretStore`；真实系统凭据库不可用时，必须报告未就绪而不是伪造 readiness。
- 旧 WebdriverIO native E2E、测试专用 capability 与测试驱动 feature 已删除；不得在普通构建或发布构建中重新加入测试入口。

## CI 边界

- CI 使用 `macos-14` 与 `windows-2025` 原生 runner、Node 24、固定 pnpm 10.15.0 和 `rust-toolchain.toml` 中的 Rust 1.97.1。
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
