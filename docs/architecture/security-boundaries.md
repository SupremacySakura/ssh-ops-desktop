# OpsPilot 安全边界

本文记录 M0 桌面壳当前已经实现的权限边界，以及后续功能不得绕过的约束。它描述的是可验证的代码现状，不把尚未实现的 SSH、Agent 或发布能力写成已有能力。

## 信任区域

| 区域 | 可以持有 | 禁止持有或直接执行 |
|---|---|---|
| React/WebView | 展示状态、用户输入、类型化 CoreClient | 系统凭据、SQLite 路径、任意 shell、任意文件系统、无约束网络访问 |
| Tauri/Rust Core | SQLite pool、应用数据目录、SecretStore 适配器、显式注册的 command | 把原始秘密或内部路径返回给 WebView |
| 系统凭据库 | 由随机 `secret_ref` 定位的秘密值 | 业务元数据、审计事件、可猜测的业务账号名 |
| SQLite | 服务器等非敏感元数据、`secret_ref`、脱敏审计记录 | 密码、私钥口令、Token、模型 API Key 等原始秘密 |
| 测试驱动 | debug native E2E 期间的本机测试控制通道 | 普通构建或 release 构建中的注册入口 |

## WebView 与 IPC

- 主窗口 capability 只授予 `core:event:default`、`core:window:default` 和显式生成的 `allow-core-health`。
- capability 不包含 `shell:*`、`fs:*`、HTTP 通配权限或远程 URL 访问能力。
- 应用 command 同时在 `src-tauri/build.rs` 的 manifest 和 `invoke_handler` 中显式注册。
- 当前 `core_health` 只返回版本、数据库 readiness 和凭据库 readiness。它不返回数据库路径、环境变量、系统凭据名称或后端错误详情。
- React 只依赖 `CoreClient` 接口；Tauri `invoke` 被限制在适配器内。IPC 拒绝时 UI 显示通用错误，不向用户暴露原始后端错误。

未来增加 command 时，WebView 输入必须在 Rust 边界重新校验。所有远端写操作必须进入路线图定义的唯一 `OperationGateway`；不能让 WebView、Tauri command 或 Agent Sidecar 直达写 executor。

## SQLite、凭据与审计

- SQLite 文件位于 Tauri 的应用私有数据目录，并启用 WAL、外键和 busy timeout。
- SQLite 只保存不透明 `secret_ref`；外部系统凭据的删除由显式 SecretStore 清理流程负责，migration 不级联删除系统凭据。
- `KeyringSecretStore` 使用固定 service 和不可猜测 account；readiness probe 只读取保留的探测 account，不创建、修改、枚举或泄露凭据。
- SecretStore 返回的秘密值使用可清零容器，并把 `Debug` 输出固定为 `[REDACTED]`。
- `Redactor` 在审计写入前执行字段级和值级脱敏；`audit_logs` 通过数据库触发器阻止 `UPDATE` 和 `DELETE`。

## Renderer 与 native E2E

- Playwright renderer 测试只运行 Vite fixture 和 Chromium，不声称覆盖 Tauri、Rust、系统 WebView、Keychain 或 SSH。
- WebdriverIO native 测试驱动真实 Tauri debug binary，并通过真实 IPC 验证数据库与系统凭据库 readiness。
- `tauri-plugin-wdio` 和 `tauri-plugin-wdio-webdriver` 都是可选 Cargo feature；只有同时满足 `debug_assertions` 与 `native-e2e` feature 时才注册。
- 测试 capability 只在上述条件成立时动态加入；普通 debug build 不启用该 feature，release build 也不会注册测试插件或 capability。
- native E2E 严格要求宿主系统凭据库可用。无可用 Keychain/Credential Manager 的 headless 环境必须被视为测试环境不满足，而不是把 readiness 伪造为 true。

## CI 边界

- CI 使用 `macos-14` 与 `windows-2025` 原生 runner、Node 24、固定 pnpm 10.15.0 和 `rust-toolchain.toml` 中的 Rust 1.97.1。
- `GITHUB_TOKEN` 只具有 `contents: read`；workflow 不读取仓库 secrets，不执行签名、notarization、发布或部署。
- 缓存键绑定 `pnpm-lock.yaml`、`Cargo.lock` 和 `rust-toolchain.toml`，并按操作系统与架构隔离。
- 缓存只包含 pnpm store 与 Cargo registry/git checkout；不缓存 `node_modules`、应用数据目录、系统凭据库、`.env`、签名证书或打包密钥。
- CI 先构建不带测试驱动的普通 debug 壳，再用专用 feature 构建 native E2E binary。测试构建不得作为发布候选物。

## 变更检查清单

增加新 capability、command、SecretKind、持久化字段或 CI 缓存路径时，至少回答以下问题：

1. WebView 是否获得了比完成该交互所需更多的权限？
2. Rust 是否重新校验了来自 WebView/Sidecar 的目标、参数与作用域？
3. 原始秘密、内部路径或未脱敏错误是否可能进入 IPC、SQLite、日志、测试报告或缓存？
4. 写操作是否绕过唯一 OperationGateway、风险判定、审批、快照、任务或审计链？
5. 测试能力是否可能进入普通构建或发布构建？
6. macOS 与 Windows 是否都具有本次运行的新鲜构建和测试证据？

## 上游依据

- [Tauri Capability](https://v2.tauri.app/security/capabilities/)
- [Tauri WebDriver 与 WebdriverIO](https://v2.tauri.app/develop/tests/webdriver/)
- [GitHub Actions 最小权限](https://docs.github.com/en/actions/reference/security/secure-use)
- [GitHub Actions 依赖缓存](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
