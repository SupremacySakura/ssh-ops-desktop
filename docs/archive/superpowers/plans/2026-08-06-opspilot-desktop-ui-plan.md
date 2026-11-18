# OpsPilot 桌面 UI 与端到端闭环实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 7 张桌面高保真设计稿实现为可键盘操作、可缩放、可连接真实 Rust Core 的 OpsPilot 桌面工作区，并跑通 MVP 端到端主路径。

**Architecture:** 功能按 `features/*` 垂直切片；所有 Tauri command/event 通过 `api/core-client.ts` 与共享契约进入 TanStack Query 或按 run/session 隔离的 Zustand store。组件包只含无业务权限的视觉组件；人工远端写操作先向 Core 创建 manual run + ToolCall，再由 feature 层展示 OperationGateway 返回的 RiskDecision/ApprovalRequest，UI 不接触 adapter executor。

**Tech Stack:** React/TypeScript/Vite、TanStack Router/Query、Zustand、Tailwind CSS、Radix/shadcn 组件、xterm.js、Monaco、ECharts、React Testing Library、Vitest、Playwright（renderer fixture/visual）、WebdriverIO Tauri service（native binary）。

## Global Constraints

- 生产环境标识持续可见；颜色不是唯一状态信号，状态同时有图标/文字。
- 所有危险按钮置于二级区域；批量操作显示资源数、服务器/环境和影响范围。
- macOS 使用 Command、Windows 使用 Ctrl；快捷键可配置且不能抢占终端常用组合。
- WebLink 只允许 http/https，交给系统浏览器并要求修饰键；不在高权限 WebView 加载远程页面。
- 终端、文件、Docker、Nginx 的人工操作在 Agent 不可用时仍完全可用。
- 目标视口覆盖 1280×720、1440×900、1920×1080；缩放 80%-200% 不遮挡主操作。
- 测试断言真实可见状态、持久化结果和副作用；不把“mock 被调用”当作用户行为证据。
- Playwright 只驱动 Vite/Chromium renderer fixture；真实 Tauri command/WebView 由 WebdriverIO embedded provider 驱动，真实 SSH/Docker/Nginx 副作用由 Rust external-fixture 集成脚本验证，三类证据禁止混称。
- UI 不自行计算/降低风险；所有结构化操作显示 Rust `RiskDecision.level/reason/confirmationText`。L4 只显示不可执行原因且没有确认按钮。

---

## 设计稿映射

| 图号 | 页面 | 必须保留的信息层级 |
|---|---|---|
| 15-1 | 服务器总览 | KPI、资源趋势、服务器健康、最近活动、告警、快捷入口 |
| 15-2 | 服务器管理 | 环境/地域/标签/状态筛选、服务器表、右侧详情、快速操作 |
| 15-3 | 远程终端 | 连接信息、多标签终端、命令片段、右侧 Agent 辅助/审批 |
| 15-4 | 项目管理 | 项目表、部署流水线、发布历史、详情与快捷操作 |
| 15-5 | Docker | KPI、容器/镜像表、右侧容器详情、日志和操作 |
| 15-6 | Nginx | 安全变更流程、站点表、源码、站点详情、变更历史 |
| 15-7 | AI Agent | 工具、对话、执行计划、审批中心、Trace |

## 文件责任映射

| 路径 | 唯一责任 |
|---|---|
| `packages/ui` | Button/Dialog/Table/Status/Panel 等纯视觉组件和 token |
| `apps/desktop/src/app` | Router、Provider、AppShell、全局命令面板 |
| `apps/desktop/src/api` | Tauri CoreClient、event subscription、fixture client |
| `apps/desktop/src/features/dashboard` | 图 15-1 |
| `apps/desktop/src/features/servers` | 图 15-2、连接/指纹表单 |
| `apps/desktop/src/features/terminal` | 图 15-3、xterm session store |
| `apps/desktop/src/features/files` | SFTP/Monaco/Diff/传输 |
| `apps/desktop/src/features/projects` | 图 15-4 |
| `apps/desktop/src/features/docker` | 图 15-5 |
| `apps/desktop/src/features/nginx` | 图 15-6 |
| `apps/desktop/src/features/agent` | 图 15-7 |
| `apps/desktop/src/features/tasks` | 全局任务、审计与错误详情 |

### Task 1: 建立设计系统、AppShell 与服务器总览

**Files:**
- Create: `packages/ui/src/tokens.css`
- Create: `packages/ui/src/components/{button,dialog,status-badge,data-table,side-panel,metric-card}.tsx`
- Create: `packages/ui/src/index.ts`
- Create: `packages/ui/src/components/status-badge.test.tsx`
- Create: `apps/desktop/src/app/router.tsx`
- Create: `apps/desktop/src/app/app-shell.tsx`
- Create: `apps/desktop/src/app/command-palette.tsx`
- Create: `apps/desktop/src/app/risk-decision-dialog.tsx`
- Create: `apps/desktop/src/app/risk-decision-dialog.test.tsx`
- Create: `apps/desktop/src/api/core-client.ts`
- Create: `apps/desktop/src/api/fixture-client.ts`
- Create: `apps/desktop/src/api/event-sequence.ts`
- Create: `apps/desktop/src/api/event-sequence.test.ts`
- Create: `apps/desktop/src/features/dashboard/dashboard-page.tsx`
- Create: `apps/desktop/src/features/dashboard/dashboard-page.test.tsx`
- Create: `apps/desktop/src/features/dashboard/queries.ts`
- Create: `docs/design/reference/desktop/README.md`
- Create: `tests/e2e/renderer/dashboard.visual.spec.ts`

**Interfaces:**
- Consumes: `system_metrics`、server list、task/audit/alert summaries，以及各 Core event envelope 的 `streamId/sequence`、authoritative query/replay policy。
- Produces: `SequenceTracker::{accept,drop_old,detect_gap,resubscribe}`、左导航、全局搜索、环境切换、通知/用户区、Dashboard route `/dashboard`。

- [ ] **Step 1: 写真实 Dashboard 行为失败测试**

```tsx
it('keeps production context visible while showing partial metric failures', async () => {
  renderApp('/dashboard', fixtureClient({
    environment: 'production',
    dashboard: fullDashboardFixture({ network: { status: 'unavailable', reason: 'ss missing' } })
  }));
  expect(await screen.findByText('生产环境')).toBeVisible();
  expect(screen.getByRole('heading', { name: '服务器总览' })).toBeVisible();
  expect(screen.getByText('网络指标暂不可用')).toBeVisible();
  expect(screen.getByRole('table', { name: '服务器健康状态' })).toBeVisible();
});
```

这个测试会在页面忽略字段级失败、隐藏生产环境或整体报错时失败。另写 `event-sequence.test.ts`：1→3 必须产生 gap 而不是静默接受；断线重订阅时先建立 live buffer，再按上次 cursor 补拉/Query snapshot，按 sequence 去重合并，最后释放 buffered live event；旧事件只 drop，不触发倒退。

- [ ] **Step 2: 运行测试并确认页面缺失**

Run: `pnpm --filter @opspilot/desktop test --run src/features/dashboard/dashboard-page.test.tsx`  
Expected: FAIL，因 Dashboard/AppShell 未实现。

- [ ] **Step 3: 实现 token 与 AppShell**

- token 至少包含 `--color-primary:#1677ff`、成功/警告/危险、文本三级、surface/border、4/8/12/16/24 间距、6/10 圆角、紧凑/默认两种 density。
- 左导航顺序固定：仪表盘、服务器、终端、AI Agent、项目、Docker、Nginx、日志、设置；折叠后仍有 accessible name 和 tooltip。
- 全局搜索支持服务器/项目/命令/日志入口，`Cmd/Ctrl+K` 打开；结果按权限只导航，不在前端执行命令。
- 环境切换影响 query scope，并把 ProductionChip 固定显示在顶部和任何危险 Dialog 中。
- RiskDecisionDialog 原样显示 Core 的 level/reason/confirmationText/目标/digest；L1-L3 渲染各自确认交互，L4 只有“产品不提供结构化执行”的阻断说明。组件不得接受 `overrideRisk`、`snapshotRequired` 等写入参数。
- L3 输入框的校验目标只取 `ApprovalRequest.confirmationTarget`，提交为 `ApprovalProof.confirmedResource`；`confirmationText` 只渲染、不可解析。L1/L2 不渲染资源名输入，目标/digest 变化后必须丢弃旧 approval。
- `SequenceTracker` 按 stream 隔离 cursor：`sequence <= last` 丢弃，`sequence == last+1` 接受，`sequence > last+1` 标记 gap 并暂停向 store 应用。task/log 使用 03 的 `task_events_since` 补拉；connection/metrics/docker/agent state 通过 TanStack Query invalidate + authoritative snapshot 重同步。终端 bytes 无法安全补造时显示“输出可能缺段”、记录 gap 并从后续 sequence 继续，禁止静默填 0/拼接伪数据。
- WebView resume/IPC 重连采用 subscribe-and-buffer → replay/refetch → sequence merge/dedupe → release live buffer；replay retention 不足时清空该 stream 派生状态并强制 authoritative Query snapshot。所有路径要有断线发生在 subscribe 与 snapshot 之间的竞争测试。

- [ ] **Step 4: 实现 Dashboard 内容与状态**

实现在线服务器、CPU 平均、内存使用、异常告警 KPI；6h/24h/7d/custom 资源趋势；最近活动；健康表；告警中心。数据 unavailable 显示字段级原因与重试，不用 0 冒充。

- [ ] **Step 5: 验证视觉、键盘与多视口**

Run: `pnpm --filter @opspilot/desktop test --run && pnpm exec playwright test tests/e2e/renderer/dashboard.visual.spec.ts --project=chromium`  
Expected: renderer fixture 在 1280/1440/1920 三视口无横向页面溢出；Tab 顺序从全局操作到主内容；状态均有文字；旧序号、空洞、重连补拉、retention 不足 Query 重同步全部 PASS。该结果不作为 Tauri/SSH 证据。

- [ ] **Step 6: 提交任务**

```bash
git add packages/ui apps/desktop/src/app apps/desktop/src/api apps/desktop/src/features/dashboard docs/design/reference/desktop tests/e2e/renderer/dashboard.visual.spec.ts
git commit -m "feat: 实现 OpsPilot 桌面总览壳"
```

### Task 2: 实现服务器管理、编辑和主机指纹确认

**Files:**
- Create: `apps/desktop/src/features/servers/server-list-page.tsx`
- Create: `apps/desktop/src/features/servers/server-table.tsx`
- Create: `apps/desktop/src/features/servers/server-form.tsx`
- Create: `apps/desktop/src/features/servers/server-detail-panel.tsx`
- Create: `apps/desktop/src/features/servers/host-key-dialog.tsx`
- Create: `apps/desktop/src/features/servers/server-list-page.test.tsx`
- Create: `apps/desktop/src/features/servers/host-key-dialog.test.tsx`
- Create: `apps/desktop/src/features/servers/queries.ts`
- Create: `apps/desktop/src/features/servers/mutations.ts`
- Create: `tests/e2e/renderer/server-connection.spec.ts`

**Interfaces:**
- Consumes: server CRUD、connection test、Unknown/Changed host key response。
- Produces: `/servers`、server create/edit/delete、detail side panel、trust dialog。

- [ ] **Step 1: 写筛选与 changed-key 阻断失败测试**

```tsx
it('blocks connection when a verified fingerprint changes', async () => {
  renderApp('/servers', fixtureClientWithChangedHostKey());
  await user.click(await screen.findByRole('button', { name: '连接 web-01' }));
  expect(await screen.findByRole('alertdialog', { name: '主机指纹已变化' })).toBeVisible();
  expect(screen.getByText('SHA256:old')).toBeVisible();
  expect(screen.getByText('SHA256:new')).toBeVisible();
  expect(screen.queryByRole('button', { name: '直接连接' })).not.toBeInTheDocument();
});
```

另测环境+地域+标签+状态组合筛选，断言真实表格行和结果计数。

- [ ] **Step 2: 运行测试并确认服务器 feature 缺失**

Run: `pnpm --filter @opspilot/desktop test --run src/features/servers`  
Expected: FAIL，因页面和 Dialog 未实现。

- [ ] **Step 3: 实现图 15-2 信息架构**

- 顶部新增服务器、批量导入、AI 巡检、批量执行；批量写操作继续走 Core RiskDecision，不在本任务实现快捷绕过。
- 批量导入先展示逐行 preview、重复项和错误原因，只有勾选的有效行可 apply；CSV/JSON 中的 password/private key 列一律拒绝并提示改用凭据输入。
- 表格列：选择、名称/用途、IP、OS、地域、标签、CPU/内存/磁盘、连接状态、认证方式、最近检查、菜单。
- 右侧详情 tabs：概览、监控、配置、脚本、历史；概览含脱敏指纹、磁盘挂载、快捷终端/SFTP/部署/重启和最近事件。
- ServerForm 按 auth type 显示 password/private-key/agent/certificate 字段；保存后立即清空秘密 input。

- [ ] **Step 4: 实现 TOFU 对话**

Unknown 对话显示 host/port/algorithm/SHA256，用户明确“信任并连接”；Changed 对话没有直接继续按钮，只提供复制指纹、关闭、进入服务器编辑/人工核验。确认绑定 verificationId，过期后重新连接获取新 challenge。

- [ ] **Step 5: 运行 UI 与连接状态 renderer 契约**

Run: `pnpm --filter @opspilot/desktop test --run src/features/servers && pnpm exec playwright test tests/e2e/renderer/server-connection.spec.ts`  
Expected: fixture 驱动的 CRUD、筛选、Unknown 信任、Changed 阻断和 secret input 清空全部 PASS；真实 SSH/TOFU 证据仍来自 `tests/integration/run-ssh.sh`。

- [ ] **Step 6: 提交任务**

```bash
git add apps/desktop/src/features/servers tests/e2e/renderer/server-connection.spec.ts
git commit -m "feat: 实现服务器管理与指纹确认"
```

### Task 3: 实现多标签终端、Agent 辅助栏与 SFTP 编辑

**Files:**
- Create: `apps/desktop/src/features/terminal/terminal-page.tsx`
- Create: `apps/desktop/src/features/terminal/terminal-session.tsx`
- Create: `apps/desktop/src/features/terminal/session-store.ts`
- Create: `apps/desktop/src/features/terminal/paste-guard.tsx`
- Create: `apps/desktop/src/features/terminal/terminal-page.test.tsx`
- Create: `apps/desktop/src/features/terminal/broadcast-input.test.tsx`
- Create: `apps/desktop/src/features/files/file-manager-page.tsx`
- Create: `apps/desktop/src/features/files/file-editor.tsx`
- Create: `apps/desktop/src/features/files/save-diff-dialog.tsx`
- Create: `apps/desktop/src/features/files/transfer-panel.tsx`
- Create: `apps/desktop/src/features/files/file-manager.test.tsx`
- Create: `tests/e2e/renderer/terminal-file.spec.ts`

**Interfaces:**
- Consumes: terminal commands/events、file commands、Agent run L0/approval events。
- Produces: `/terminal/:serverId?`、`/files/:serverId`；session layout 和 transfer UI。

- [ ] **Step 1: 写乱序终端事件与粘贴保护失败测试**

```ts
it('drops old terminal chunks without affecting another tab', () => {
  const store = createSessionStore();
  store.open('tab-a', 'server-a');
  store.open('tab-b', 'server-a');
  store.onData({ terminalSessionId: 'tab-a', sequence: 2, bytesBase64: b64('two') });
  store.onData({ terminalSessionId: 'tab-a', sequence: 1, bytesBase64: b64('one') });
  expect(store.get('tab-a').chunks).toEqual(['two']);
  expect(store.get('tab-b').chunks).toEqual([]);
});
```

UI 测试对所有多行、含换行/控制字符或超过字节阈值的粘贴统一显示目标服务器、行数和内容预览，确认前终端内容不变；前端不解析命令文本并判断“危险等级”。另测广播输入默认 off、开启时目标数量/完整服务器列表/Production warning 持续可见，切换服务器或新开标签不会自动加入广播目标。

- [ ] **Step 2: 运行测试并确认 store/page 缺失**

Run: `pnpm --filter @opspilot/desktop test --run src/features/terminal src/features/files`  
Expected: FAIL，因 session store/file manager 未实现。

- [ ] **Step 3: 实现图 15-3 终端工作区**

- 顶部显示连接服务器/IP/环境/系统/时长/延迟；操作为断开、重连、更多。
- 标签可新建、关闭、重命名、固定和分屏；每个 pane 单独 xterm/fit/search/web-links addon 与 ResizeObserver。
- terminal:data 解码为 bytes 写入绑定 terminal；断线保留屏幕并显示遮罩，不自动重放输入。
- 命令历史/常用片段在底部；广播输入默认 off，开启时持续显示目标数量、明确目标列表和 Production warning；语义风险仍只来自 Rust，paste/broadcast guard 只是无条件传输安全提示。
- 右侧 Agent 只读取当前明确选择的输出片段；写建议渲染为 ApprovalCard，不能直接注入终端。

- [ ] **Step 4: 实现 SFTP、Monaco 和保存前 Diff**

- 双栏模式含 breadcrumb、元数据、拖拽、冲突选择和 transfer panel；删除/权限/owner 走风险确认。
- upload/save/rename/move/copy/delete/chmod/chown/archive/extract mutation 都先创建 manual run + ToolCall，只调用 `operation_prepare/operation_approve`；CoreClient 不暴露同名直达执行方法。
- 大文件显示部分预览或 tail，不启动 Monaco 全量模型。
- 保存必须展示 remote baseline vs edited unified Diff；baseline mtime/hash 变化时返回冲突并要求重新加载/另存，不能覆盖。
- transfer 显示进度、速度、取消、重试、resume 不可用原因。

- [ ] **Step 5: 运行单元与终端/SFTP renderer 契约**

Run: `pnpm --filter @opspilot/desktop test --run src/features/terminal src/features/files && pnpm exec playwright test tests/e2e/renderer/terminal-file.spec.ts`  
Expected: 多标签无串流、resize、paste guard、断线手动重连、上传/下载、冲突 Diff 全部 PASS。

- [ ] **Step 6: 提交任务**

```bash
git add apps/desktop/src/features/terminal apps/desktop/src/features/files tests/e2e/renderer/terminal-file.spec.ts
git commit -m "feat: 实现终端与远程文件工作区"
```

### Task 4: 实现项目管理与部署时间线

**Files:**
- Create: `apps/desktop/src/features/projects/project-page.tsx`
- Create: `apps/desktop/src/features/projects/project-table.tsx`
- Create: `apps/desktop/src/features/projects/project-form.tsx`
- Create: `apps/desktop/src/features/projects/deployment-pipeline.tsx`
- Create: `apps/desktop/src/features/projects/release-history.tsx`
- Create: `apps/desktop/src/features/projects/deploy-plan-dialog.tsx`
- Create: `apps/desktop/src/features/projects/project-page.test.tsx`
- Create: `tests/e2e/renderer/project-deploy.spec.ts`

**Interfaces:**
- Consumes: `project.detect/create/status/logs`、`deploy.plan/run/rollback` ToolCall/Gateway 结果与 task events。
- Produces: `/projects` 与图 15-4 主路径。

- [ ] **Step 1: 写部署计划和失败回滚可见性测试**

```tsx
it('shows exact target, commands and rollback after a failed health check', async () => {
  renderApp('/projects', fixtureClientWithFailedDeployment());
  await user.click(await screen.findByRole('row', { name: /用户中心/ }));
  expect(screen.getByText('健康检查失败')).toBeVisible();
  expect(screen.getByText('已恢复 releases/001')).toBeVisible();
  expect(screen.getByRole('button', { name: '查看失败日志' })).toBeEnabled();
});
```

- [ ] **Step 2: 运行测试并确认项目页面缺失**

Run: `pnpm --filter @opspilot/desktop test --run src/features/projects`  
Expected: FAIL。

- [ ] **Step 3: 实现图 15-4 主页面**

- 项目表列：名称/仓库/分支/环境/部署方式/运行时/当前版本/健康/最近部署。
- 详情显示基本信息、快捷部署/重启/回滚/日志/健康检查和发布历史。
- 详情 tabs 还包括环境变量：普通值可编辑，secret 只显示 `已配置` 并通过 SecretStore mutation 更新；任何列表、Diff 和部署计划只展示 secret 键名。
- 流水线逐步显示 preflight、source/build、artifact、switch/restart、health；每步显示状态、时长、日志入口。
- 原设计稿中的 K8s 项仅作为 future/unsupported badge，不在 MVP 伪造操作；支持类型为 Compose、Static、Node、Go、Python、Generic。

- [ ] **Step 4: 实现计划确认与回滚**

DeployPlanDialog 显示 target、version、commands、files、hooks、impact、risk、snapshot/rollback；prepare 先创建 manual run + ToolCall，argsDigest 改变时使旧批准失效。回滚是新 ToolCall/独立任务并显示目标 release/image/config。

- [ ] **Step 5: 验证项目 renderer 契约**

Run: `pnpm --filter @opspilot/desktop test --run src/features/projects && pnpm exec playwright test tests/e2e/renderer/project-deploy.spec.ts`  
Expected: detect/create/plan/approve/progress/success，以及 health fail/automatic restore 两条路径 PASS。

- [ ] **Step 6: 提交任务**

```bash
git add apps/desktop/src/features/projects tests/e2e/renderer/project-deploy.spec.ts
git commit -m "feat: 实现项目部署与发布历史"
```

### Task 5: 实现 Docker、Nginx、任务与审计工作区

**Files:**
- Create: `apps/desktop/src/features/docker/docker-page.tsx`
- Create: `apps/desktop/src/features/docker/container-detail-panel.tsx`
- Create: `apps/desktop/src/features/docker/docker-page.test.tsx`
- Create: `apps/desktop/src/features/nginx/nginx-page.tsx`
- Create: `apps/desktop/src/features/nginx/nginx-editor.tsx`
- Create: `apps/desktop/src/features/nginx/nginx-change-dialog.tsx`
- Create: `apps/desktop/src/features/nginx/nginx-page.test.tsx`
- Create: `apps/desktop/src/features/tasks/task-center.tsx`
- Create: `apps/desktop/src/features/tasks/audit-page.tsx`
- Create: `apps/desktop/src/features/tasks/task-center.test.tsx`
- Create: `tests/e2e/renderer/docker-nginx.spec.ts`

**Interfaces:**
- Consumes: Docker/Nginx command/event、Task/Audit contracts。
- Produces: `/docker`、`/nginx`、`/tasks`、`/logs`。

- [ ] **Step 1: 写破坏性默认值和 Nginx 失败路径测试**

```tsx
it('never preselects destructive Docker cleanup resources', async () => {
  renderApp('/docker', fixtureClientWithUnusedResources());
  await user.click(screen.getByRole('button', { name: '清理未使用' }));
  expect(screen.getAllByRole('checkbox', { checked: false }).length).toBeGreaterThan(0);
  expect(screen.getByRole('button', { name: '执行清理' })).toBeDisabled();
});
```

Nginx 测试注入 `nginx -t` failure，断言 live 配置/版本/健康状态未变且错误详情可复制。

- [ ] **Step 2: 运行测试并确认页面缺失**

Run: `pnpm --filter @opspilot/desktop test --run src/features/docker src/features/nginx src/features/tasks`  
Expected: FAIL。

- [ ] **Step 3: 实现图 15-5 Docker**

KPI 为 running/stopped/images/volumes/resource；容器表支持 search/status/server/filter，右侧 detail tabs 为 overview/logs/env/volumes/network；独立 tabs 覆盖 images/networks/volumes/Compose。Start/stop/restart/remove/Exec/Compose apply 都创建 manual run + ToolCall，risk 由 Core 返回；UI 显示命令/目标而不自行分类。日志和 stats 事件按 containerId+sequence 隔离。

- [ ] **Step 4: 实现图 15-6 Nginx**

页面固定显示 snapshot → `nginx -t` → reload → health 的安全链；站点表、源码编辑、站点详情、upstream、rewrite、SSL 摘要、访问控制和历史。ChangeDialog 只消费 `nginx.apply` ToolCall 的 PreparedOperation，必须先显示 Diff 和 validation；只有 Core 返回可应用状态才启用确认。复杂配置显示 source-only badge。

- [ ] **Step 5: 实现 Task/Audit**

Task center 以状态/服务器/项目/风险筛选，显示 step、progress、取消/重试/rollback 可用原因；Audit 以 action/resource/server/result/time 展示脱敏 payload、snapshot 和 args digest。不能显示密码、Token、私钥或完整环境变量。

- [ ] **Step 6: 运行 UI 与跨模块 renderer 契约**

Run: `pnpm --filter @opspilot/desktop test --run src/features/docker src/features/nginx src/features/tasks && pnpm exec playwright test tests/e2e/renderer/docker-nginx.spec.ts`  
Expected: Docker 日志/重启、Compose plan、Nginx valid apply、invalid zero-overwrite、rollback、Task/Audit 全部 PASS。

- [ ] **Step 7: 提交任务**

```bash
git add apps/desktop/src/features/docker apps/desktop/src/features/nginx apps/desktop/src/features/tasks tests/e2e/renderer/docker-nginx.spec.ts
git commit -m "feat: 实现 Docker Nginx 与任务审计界面"
```

### Task 6: 实现 Agent 工作区、设置、无障碍与 MVP E2E

**Files:**
- Create: `apps/desktop/src/features/agent/agent-page.tsx`
- Create: `apps/desktop/src/features/agent/conversation.tsx`
- Create: `apps/desktop/src/features/agent/execution-plan.tsx`
- Create: `apps/desktop/src/features/agent/approval-center.tsx`
- Create: `apps/desktop/src/features/agent/trace-table.tsx`
- Create: `apps/desktop/src/features/agent/agent-page.test.tsx`
- Create: `apps/desktop/src/features/settings/model-settings.tsx`
- Create: `apps/desktop/src/features/settings/security-settings.tsx`
- Create: `apps/desktop/src/features/settings/preferences-settings.tsx`
- Create: `apps/desktop/src/features/settings/diagnostics.tsx`
- Create: `apps/desktop/src/features/settings/model-settings.test.tsx`
- Create: `tests/e2e/renderer/mvp-flow.spec.ts`
- Create: `tests/e2e/renderer/accessibility.spec.ts`
- Create: `tests/e2e/native/mvp-flow.e2e.ts`
- Modify: `tests/e2e/native/wdio.conf.ts`
- Create: `docs/qa/mvp-acceptance-matrix.md`

**Interfaces:**
- Consumes: Agent/Model/Approval events and commands；所有 MVP feature routes。
- Produces: `/agent`、`/settings`；完整 MVP 验收证据。

- [ ] **Step 1: 写审批摘要与降级失败测试**

```tsx
it('keeps manual operations available when the Agent is degraded', async () => {
  renderApp('/agent', fixtureClient({ agent: { available: false, reason: 'crash_loop' } }));
  expect(await screen.findByRole('alert')).toHaveTextContent('AI Agent 暂不可用');
  expect(screen.getByRole('link', { name: '打开终端' })).toHaveAttribute('href', '/terminal');
  expect(screen.getByRole('button', { name: '重试 Agent' })).toBeEnabled();
});
```

审批测试必须检查 server/target/command or args/impact/risk/snapshot，拒绝后 Trace 显示 rejected 且任务列表无执行项。

- [ ] **Step 2: 运行测试并确认 Agent/Settings 页面缺失**

Run: `pnpm --filter @opspilot/desktop test --run src/features/agent src/features/settings`  
Expected: FAIL。

- [ ] **Step 3: 实现图 15-7 Agent 工作区**

- 顶部工具 chips 来自 Rust tool catalog，不硬编码权限。
- 左列对话与 plan summary，中列执行步骤/目标/影响，右列仅待审批与历史；底部 Trace 显示 run、tool、target、duration、token usage（若 Provider 提供）、result。
- ApprovalCard 复用全局 RiskDecisionDialog：始终显示 Rust 返回的 reason/confirmationText；L1/L2 显示批准/拒绝；L3 额外资源名输入和 snapshot 状态；L4 只有阻断原因、人工终端风险提示且没有批准入口；argsDigest 变化自动失效。
- run cancel 与 task cancel 分开；不可安全取消的 task 显示原因。

- [ ] **Step 4: 实现模型与安全设置**

Model settings 包含 Provider/Base URL/API Key/Model/timeout/test；API Key input 保存后清空，只显示 `已配置`。明确展示数据会发往哪个 Provider/Base URL、最小上下文和脱敏边界。Diagnostics 生成前预览具体文件/字段并默认关闭遥测。

Preferences 覆盖主题、终端字体/字号/主题、快捷键、默认 Shell、KeepAlive、并发任务数、代理、更新通道、日志级别与隐私；快捷键冲突在保存前列出，代理密码仍走 SecretStore，改变更新通道需显示对应签名 manifest 来源。

- [ ] **Step 5: 分层跑 renderer、真实 Tauri binary 与远端 fixtures**

`renderer/mvp-flow.spec.ts` 使用 fixture client 验证可见交互：创建服务器 → Unknown 指纹确认 → 终端 → SFTP → 项目 → Docker 日志 → Nginx invalid/valid → Agent L0 → L2 reject/approve → L3 snapshot → L4 blocked → Sidecar degraded/manual terminal。它不声称执行 Rust 或真实 SSH。

`native/mvp-flow.e2e.ts` 用 WebdriverIO embedded provider 启动真实 debug Tauri binary，覆盖 core_health、ToolCall prepare/approval IPC、窗口重启后 pending approval 恢复和 Sidecar degraded/manual route；远端真实副作用由 02/03 的 external fixture 脚本单独证明。

Run:

```bash
pnpm --filter @opspilot/desktop test --run
pnpm exec playwright test tests/e2e/renderer/mvp-flow.spec.ts tests/e2e/renderer/accessibility.spec.ts
pnpm typecheck
pnpm lint
pnpm tauri build --debug
pnpm test:e2e:native
bash tests/integration/run-ssh.sh
bash tests/integration/run-deploy.sh
bash tests/integration/run-docker-write.sh
bash tests/integration/run-nginx.sh
```

Expected: 全部 PASS；renderer axe 无 critical/serious violation；native IPC/重启恢复通过；四组 external fixtures 分别提供 SSH/部署/Docker/Nginx 副作用证据；键盘可到达所有关键操作；200% 缩放无不可达 Dialog 按钮。

- [ ] **Step 6: 逐条填写 MVP 验收矩阵**

`mvp-acceptance-matrix.md` 对设计文档标题“`## 20. MVP 验收标准`”（按标题匹配）每一项记录证据类别（unit/renderer/native/external-fixture/双平台手工）、测试文件/用例名或手工步骤、最新证据日期和结果；不得只写“已完成”，也不得用 renderer 证据替代 native/remote 证据。

- [ ] **Step 7: 提交任务**

```bash
git add apps/desktop/src/features/agent apps/desktop/src/features/settings tests/e2e docs/qa/mvp-acceptance-matrix.md
git commit -m "feat: 完成 Agent 工作区与 MVP 验收"
```

## 完成检查

- [ ] 7 张桌面设计稿的主信息层级均映射到可运行 route。
- [ ] Production 环境在顶部、详情、终端和危险 Dialog 中持续可见。
- [ ] Agent unavailable 时终端、文件、Docker、Nginx E2E 仍通过。
- [ ] 终端/日志/Agent 事件按 session/container/run sequence 隔离。
- [ ] 所有危险确认内容来自 Rust RiskDecision，UI 无降低风险的入口。
- [ ] RiskDecision.confirmationText 在 L1-L4 均有消费路径，L4 无批准按钮。
- [ ] 1280/1440/1920 与 80%-200% 缩放通过视觉/可访问性检查。
- [ ] `pnpm tauri build --debug` 与 WebdriverIO native 在 macOS/Windows 均有新鲜证据。
- [ ] 设计文档标题“`## 20. MVP 验收标准`”每条 MVP 验收项都有类别正确的具体证据。
