# OpsPilot Beta、发布与移动设计验证实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把桌面 MVP 提升为可发布 Beta：强化部署回滚、监控/告警、加密导出、诊断、双平台签名更新，并把 7 张移动设计稿转换为可运行但不连接生产 Core 的响应式验证原型。

**Architecture:** Beta 能力继续复用 TaskEngine、Snapshotter、RiskDecision 和 CoreClient；发布矩阵在原生 macOS/Windows runner 构建对应 Node Sidecar runtime 与 Tauri 包。移动设计单独放入 fixture-only Vite workspace，不获得 Tauri command、SecretStore 或网络权限，防止在安全架构缺失时误发布为运维客户端。

**Tech Stack:** Rust/Tokio、ECharts、加密归档、Tauri Updater/Bundler、GitHub Actions、SBOM、Playwright（移动/renderer）、WebdriverIO Tauri service（安装后 native smoke）、React responsive prototype、Storybook（可选仅开发依赖）。

## Global Constraints

- 应用关闭后不承诺持续告警；Beta 只在应用运行期间采集与通知。
- 默认导出不含密码、私钥、Token、模型 Key；敏感导出必须显式选择并设置独立口令。
- 诊断包生成前必须展示文件/字段预览，默认遥测关闭。
- macOS 产物覆盖 Apple Silicon 与 Intel；Windows 覆盖 x64；Sidecar 与主应用同批签名、同批更新。
- 更新 manifest 和包必须签名；数据库 migration 前先备份。migration/startup health 失败通过 recovery bootstrap 恢复数据并安装已保留、签名验证通过的上一版本；若新 binary 无法启动，只承诺明确的外部恢复安装器，不宣称 Tauri Updater 自动回滚。
- `apps/mobile-prototype` 不导入 Tauri/CoreClient、不发网络请求、不进入桌面 bundle 或安装包。
- 具有真实写权限的移动客户端必须等待单独批准的移动安全/同步规格和实施计划。

---

## 文件责任映射

| 路径 | 唯一责任 |
|---|---|
| `crates/remote-adapters/src/monitoring.rs` | 应用运行期间指标采集、阈值与 health |
| `crates/export` | 配置导出/导入、加密和诊断包 |
| `src-tauri/src/updater.rs` | 更新检查、签名验证、migration backup/rollback |
| `.github/workflows/release.yml` | 原生构建、SBOM、签名、notarization、发布 |
| `apps/mobile-prototype` | 7 个移动 fixture 页面和响应式/触控验证 |
| `packages/adapter-api` | P3 内置适配器版本化契约 |
| `docs/future` | 移动、证书、计划任务、同步、团队版决策包 |

### Task 1: 强化发布策略、健康检查与故障注入

**Files:**
- Modify: `package.json`
- Modify: `crates/remote-adapters/src/deploy.rs`
- Modify: `crates/remote-adapters/src/docker/compose.rs`
- Modify: `crates/remote-adapters/src/health.rs`
- Modify: `crates/remote-adapters/tests/health.rs`
- Create: `crates/remote-adapters/tests/release_retention.rs`
- Create: `tests/integration/deploy/fault_matrix.rs`
- Create: `tests/integration/run-fault-matrix.sh`
- Modify: `tests/integration/Cargo.toml`
- Modify: `packages/contracts/src/deploy.ts`
- Modify: `packages/contracts/src/health.ts`
- Create: `docs/operations/deployment-runbook.md`

**Interfaces:**
- Consumes: P1 DeployWorkflow、TaskEngine、Snapshotter、03 Task 4 `HealthChecker/HealthCheckPolicy`。
- Produces: `HealthCheckPolicy`、release retention、Compose image/config rollback、故障矩阵证据。

```rust
pub struct HealthCheckPolicy {
    pub url: Url,
    pub expected_status: RangeInclusive<u16>,
    pub interval: Duration,
    pub request_timeout: Duration,
    pub deadline: Duration,
    pub success_threshold: u8,
    pub failure_threshold: u8,
}
```

- [ ] **Step 1: 写抖动健康检查和 Compose 回滚失败测试**

```rust
#[tokio::test]
async fn requires_consecutive_health_successes_before_committing_release() {
    let health = scripted_health([Ok(200), Err("reset"), Ok(200), Ok(200), Ok(200)]);
    let result = checker(policy_with_success_threshold(3), health).run().await.unwrap();
    assert_eq!(result.attempts, 5);
}
```

Compose 测试记录 old image digest + normalized config，更新后 health fail，断言两者均恢复，不只恢复 YAML 文本。

- [ ] **Step 2: 运行测试并确认 threshold/rollback 缺失**

Run: `cargo test -p opspilot-remote-adapters release_retention && cargo test -p opspilot-remote-adapters health && cargo test -p opspilot-remote-adapters compose`  
Expected: FAIL，因连续阈值与完整 Compose snapshot 未实现。

- [ ] **Step 3: 实现 Beta 发布可靠性**

- health 默认 interval 2s、request_timeout 2s、success 3、failure 3、deadline 60s；用户可调 deadline 但限制 1-300s，单次 request_timeout 不能越过剩余 deadline。达到 deadline 即返回 TIMEOUT 并进入既定补偿/回滚，不得由阈值循环无限延长。
- ReleaseSymlink 至少保留 current + previous；failed release 保留 24h 或手动清理，清理为独立 L2 task。
- Compose snapshot 保存 normalized config、env key 引用、image repo digest 和运行服务集；回滚按 digest 拉起旧服务并重新 health。
- rollback 失败进入 RollbackFailed，显示远端真实状态检查结果和人工 runbook，不能假称恢复成功。

- [ ] **Step 4: 运行完整故障注入**

`run-fault-matrix.sh` 启动 deploy/Compose external fixtures、等待 health、执行 `cargo test -p opspilot-integration-tests --features external-fixtures --test fault_matrix -- --ignored --test-threads=1`，并用 trap 清理。

Run: `bash tests/integration/run-fault-matrix.sh`  
Expected: disk full、Git/build fail、process restart fail、间歇 health、永久 health、SSH disconnect、rollback fail 七种场景都有确定终态和审计。

- [ ] **Step 5: 提交任务**

```bash
git add package.json crates/remote-adapters packages/contracts/src/deploy.ts tests/integration/Cargo.toml tests/integration/deploy tests/integration/run-fault-matrix.sh docs/operations/deployment-runbook.md
git commit -m "feat: 强化 Beta 部署与回滚可靠性"
```

### Task 2: 实现运行期监控、桌面告警、加密导出与诊断包

**Files:**
- Create: `crates/remote-adapters/src/monitoring.rs`
- Create: `crates/remote-adapters/tests/monitoring.rs`
- Create: `crates/export/Cargo.toml`
- Create: `crates/export/src/lib.rs`
- Create: `crates/export/src/archive.rs`
- Create: `crates/export/src/diagnostics.rs`
- Create: `crates/export/tests/archive.rs`
- Create: `src-tauri/src/commands/export.rs`
- Create: `src-tauri/src/commands/diagnostics.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/main.json`
- Modify: `apps/desktop/package.json`
- Create: `src-tauri/tests/notification_capability.rs`
- Create: `packages/contracts/src/monitoring.ts`
- Create: `packages/contracts/src/export.ts`
- Create: `apps/desktop/src/features/monitoring/monitoring-page.tsx`
- Create: `apps/desktop/src/features/settings/export-settings.tsx`
- Create: `tests/integration/performance/desktop_capacity.rs`
- Modify: `tests/integration/Cargo.toml`
- Create: `tests/e2e/renderer/capacity.spec.ts`
- Create: `docs/qa/performance-budget.md`

**Interfaces:**
- Consumes: metrics/systemd/docker/project health、SecretStore、Redactor。
- Produces: threshold evaluation、desktop notification、encrypted export/import、diagnostic preview/create。

- [ ] **Step 1: 写持续阈值与导出泄漏失败测试**

```rust
#[test]
fn alert_requires_threshold_duration_and_resolves_once() {
    let mut evaluator = AlertEvaluator::new(rule("disk", 90.0, Duration::from_secs(300)));
    for minute in 0..4 { assert!(evaluator.observe(at(minute), 95.0).is_none()); }
    assert!(matches!(evaluator.observe(at(5), 95.0), Some(AlertEvent::Triggered { .. })));
    assert!(matches!(evaluator.observe(at(6), 40.0), Some(AlertEvent::Resolved { .. })));
}
```

归档测试保存服务器+项目+SecretStore fixture，解密 archive 后断言默认包没有 secret 值、secret_ref account、私钥路径正文和未脱敏日志。

- [ ] **Step 2: 运行测试并确认监控/归档缺失**

Run: `cargo test -p opspilot-remote-adapters monitoring && cargo test -p opspilot-export`  
Expected: FAIL。

- [ ] **Step 3: 实现运行期监控与通知**

- Polling 前台 10s、后台 60s，可配置并发；应用退出即停止，不承诺离线告警。
- 阈值覆盖 CPU、memory、disk、load、container exit、project health、certificate expiry；事件包含 server/project/current/duration/suggestion。
- desktop notification 点击只导航到本地 route；内容不含敏感日志/IP（除非用户允许显示主机标签）。
- 注册 `tauri-plugin-notification` 时只给 main window 增加 `notification:allow-is-permission-granted`、`notification:allow-request-permission`、`notification:allow-notify`、`notification:allow-register-listener`，不使用 `notification:default`；`lib.rs` 显式初始化 plugin，桌面包显式依赖 `@tauri-apps/plugin-notification`。capability 测试解析 `main.json`，断言无 batch/channel/remove 等未使用权限、无 remote origin，并验证拒绝系统权限时退化为应用内告警。
- ECharts 数据使用 bounded ring buffer；缺失值断线显示，不补 0。
- 默认容量固定为建连并发 8、活跃 SSH transport 16、terminal channel 32、监控轮询并发 8；100 台服务器 metadata 场景下额外请求排队并有 backpressure，不得无界 spawn。

- [ ] **Step 4: 实现导出与诊断**

- 默认 archive 只含 versioned manifest、server/project metadata、非敏感 settings；使用随机 salt + Argon2id 派生 key、XChaCha20-Poly1305 加密、每包唯一 nonce。
- 用户选择敏感导出时从 SecretStore 读取并要求独立口令，不允许复用登录/SSH/model key；UI 明示包含项。
- import 先解密到内存/受限临时目录、验证 schema/checksum/version，展示 dry-run Diff 后事务写入；冲突按 skip/replace/rename。
- diagnostic preview 列出 app/OS versions、脱敏配置、crash/error 文件与大小；创建时再次 Redactor，默认不含 DB、终端、完整 Agent prompt。

- [ ] **Step 5: 运行安全、UI 与容量验证**

`performance-budget.md` 固定记录测量环境与阈值：100 台 metadata 首屏本地查询 p95≤300ms；常用筛选/切换交互 p95≤200ms；8 个 polling worker 不超过并发上限；16 transports + 32 channels 的 10 分钟事件压测无串流、无丢 sequence、无无界队列。冷启动的 2 秒指标仍只到可交互 AppShell，Sidecar ready 单独记录。

Run:

```bash
cargo test -p opspilot-export
cargo test -p opspilot-remote-adapters monitoring
cargo test -p opspilot-integration-tests --test desktop_capacity
pnpm --filter @opspilot/desktop test --run src/features/monitoring src/features/settings/export-settings
pnpm exec playwright test tests/e2e/renderer/capacity.spec.ts
```

Expected: PASS；错误口令、篡改 ciphertext、旧 schema、冲突和 secret scan 均有测试；容量/延迟阈值有机器可读断言与本次测量证据。

- [ ] **Step 6: 提交任务**

```bash
git add Cargo.toml Cargo.lock crates/export crates/remote-adapters packages/contracts src-tauri/Cargo.toml src-tauri/src/lib.rs src-tauri/src/commands src-tauri/capabilities/main.json src-tauri/tests/notification_capability.rs apps/desktop/package.json apps/desktop/src/features/monitoring apps/desktop/src/features/settings/export-settings.tsx tests/integration/Cargo.toml tests/integration/performance tests/e2e/renderer/capacity.spec.ts docs/qa/performance-budget.md
git commit -m "feat: 增加监控告警与安全导出"
```

### Task 3: 建立原生 Sidecar、签名、SBOM 与安全更新流水线

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `.github/workflows/update-smoke.yml`
- Create: `scripts/download-node-runtime.mjs`
- Create: `scripts/verify-bundle-contents.mjs`
- Create: `scripts/generate-sbom.mjs`
- Create: `src-tauri/src/updater.rs`
- Create: `src-tauri/src/recovery_bootstrap.rs`
- Create: `src-tauri/tests/migration_rollback.rs`
- Create: `src-tauri/tests/signed_downgrade.rs`
- Modify: `src-tauri/tauri.conf.json`
- Create: `docs/release/signing-and-secrets.md`
- Create: `docs/release/release-checklist.md`

**Interfaces:**
- Consumes: Node runtime preparation、Tauri build、Database migrations。
- Produces: macOS arm64/x64 与 Windows x64 signed candidate、SBOM、每通道 signed update manifest、migration recovery 与受限 signed downgrade smoke。

- [ ] **Step 1: 写 bundle 内容与 migration 回退失败测试**

`verify-bundle-contents.mjs` 解包/列举候选包并验证：主应用、单一 target Node runtime、Agent bundle、licenses 存在；`.env`、测试 fixture、源码 map、任意 key/password fixture 不存在。Rust migration 测试用故意失败 migration，断言 recovery bootstrap 恢复备份后旧 schema 可打开；signed downgrade 测试必须拒绝错误通道 key、未签名包和任意版本 URL。

- [ ] **Step 2: 运行本地 debug 检查并确认脚本/回退缺失**

Run: `pnpm tauri build --debug && node scripts/verify-bundle-contents.mjs <debug-bundle> && cargo test -p opspilot-desktop migration_rollback`  
Expected: FAIL，因 verifier/updater rollback 未实现。

- [ ] **Step 3: 实现原生 build matrix**

- macOS jobs：`macos-14` 构建 `aarch64-apple-darwin`，GitHub 标准 Intel label `macos-15-intel` 构建并测试 `x86_64-apple-darwin`；Windows job `windows-2025` 构建 `x86_64-pc-windows-msvc`。workflow 预检仓库可用 runner label；不可用时 release gate 明确失败并要求配置受保护的 x64 macOS self-hosted/larger runner，禁止在 ARM job 只交叉编译后伪称 Intel install smoke 已通过。
- 每个 job 下载固定 Node 24 LTS 官方归档与 `SHASUMS256.txt`，验证后只提取 node executable，按 target triple 命名。
- 先 bundle Agent JS，再 `tauri build --target`；禁止在一个平台伪造其他平台 Node binary。
- SBOM 工具和版本固定：Rust 使用 `cargo-cyclonedx 0.5.9`；pnpm workspace 与解包后的最终安装包使用 `@cyclonedx/cdxgen 12.3.1`。release workflow 校验下载资产 checksum/attestation 或执行 `--version` 精确比对，禁止 `latest`。`generate-sbom.mjs` 依次生成 `opspilot-rust.cdx.json`、`opspilot-js.cdx.json`、每个 target 的 `opspilot-installer-$TARGET.cdx.json`；installer 先复用 bundle verifier 解包到临时目录，再以 rootfs 模式扫描。三份 CycloneDX JSON 都要 schema validate、license allowlist、唯一 bom-ref、主组件/版本/target 元数据和 secret scan，任一空 components 或工具版本漂移即阻断发布。

- [ ] **Step 4: 实现签名与更新门**

release workflow 只在受保护 tag/手动审批触发；OS 代码签名身份固定为 `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`、`WINDOWS_CERTIFICATE`、`WINDOWS_CERTIFICATE_PASSWORD`。Tauri update 分别使用 `TAURI_SIGNING_PRIVATE_KEY_STABLE`/`TAURI_SIGNING_PRIVATE_KEY_STABLE_PASSWORD`、`TAURI_SIGNING_PRIVATE_KEY_BETA`/`TAURI_SIGNING_PRIVATE_KEY_BETA_PASSWORD`、`TAURI_SIGNING_PRIVATE_KEY_NIGHTLY`/`TAURI_SIGNING_PRIVATE_KEY_NIGHTLY_PASSWORD`；三个 public key + manifest origin 编译进 Rust allowlist，运行时按 channel 选择 updater builder，不能从 UI/远程 manifest 覆盖。PR CI 不访问这些秘密。

更新顺序：下载并按所选 channel public key 验证签名 → 检查磁盘 → 在 app-private recovery 目录保留当前版本的已签名安装器/manifest/checksum → 备份 DB/配置 → 安装 → recovery bootstrap 执行 migration → 写 health marker → 进入主 UI。migration 或 bootstrap health 失败时先恢复 DB/配置，再用 Tauri updater `version_comparator` 只允许安装 recovery manifest 中的精确上一版本并复核同通道签名，重启后删除 recovery ticket。

边界必须写入 UI/runbook：若新 executable 连 recovery bootstrap 都无法启动，应用内无法自救；用户运行预先保留的签名安装器或从同一官方 manifest 下载上一版本。计划不得把这条人工灾难恢复路径描述为“Updater 自动恢复旧可执行版本”。

- [ ] **Step 5: 验证候选包与更新回退**

Run: release workflow dry-run（无发布）+ macOS arm64/macOS x64/Windows x64 三类原生 runner 的 install/launch/uninstall + update-smoke 从 N-1 fixture 升级到候选再注入 migration fail。  
Expected: 正常升级保留数据；migration/bootstrap health 失败在能启动 recovery bootstrap 时自动恢复数据并签名降级；不可启动 binary 的演练生成可用的人工恢复安装器与步骤；全部包通过 OS 签名验证和 bundle verifier。

- [ ] **Step 6: 提交任务**

```bash
git add .github/workflows scripts src-tauri docs/release
git commit -m "build: 建立双平台签名与安全更新"
```

### Task 4: 将 7 张移动设计稿实现为 fixture-only 响应式原型

**Files:**
- Create: `apps/mobile-prototype/package.json`
- Create: `apps/mobile-prototype/src/main.tsx`
- Create: `apps/mobile-prototype/src/router.tsx`
- Create: `apps/mobile-prototype/src/fixture-client.ts`
- Create: `apps/mobile-prototype/src/mobile-shell.tsx`
- Create: `apps/mobile-prototype/src/pages/{home,servers,terminal,projects,docker,nginx,agent}.tsx`
- Create: `apps/mobile-prototype/src/mobile.css`
- Create: `apps/mobile-prototype/src/mobile.test.tsx`
- Create: `tests/e2e/mobile-visual.spec.ts`
- Create: `tests/e2e/mobile-interaction.spec.ts`
- Create: `tests/e2e/mobile.playwright.config.ts`
- Create: `docs/design/reference/mobile/README.md`
- Create: `docs/future/mobile-threat-model.md`
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json`
- Modify: `src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: 共享 UI token、完整 fixture DTO；不消费真实 CoreClient。
- Produces: 390×844、393×852、430×932 可运行的 7 个设计验证 route；移动架构决策输入。

- [ ] **Step 1: 写“不能连接生产 Core”与布局失败测试**

```ts
it('uses fixture data and exposes no production execution transport', async () => {
  render(<MobileApp client={createFixtureClient()} initialPath="/terminal" />);
  expect(await screen.findByText('交互原型，不连接服务器')).toBeVisible();
  expect(screen.getByRole('button', { name: '批准执行' })).toHaveAttribute('aria-disabled', 'true');
});
```

构建测试扫描 dependency graph，若 `@tauri-apps/api`、`core-client.ts`、`model-providers`、`SecretStore` 或网络 fetch 出现在 mobile bundle 则失败。这是安全边界行为，不是简单 grep 源文件：测试实际构建 metafile/import graph。

- [ ] **Step 2: 运行测试并确认 prototype 缺失**

Run: `pnpm --filter @opspilot/mobile-prototype test --run`  
Expected: FAIL，因 MobileApp/fixture client 未实现。

- [ ] **Step 3: 实现共用移动壳与前三屏**

- 底部固定五栏：首页、服务器、终端、Agent、我的；尊重 safe-area inset，44×44 最小触控目标。
- 首页：环境/通知/用户、四 KPI、资源趋势、最近活动。
- 服务器：环境 chips、状态筛选、紧凑列表、选中服务器 bottom sheet、指纹/指标/挂载/快捷操作；写快捷操作在 prototype disabled。
- 终端：服务器/连接摘要、横向 session tabs、terminal viewport、常用命令、折叠 Agent 助手和审批卡；软键盘出现时保持输入与最近输出可见。

- [ ] **Step 4: 实现项目、Docker、Nginx、Agent 四屏**

- 项目：搜索/filter、项目列表、选中项目流水线、当前版本/历史/操作。
- Docker：四 KPI、搜索/filter、容器列表、bottom sheet 详情、资源/端口/挂载。
- Nginx：安全发布流程、操作栏、站点表、站点卡、源码预览。
- Agent：工具 chips、对话、纵向执行计划、审批 cards、Trace；全部使用 fixture，批准按钮只打开风险说明。

- [ ] **Step 5: 运行移动视觉/交互验证**

`mobile.playwright.config.ts` 使用独立 `webServer` 启动 mobile-prototype preview、独立 output/snapshot 目录，并且只定义 mobile Chromium projects 与 390×844、393×852、430×932 viewport；不得继承 renderer/Tauri fixture 的 baseURL、reporter 或 webServer。根脚本新增 `test:e2e:mobile="playwright test -c tests/e2e/mobile.playwright.config.ts"`。

Run:

```bash
pnpm --filter @opspilot/mobile-prototype test --run
pnpm --filter @opspilot/mobile-prototype build
pnpm test:e2e:mobile
```

Expected: 7 routes × 3 viewport × portrait/landscape 无横向溢出；bottom sheet 可键盘关闭；软键盘、安全区、离线、200% text scale、axe serious/critical 全通过；bundle import graph 无生产 Core。

- [ ] **Step 6: 完成移动威胁模型**

`mobile-threat-model.md` 必须对以下问题给出可评审方案和明确禁止项：设备凭据存储、是否直接 SSH、Mastra 运行位置、与桌面配对/同步协议、端到端加密、丢失设备、远程撤销、后台任务、移动通知、截图/剪贴板、越狱/root、审批防重放。结论未批准前，release workflow 显式拒绝 `apps/mobile-prototype` 进入产物。

- [ ] **Step 7: 提交任务**

```bash
git add apps/mobile-prototype tests/e2e/mobile-* docs/design/reference/mobile docs/future/mobile-threat-model.md package.json pnpm-workspace.yaml src-tauri/tauri.conf.json
git commit -m "feat: 建立移动设计安全验证原型"
```

### Task 5: 定义 P3 Adapter API 与 P4 规格决策包

**Files:**
- Create: `packages/adapter-api/src/manifest.ts`
- Create: `packages/adapter-api/src/index.ts`
- Create: `packages/adapter-api/src/manifest.test.ts`
- Create: `crates/remote-adapters/src/certificate_probe.rs`
- Create: `crates/remote-adapters/src/adapter_manifest.rs`
- Create: `crates/remote-adapters/tests/adapter_manifest.rs`
- Create: `docs/future/adapter-api-v1.md`
- Create: `docs/future/certificate-automation-spec.md`
- Create: `docs/future/scheduled-operations-spec.md`
- Create: `docs/future/e2ee-sync-spec.md`
- Create: `docs/future/team-rbac-spec.md`

**Interfaces:**
- Consumes: ToolDefinition、OperationGateway、Rust RiskPolicy、TaskEngine、AuditWriter。
- Produces: 仅内置/签名 Adapter API v1、一个只读证书探测样例，以及 P4 可进入 brainstorming 的完整规格输入。

```ts
export interface AdapterManifestV1 {
  apiVersion: 1;
  id: string;
  version: string;
  capabilities: string[];
  operations: Array<{
    name: string; mode: 'read' | 'write'; minimumRisk: RiskLevel;
    inputSchemaVersion: 1;
  }>;
}
```

- [ ] **Step 1: 写 Adapter 不能降低风险失败测试**

```ts
it('rejects a manifest that classifies a write below the core minimum', () => {
  const parsed = validateManifest(manifest({
    operations: [{ name: 'certificate.replace', mode: 'write', minimumRisk: 'L0', inputSchemaVersion: 1 }]
  }), coreMinimumRisks);
  expect(parsed.success).toBe(false);
});
```

Rust 对同一 fixture 再测一次：manifest 把 `certificate.replace` 声明 L0 时，编译进 registry 也必须返回 `VALIDATION`；即使 TS validator 被绕过，OperationGateway 仍按 Core minimum 得到 L3 且执行次数为 0。

- [ ] **Step 2: 运行测试并确认 validator 缺失**

Run: `pnpm --filter @opspilot/adapter-api test --run && cargo test -p opspilot-remote-adapters --test adapter_manifest`  
Expected: FAIL。

- [ ] **Step 3: 实现受限 Adapter API v1**

- P3 只加载随应用签名、编译进 Rust registry 的 Adapter；不加载用户下载的动态本地代码。
- TS manifest 只用于作者反馈；Rust `AdapterManifest::validate_against(&CoreMinimumRiskTable)` 才是加载门。manifest 只能提高 minimumRisk，不能降低 Core；OperationGateway 每次 prepare 仍重算风险，不能信任加载时结果。
- write 必须通过 `ToolExecutor.prepare` 返回 `ToolAction::Write`，其中 OperationPlan 带原 ToolCall IDs/digest/environment/resourceScope；Adapter 不能直接持有 ConnectionManager/RemoteExecutor，也不能注册直达 Tauri command。
- certificate_probe 仅 L0 读取证书路径/issuer/expiry/hostname，验证 API/version/capability/审计；ACME 写操作不在样例中。

- [ ] **Step 4: 写完整后续规格而非实现占位**

- 证书规格：ACME account secret、HTTP-01/DNS-01 Provider、challenge cleanup、Nginx snapshot、renewal window、rollback。
- 计划任务规格：本地 scheduler、missed-run、锁、睡眠/关机、RiskDecision、预授权上限、禁止 L3 无人在场执行。
- E2EE 同步规格：设备身份、密钥层级/轮换、server/project CRDT 或冲突策略、secret 默认不同步、撤销与恢复。
- 团队 RBAC 规格：tenant、role、resource scope、审批 quorum、audit retention、密钥托管、离线行为和数据驻留。

每份规格包含目标/非目标、威胁模型、数据模型、API、失败/恢复、迁移、测试与验收；分别通过 `superpowers:brainstorming` 后才能创建实施计划。

- [ ] **Step 5: 验证并提交任务**

Run: `pnpm --filter @opspilot/adapter-api test --run && cargo test -p opspilot-remote-adapters --test adapter_manifest && cargo test -p opspilot-remote-adapters certificate_probe`  
Expected: PASS；样例 Adapter 无写入口。

```bash
git add packages/adapter-api crates/remote-adapters/src/certificate_probe.rs crates/remote-adapters/src/adapter_manifest.rs crates/remote-adapters/tests/adapter_manifest.rs docs/future
git commit -m "docs: 固化 P3 适配器与 P4 规格边界"
```

## 完成检查

- [ ] 发布/Compose 故障矩阵所有失败点都有真实恢复证据。
- [ ] 告警只在应用运行期间承诺，缺失值不补 0。
- [ ] 默认导出和诊断包不含任何秘密；敏感导出使用独立口令和 AEAD。
- [ ] 三个原生 target 的 Sidecar runtime 都来自校验过的 Node 官方归档。
- [ ] 桌面通知只拥有列出的四项 capability；系统拒绝通知权限时应用内告警仍可用。
- [ ] 签名、notarization/AuthentiCode、三类 CycloneDX SBOM、更新和 migration rollback 均有证据，SBOM 工具版本与空组件检查通过。
- [ ] stable/beta/nightly update key、manifest origin 和 recovery package 相互隔离；错误通道/错误 key 降级被拒绝。
- [ ] 7 个移动页面完成 3 viewport、横竖屏、触控与无障碍验证。
- [ ] mobile E2E 通过独立 Playwright config/script 运行，未继承 desktop renderer/native fixture。
- [ ] mobile bundle 无 Tauri/CoreClient/network，并被 release workflow 排除。
- [ ] P3 Adapter 在 TS 与 Rust 双层只能提高风险，Gateway 运行时仍重算；P4 每项都有单独规格且未混入 MVP。
