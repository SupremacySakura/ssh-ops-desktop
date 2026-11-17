# Harbor 验收矩阵

基线：`rebuild@a98da19` + `ticket/10-integration` 工作区改动  
日期：2026-11-18  
环境：macOS（darwin），Node `v24.19.0`，pnpm `10.15.0`，rustc `1.97.1`

本矩阵对应 GitHub issue #1 的 23 条用户故事。结果只记录本次实际运行过的自动化证据；“PASS”不等于真实 Tauri、系统 Keychain、真实 SSH/SFTP/Docker 或视觉审查已经完成，相关边界单列在“残余风险”。

状态定义：

- **PASS**：有实现，且本矩阵列出的自动化测试在本次运行中通过。
- **PARTIAL**：核心路径有自动化证据，但仍有未覆盖的分支、平台或真实系统边界。
- **MANUAL**：只能由真实桌面环境、系统凭据库或人工视觉审查确认。

## 门禁结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| 格式 | `cargo fmt --check` | 通过 |
| Rust 静态检查 | `cargo clippy --workspace --all-targets -- -D warnings` | 通过，零告警 |
| Rust 测试 | `cargo test --workspace` | 193 passed，0 failed，1 ignored（真实系统 Keychain，需人工显式启用） |
| ESLint | `pnpm lint` | 通过，`--max-warnings 0` |
| 类型检查 | `pnpm typecheck` | 通过 |
| 包测试 + smoke | `pnpm test` | desktop 173 passed；contracts 26 passed；smoke 9 passed |
| 跨边界集成 | `pnpm test:integration` | 2 个文件、17 个测试通过；无测试时退出码为 1 |
| 桌面构建 | `pnpm build:desktop` | 通过；存在 Monaco/编辑器大 chunk 警告（见残余风险） |
| 渲染进程 E2E | `pnpm test:e2e:renderer`（`CI=true`） | 22 passed；运行前确认 1421 无旧 server |
| Tauri 调试构建 | `pnpm tauri build --debug` | 通过，产物 `target/debug/opspilot-desktop` |

E2E 证据边界：Playwright 只驱动 Vite fixture + Chromium + 注入的 fake `CoreClient`，不启动 Tauri、Rust Core、Keychain、真实 SSH/SFTP/Docker。`tests/e2e/renderer/app-shell.spec.ts` 的 frozen `Object.prototype` 场景用于覆盖 Tauri WebView 的 `freezePrototype` 兼容性，但仍不是原生窗口证据。

## 23 条用户故事

| # | 用户故事 | 验证层级 | 测试路径 / 场景 | 结果 | Manual / 残余风险 |
|---|---|---|---|---|---|
| 1 | 按分组查看服务器，收藏置顶，最近连接排序 | store + component + E2E | `apps/desktop/src/store/harbor-store.test.ts`（`filters by name, host, or user and keeps favorites in one pinned section`）；`apps/desktop/src/App.test.tsx`（`loads grouped nameplates with favorites pinned ahead of their groups`）；E2E `integration-flow.spec.ts`（`restores servers, groups, and favorites after a renderer reload` 断言“收藏”区与“生产”分组） | PASS | 最近连接的相对时间文案未做 E2E 像素级断言；时间格式化由 store 测试覆盖 |
| 2 | 按名称、主机、用户名搜索 | store + E2E | `harbor-store.test.ts`（过滤用例同时覆盖名称/主机/用户名）；E2E `integration-flow.spec.ts`（`shows empty search and empty directory states` 断言“没有匹配的服务器”） | PASS | 无 |
| 3 | 最少字段添加服务器 | component + E2E | `App.test.tsx`（`validates and saves a new server through the add-server dialog`）；E2E `integration-flow.spec.ts`（`adds a server, connects, edits a file, monitors it, and execs into Docker` 通过表单新增 `fresh-prod`） | PASS | 真实 Keychain 写入不在 renderer E2E 内，见 #4 |
| 4 | 密码/私钥只进系统 Keychain | Rust + component + manual | `crates/secrets/tests/store_contract.rs`（`secret_value_debug_is_always_redacted`、`memory_store_satisfies_secret_store_contract`）；`src-tauri/src/commands/catalog.rs` 的 `MemorySecretStore` 测试；`App.test.tsx`（`saves a server without keeping its credential in state`） | PARTIAL | 真实 macOS Keychain / Windows Credential Manager 用例为 `#[ignore]`，本次未执行；需要人工在真实桌面运行并确认系统凭据库条目 |
| 5 | `~/.ssh/config` 导入，已存在跳过 | Rust + component + E2E | `src-tauri/src/commands/ssh_config_import.rs` 单测（解析、预览、幂等重放）；`App.test.tsx`（`previews SSH Config rows, imports only ready selections, and marks pending credentials`）；E2E `integration-flow.spec.ts`（`imports three ready hosts and skips the existing one`，断言导入 3、跳过 1） | PASS | 导入只处理明确 Host；`Include`/`Match`/`ProxyJump`/`ProxyCommand` 未接线，属于已知限制 |
| 6 | 点击服务器自动连接并进入终端 | component + E2E | `App.test.tsx`（`auto-connects a selected server and opens its first terminal session`、`auto-connects as soon as a pending server receives its credential`）；E2E `integration-flow.spec.ts`（新增服务器后断言终端 1 与 `aria-current`） | PASS | 真实 SSH 握手仍由 `cargo test` 的 russh 测试覆盖，renderer 使用 fake |
| 7 | 未知/变化指纹阻断并显式确认 | Rust + E2E | `crates/ssh-core/tests/known_hosts.rs`（未知指纹一次性信任、变化阻断、并发替换条件更新）；E2E `app-shell.spec.ts`（`unknown host keys require explicit trust and a closed session can reconnect`、`changed host keys stay blocked until explicit fingerprint replacement`） | PASS | 真实服务器指纹与真实 MITM 场景需人工 |
| 8 | 每服务器最多 8 会话，切换服务器保活 | store + component + E2E | `terminal-store.test.ts`（`enforces the eight-session limit before asking Core for another channel`、`counts only live sessions toward the eight-session budget`）；`App.test.tsx`（`limits a server to eight terminals and preserves sessions when switching servers`）；E2E `integration-flow.spec.ts`（`keeps terminal output and monitor sort across tabs and server switches`） | PASS | E2E 验证 2 台服务器保活，8 个上限由 store/component 测试覆盖 |
| 9 | 复制粘贴、resize、断线提示、重连 | E2E + Rust + component | E2E `app-shell.spec.ts`（粘贴确认、单次键盘粘贴、断线后重连）；`crates/ssh-core/tests/terminal.rs`（输出、gap、close）；`App.test.tsx`（连接失败与重试） | PARTIAL | Windows WebView2 的真实剪贴板与 resize 需人工；renderer 只验证 Chromium 行为 |
| 10 | Ctrl+R 本机命令历史 | E2E + unit | `app-shell.spec.ts`（`selecting a server opens a live xterm with sessions, history, and keepalive`、`never records interactive input that the remote pty does not echo`）；`command-history.test.ts`、`command-tracking.test.ts` | PASS | 历史存于 IndexedDB，跨真实重启的保留未在 E2E 中验证 |
| 11 | 终端当前目录跳到文件 Tab | component + E2E | `App.test.tsx`（`jumps to the terminal OSC 7 directory when it is known`、回退根目录用例）；E2E `integration-flow.spec.ts`（`cd /etc` 后跳转，断言面包屑与 `nginx.conf`） | PASS | OSC 7 由 fixture 的 PTY 回显注入；真实 shell 的提示符集成需人工确认 |
| 12 | 文件树/面包屑/大小/时间/权限 | component + E2E | `file-browser.test.tsx`（目录优先、面包屑与树同步、按需展开）；E2E `app-shell.spec.ts`（文件列表 + Monaco）与 `integration-flow.spec.ts`（`etc` 面包屑） | PASS | 大目录滚动性能未做基准 |
| 13 | 上传、下载、新建目录、重命名、删除、危险确认 | Rust + component + E2E | `crates/ssh-core/tests/remote_files.rs`（no-replace、回滚、残留、符号链接）；`file-browser.test.tsx`（上传冲突/回滚/重命名/删除确认/焦点归还）；E2E `app-shell.spec.ts`（`file browser uploads, creates, renames, deletes, and rejects overwrite`） | PASS | 真实 SFTP 服务器的 `hardlink@openssh.com` 能力与权限差异需人工；不支持时 fail closed |
| 14 | Monaco 双击编辑并保存回远程 | component + E2E | `text-file-editor.test.tsx`（保存 hash、冲突保留草稿、重新加载）；E2E `integration-flow.spec.ts`（主流程保存成功、`keeps a conflicted draft and lets the user retry the save`） | PASS | 超大文件/二进制拒绝由 `file-browser.test.tsx` 覆盖，未进 E2E |
| 15 | 监控五卡 + 5 分钟曲线 | store + component + E2E | `monitor-store.test.ts`（150 点、时间窗、gap）；`monitor-panel.test.tsx`（实时值与过期）；E2E `integration-flow.spec.ts`（五卡、CPU 曲线 SVG、运行时间） | PASS | 曲线为确定性 fixture，不验证真实 2 秒节奏的长时间稳定性 |
| 16 | Top 10 进程按 CPU/内存排序 | store + E2E | `monitor-store.test.ts`（`sorts the union by CPU or memory with PID as a stable tie-breaker`）；E2E `integration-flow.spec.ts`（断言首行 `cpu-heavy` → 切内存后 `mem-heavy`，`aria-sort`） | PASS | 无 |
| 17 | Docker 容器状态/端口/启动时间 | E2E | `app-shell.spec.ts`（`lists Docker containers, reads both log streams, restarts, and execs into a terminal`）；`integration-flow.spec.ts`（主流程断言镜像与启动时间） | PASS | 真实 Docker daemon 的端口映射格式由 Rust 解析测试覆盖 |
| 18 | Docker start/stop/restart/logs/exec | E2E + store + Rust | E2E restart/logs/exec；`docker-store.test.ts`（stop、失败保留旧列表、迟到响应）；`crates/remote-adapters/tests/docker_parsing.rs`（命令与解析） | PARTIAL | `start` 与 `stop` 的完整 UI 流程没有独立 E2E；stop 由 store 测试覆盖，start 复用同一 action 通道，仍建议补一条 E2E |
| 19 | 切 Tab/服务器时终端与文件状态不丢 | component + E2E | `App.test.tsx`（`keeps all four tab panels mounted across tab and server switches`、`keeps a hidden Monaco draft and ignores its Escape key`、`keeps a hidden Docker log dialog open and ignores its Escape key`）；E2E `integration-flow.spec.ts`（终端输出与监控排序跨 Tab/服务器保持、后台服务器迟到快照被丢弃） | PASS | 跨服务器文件草稿隔离由 `file-browser.test.tsx` 的断开连接/连接变化用例覆盖，未做独立 E2E |
| 20 | ⌘K 搜索服务器、添加、导入 | E2E + component | `app-shell.spec.ts`（`Command-K opens the command palette and runs an action`）；`App.test.tsx`（`opens Command-K, searches servers, and supports arrow/Enter navigation`） | PASS | 非 macOS 平台的 Ctrl+K 由同一快捷键分支覆盖，未单独跑 Windows |
| 21 | 重启后服务器/分组/收藏保留 | Rust + E2E fake | `crates/persistence/tests/restart_persistence.rs`（关闭并重开 SQLite 文件后目录、分组、收藏、最近连接保留）；E2E `integration-flow.spec.ts`（`restores servers, groups, and favorites after a renderer reload`，并断言 localStorage 不含私钥） | PASS | renderer 的 reload 只证明元数据 fake 持久化；真实 Tauri 重启需人工 |
| 22 | 离线、连接失败、权限、SFTP 失败中文状态与动作 | E2E + component + store | E2E `integration-flow.spec.ts`（`shows explicit offline states with a reconnect action`、`retries a failed monitor sample without losing the panel`、`drops a late monitor sample from a background server`）；`App.test.tsx`（认证失败重试、Docker 离线/缺失/空）；`file-browser.test.tsx`（离线、目录读取失败重试）；`docker-store.test.ts`（权限拒绝文案） | PASS | 真实远端权限错误（sudo、SFTP chroot、Docker socket）需人工；错误码到中文文案已有单测 |
| 23 | Calibrated Panel 统一视觉 | E2E + manual | `app-shell.spec.ts`（侧栏 300px、shell 背景、Inter Tight、终端 IBM Plex Mono 与 screen 背景、旧入口不存在） | PARTIAL | 无截图基线/视觉回归；1440×900 与约 1100px 并排窗口、焦点态、对比度仍需人工审查 |

## 失败 / 重试路径

除快乐路径外，本次自动化至少覆盖以下失败与恢复动作：

- SSH 认证失败显示中文错误，点击“重试”后建立连接（`App.test.tsx`）。
- 未知/变化主机指纹阻断，显式信任后连接（E2E）。
- 监控采样首次失败，点击“立即重试”后恢复五卡（E2E）。
- Monaco 保存冲突保留草稿并提供“重试保存”（E2E）。
- 离线服务器的终端、文件、Docker 三个 Tab 均显示中文状态与重连动作（E2E）。
- 上传冲突不覆盖、部分失败回滚或残留可见（component + Rust）。
- 目录读取失败保留“重试目录”（component）。
- Docker 操作失败保留旧列表并显示错误（store）。

## 未验证与残余风险

1. **真实系统凭据库**：`crates/secrets/tests/store_contract.rs` 的 Keychain 用例被 `#[ignore]`，本次 `cargo test --workspace` 显示 1 ignored。需要在 macOS 与 Windows 上人工执行并确认凭据不落 SQLite/日志。
2. **真实 SSH/SFTP/Docker**：所有 renderer E2E 使用 fake `CoreClient`；真实网络、主机指纹、SFTP 扩展能力、Docker 权限仍需人工在目标服务器验证。
3. **Tauri 原生窗口**：`pnpm tauri build --debug` 只证明可构建；未做原生窗口自动化，renderer E2E 不驱动 Tauri。
4. **视觉审查**：无截图基线；Calibrated Panel 的 1440×900 与约 1100px 布局、焦点环、对比度需人工检查。
5. **Docker start/stop E2E**：restart/logs/exec 有 E2E；start/stop 主要靠 store 测试，建议后续补一条完整 UI 场景。
6. **构建体积**：`pnpm build:desktop` 产生 Monaco `editor.api` 约 2.65 MB、`text-file-editor` 约 1.23 MB 的 chunk 警告；不影响构建通过，但冷启动与内存占用未测量。
7. **平台差异**：本次门禁只在 macOS 运行；Windows 的 Credential Manager、WebView2 剪贴板/resize 由 CI 构建与后续人工验收覆盖。

## 测试分层与 CI

- `pnpm test`：desktop/contracts/config 的 Vitest + workspace smoke。
- `pnpm test:integration`：命令 manifest ↔ invoke handler ↔ capability ↔ 权限文件，以及 Rust serde ↔ Zod 契约；无测试时失败。
- `pnpm test:e2e:renderer`：Chromium 渲染进程用户流，`reuseExistingServer: false` 且 Vite `--strictPort`，避免复用 1421 的旧 fixture。
- `cargo test --workspace`：Rust 领域、持久化、SSH/SFTP、监控/Docker 解析与命令层。
- CI 显式执行以上各层，并在最后运行 `pnpm tauri build --debug`。
