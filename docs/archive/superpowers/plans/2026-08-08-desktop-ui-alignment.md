# OpsPilot Desktop UI Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the OpsPilot desktop shell and seven core workspaces to match the approved Feishu desktop designs while preserving every existing Core-backed workflow and safety gate.

**Architecture:** Keep `App` as the route and shared-data owner, add a small dependency-free UI component layer under `app/ui`, and compose each feature page from those primitives. Lists and operational data continue to come from `CoreClient`; page-local selection drives non-destructive right-side detail panes, while existing dialogs remain responsible for destructive confirmations.

**Tech Stack:** React 19, TypeScript 6, CSS, inline SVG, Vitest, Testing Library, Playwright, WebdriverIO, Tauri 2, pnpm 10, Node.js 24.

## Global Constraints

- Do not introduce a third-party UI framework, icon package, or chart package.
- Do not fabricate servers, metrics, alerts, deployments, containers, sites, traces, or activity records.
- Preserve all existing `CoreClient` calls and Rust-side authorization, approval, snapshot, and host-key boundaries.
- Keep production-environment status persistently visible and express status with text or icons in addition to color.
- Keep the terminal viewport and code/log surfaces dark; use the approved light high-density workspace elsewhere.
- Target the seven desktop reference screens at 1448×1086; mobile layouts are out of scope.
- Preserve the uncommitted xterm prototype-freeze fix and its renderer/native regression coverage.
- Do not stage or commit during execution without the user's explicit confirmation. Commit commands below are review checkpoints only.

## File Map

**Create**

- `apps/desktop/src/app/icons.tsx` — typed inline SVG icon set used by navigation, controls, metrics, and status elements.
- `apps/desktop/src/app/ui/layout.tsx` — page header, panel, section header, metric card, filter bar, detail pane, progress bar, and empty-state primitives.
- `apps/desktop/src/app/ui/layout.test.tsx` — accessibility and interaction tests for the primitive layer.
- `apps/desktop/src/app/app-shell.test.tsx` — navigation, environment, search, Core status, and sidebar-collapse behavior.

**Modify**

- `apps/desktop/src/styles.css` — design tokens, shell, primitives, page layouts, density, responsive desktop rules, and focus states.
- `apps/desktop/src/app/app-shell.tsx` — approved light shell, SVG navigation, top toolbar, persistent environment/Core state.
- `apps/desktop/src/App.tsx` and `apps/desktop/src/App.test.tsx` — shell status props and page navigation actions.
- `apps/desktop/src/features/dashboard/dashboard-page.tsx` and test — compact overview and real-data operational panels.
- `apps/desktop/src/features/servers/server-list-page.tsx` and test — filter bar, selected row, right-side details, unchanged mutations.
- `apps/desktop/src/features/terminal/terminal-page.tsx` and test — connection strip, terminal/assistant split, unchanged xterm lifecycle.
- `apps/desktop/src/features/agent/agent-page.tsx` and test — tool strip, three-column workspace, approval queue, trace area.
- `apps/desktop/src/features/projects/project-page.tsx` and test — project list, pipeline state, right-side details.
- `apps/desktop/src/features/docker/docker-page.tsx` and test — real metrics, selected container details, unchanged approval gateway.
- `apps/desktop/src/features/nginx/nginx-page.tsx` and test — safe-change stepper, editor/list area, site/config details.
- `apps/desktop/src/features/files/file-manager-page.tsx` and test — shared toolbar/panel treatment.
- `apps/desktop/src/features/tasks/task-center.tsx` and test — shared table/status/detail treatment.
- `apps/desktop/src/features/settings/model-settings.tsx` and test — shared form/panel treatment.
- `tests/e2e/renderer/app-shell.spec.ts` — shell and seven-page rendering assertions.
- `tests/e2e/native/app-shell.e2e.ts` — native navigation and terminal regression assertions.

---

### Task 1: Build the dependency-free UI foundation

**Files:**

- Create: `apps/desktop/src/app/icons.tsx`
- Create: `apps/desktop/src/app/ui/layout.tsx`
- Create: `apps/desktop/src/app/ui/layout.test.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**

- Produces: `Icon({ name, size, className })`, where `name` is the exported `IconName` union.
- Produces: `PageHeader`, `Panel`, `SectionHeader`, `MetricCard`, `FilterBar`, `DetailPane`, `ProgressBar`, and `EmptyState` React components.
- Consumes: standard React props only; no `CoreClient` and no feature-specific data.

- [ ] **Step 1: Write failing primitive tests**

Create `app/ui/layout.test.tsx` with concrete tests for accessible labels, detail-pane closing, progress semantics, and real child content:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DetailPane, MetricCard, PageHeader, ProgressBar } from './layout';

afterEach(cleanup);

describe('desktop UI primitives', () => {
  it('renders a structured page heading and metric without inventing a trend', () => {
    render(<><PageHeader title="服务器总览" description="实时运维状态" actions={<button>新增服务器</button>} /><MetricCard label="在线服务器" value="3" detail="来自 Core" icon="server" /></>);
    expect(screen.getByRole('heading', { name: '服务器总览' })).toBeVisible();
    expect(screen.getByText('来自 Core')).toBeVisible();
    expect(screen.queryByText(/趋势/u)).not.toBeInTheDocument();
  });

  it('closes a labelled detail pane and exposes progress semantics', () => {
    const onClose = vi.fn();
    render(<DetailPane title="web-01" onClose={onClose}><ProgressBar label="内存" value={42} /></DetailPane>);
    expect(screen.getByRole('complementary', { name: 'web-01 详情' })).toBeVisible();
    expect(screen.getByRole('progressbar', { name: '内存' })).toHaveAttribute('aria-valuenow', '42');
    fireEvent.click(screen.getByRole('button', { name: '关闭 web-01 详情' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @opspilot/desktop test -- src/app/ui/layout.test.tsx
```

Expected: FAIL because `./layout` and the components do not exist.

- [ ] **Step 3: Implement icons and primitives**

Define a closed icon union in `icons.tsx` and render every icon as decorative unless the caller supplies its own visible label:

```tsx
import type { ReactNode } from 'react';

export type IconName = 'activity' | 'agent' | 'alert' | 'bell' | 'box' | 'chevron-down' | 'close' | 'collapse' | 'dashboard' | 'docker' | 'file' | 'help' | 'history' | 'nginx' | 'project' | 'search' | 'server' | 'settings' | 'terminal' | 'user';

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    activity: <path d="M3 12h4l2-6 4 12 2-6h6" />,
    agent: <><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /><circle cx="12" cy="12" r="4" /></>,
    alert: <><path d="M12 3 2.8 20h18.4L12 3Z" /><path d="M12 9v4M12 17h.01" /></>,
    bell: <><path d="M6 9a6 6 0 0 1 12 0v5l2 3H4l2-3V9Z" /><path d="M10 20h4" /></>,
    box: <><path d="m4 7 8-4 8 4-8 4-8-4Z" /><path d="M4 7v10l8 4 8-4V7M12 11v10" /></>,
    'chevron-down': <path d="m7 10 5 5 5-5" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    collapse: <path d="m14 7-5 5 5 5" />,
    dashboard: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    docker: <><path d="M4 15h13c2 0 3-1 4-3-1 0-2 0-3-1" /><path d="M5 11h3v3H5zM9 11h3v3H9zM13 11h3v3h-3zM9 7h3v3H9zM13 7h3v3h-3z" /></>,
    file: <><path d="M5 3h9l5 5v13H5V3Z" /><path d="M14 3v5h5" /></>,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.2 2.4c-.7.3-.7.8-.7 1.6M12 17h.01" /></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
    nginx: <><path d="m12 2 8.7 5v10L12 22l-8.7-5V7L12 2Z" /><path d="M8 16V8l8 8V8" /></>,
    project: <><path d="M3 6h7l2 2h9v11H3V6Z" /><path d="M3 10h18" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m16 16 5 5" /></>,
    server: <><rect x="3" y="4" width="18" height="6" rx="2" /><rect x="3" y="14" width="18" height="6" rx="2" /><path d="M7 7h.01M7 17h.01" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></>,
    terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M12 16h5" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  };
  return <svg aria-hidden="true" className={className} fill="none" height={size} viewBox="0 0 24 24" width={size} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">{paths[name]}</svg>;
}
```

Implement the primitive prop contracts in `layout.tsx`:

```tsx
import type { ReactNode } from 'react';

export interface DetailPaneProps { title: string; subtitle?: string; onClose(): void; children: ReactNode }
export interface MetricCardProps { label: string; value: ReactNode; detail: string; icon: IconName; tone?: 'primary' | 'success' | 'warning' | 'danger' | 'ai' }
export interface PageHeaderProps { title: string; description: string; actions?: ReactNode; eyebrow?: string }
export interface ProgressBarProps { label: string; value: number; detail?: string }
```

Add exact CSS tokens for `--app-bg`, `--surface`, `--surface-subtle`, `--sidebar-width: 216px`, `--topbar-height: 64px`, `--primary`, five semantic tones, cool-gray borders, 4px spacing increments, and focus-visible rings. Scope primitive selectors under `.ui-*` names so existing page rules can be migrated safely.

- [ ] **Step 4: Run focused tests and static checks**

Run:

```bash
pnpm --filter @opspilot/desktop test -- src/app/ui/layout.test.tsx
pnpm --filter @opspilot/desktop typecheck
pnpm --filter @opspilot/desktop lint
```

Expected: all commands PASS with no warnings.

- [ ] **Step 5: Review checkpoint**

Present the primitive diff and test output. If the user separately confirms a commit, use:

```bash
git add apps/desktop/src/app/icons.tsx apps/desktop/src/app/ui/layout.tsx apps/desktop/src/app/ui/layout.test.tsx apps/desktop/src/styles.css
git commit -m "feat(ui): 建立桌面端设计系统基础"
```

### Task 2: Rebuild the global application shell

**Files:**

- Create: `apps/desktop/src/app/app-shell.test.tsx`
- Modify: `apps/desktop/src/app/app-shell.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/App.test.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**

- Consumes: `Icon` from Task 1.
- Produces: `AppShellProps` with `coreReady: boolean` and `coreVersion: string` in addition to current route, environment, navigation, and children props.
- Preserves: the `WorkspaceRoute` union and hash navigation behavior.

- [ ] **Step 1: Write failing shell tests**

Create `app-shell.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './app-shell';

afterEach(cleanup);

describe('AppShell', () => {
  it('renders the approved navigation and persistent production context', () => {
    const onNavigate = vi.fn();
    render(<AppShell route="dashboard" environment="production" coreReady coreVersion="0.1.0" onEnvironmentChange={vi.fn()} onNavigate={onNavigate}><h1>服务器总览</h1></AppShell>);
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeVisible();
    expect(screen.getByRole('button', { name: '搜索服务器、项目或命令' })).toBeVisible();
    expect(screen.getByText('生产环境')).toBeVisible();
    expect(screen.getByText('Core 0.1.0')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '服务器' }));
    expect(onNavigate).toHaveBeenCalledWith('servers');
  });
});
```

Extend `App.test.tsx` to assert that the loaded Core version appears inside the toolbar and that health rejection still replaces the shell with the existing error state.

- [ ] **Step 2: Run shell tests and verify RED**

Run:

```bash
pnpm --filter @opspilot/desktop test -- src/app/app-shell.test.tsx src/App.test.tsx
```

Expected: FAIL because the new shell props and toolbar labels do not exist.

- [ ] **Step 3: Implement the light high-density shell**

Replace Unicode navigation symbols with `IconName`, give each navigation button its visible accessible label, and structure the shell as:

```tsx
<div className="app-shell">
  <aside className="sidebar">
    <div className="window-controls" aria-hidden="true"><i /><i /><i /></div>
    <div className="brand"><span className="brand-mark"><Icon name="activity" /></span><span>OpsPilot</span></div>
    <nav aria-label="主导航">{navigationButtons}</nav>
    <div className="license-card"><strong>OpsPilot Community</strong><span>本地优先 · Core 已连接</span></div>
    <button className="collapse-button" type="button"><Icon name="collapse" /><span>收起侧栏</span></button>
  </aside>
  <div className="workspace">
    <header className="topbar">{searchButton}{environmentPicker}{productionMarker}{coreState}{notificationButton}{userMenu}</header>
    <main className="main-content">{children}</main>
  </div>
</div>
```

Keep the existing ten routes, including Files and Tasks, even though the reference navigation combines some operational history concepts. Pass `healthState.health.version` and `ready` into `AppShell`; remove the old duplicated `.core-summary` block.

- [ ] **Step 4: Run shell regression tests**

Run:

```bash
pnpm --filter @opspilot/desktop test -- src/app/app-shell.test.tsx src/App.test.tsx
pnpm --filter @opspilot/desktop typecheck
```

Expected: PASS; health rejection must still leave no `正在检查 Core` text.

- [ ] **Step 5: Review checkpoint**

After approval to commit:

```bash
git add apps/desktop/src/app/app-shell.tsx apps/desktop/src/app/app-shell.test.tsx apps/desktop/src/App.tsx apps/desktop/src/App.test.tsx apps/desktop/src/styles.css
git commit -m "feat(ui): 重构桌面端全局工作台"
```

### Task 3: Establish the dashboard and server-catalog visual baseline

**Files:**

- Modify: `apps/desktop/src/features/dashboard/dashboard-page.tsx`
- Modify: `apps/desktop/src/features/dashboard/dashboard-page.test.tsx`
- Modify: `apps/desktop/src/features/servers/server-list-page.tsx`
- Modify: `apps/desktop/src/features/servers/server-list-page.test.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**

- Consumes: all Task 1 primitives and the existing `CoreClient`, `ServerSummary`, and `ConnectedServer` types.
- Produces: `DashboardPage` navigation callbacks `onOpenTerminal?: () => void` and `onOpenAgent?: () => void`.
- Preserves: all server create, update, delete, import, connection, credential, private-key, and host-key flows.

- [ ] **Step 1: Write failing dashboard and catalog tests**

Add these behavioral assertions to the existing page tests:

```tsx
it('uses real metrics and routes dashboard quick actions', () => {
  const onOpenTerminal = vi.fn();
  render(<DashboardPage agent={{ agentAvailable: false, reason: 'not configured' }} connections={[]} core={{} as CoreClient} onAddServer={vi.fn()} onOpenAgent={vi.fn()} onOpenTerminal={onOpenTerminal} servers={[]} />);
  expect(screen.getByRole('heading', { name: '服务器总览' })).toBeVisible();
  expect(screen.getByText('暂无已连接服务器')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '打开终端' }));
  expect(onOpenTerminal).toHaveBeenCalledOnce();
});
```

```tsx
it('filters the catalog and opens a non-destructive server detail pane', () => {
  render(<ServerListPage core={{ serverGroups: async () => [] } as unknown as CoreClient} onCreated={vi.fn()} servers={[server]} />);
  fireEvent.click(screen.getByRole('button', { name: `查看 ${server.name} 详情` }));
  expect(screen.getByRole('complementary', { name: `${server.name} 详情` })).toHaveTextContent(server.host);
  fireEvent.change(screen.getByLabelText('环境筛选'), { target: { value: 'development' } });
  expect(screen.getByText('没有匹配的服务器')).toBeVisible();
});
```

- [ ] **Step 2: Run page tests and verify RED**

Run:

```bash
pnpm --filter @opspilot/desktop test -- src/features/dashboard/dashboard-page.test.tsx src/features/servers/server-list-page.test.tsx
```

Expected: FAIL because the quick-action callbacks, filter controls, and detail pane are absent.

- [ ] **Step 3: Implement the dashboard composition**

Use `PageHeader` with only real navigable actions. Render four `MetricCard` components from `servers.length`, `connections.length`, running task count, and Agent availability. Replace the decorative chart line with a labelled empty real-time panel until a connected server is selected; after `loadMetrics`, render memory, load, disks, service count, and port count from Core results. Keep individual `Promise.allSettled` failure labels.

Use a two-column main dashboard and bottom operational grid matching the reference: real-time resources and recent activity on top, health table and alerts/service/port information below. An unavailable section must render its reason, not `0`.

- [ ] **Step 4: Implement the server list/detail structure**

Add `environmentFilter`, `groupFilter`, `authFilter`, and `selectedServerId` state. Derive `filtered` from all filters. Make each row selectable without triggering a connection, and render:

```tsx
<div className={selectedServer ? 'catalog-layout has-detail' : 'catalog-layout'}>
  <section className="ui-panel catalog-table">{serverTable}</section>
  {selectedServer ? <DetailPane title={selectedServer.name} subtitle={`${selectedServer.host}:${selectedServer.port}`} onClose={() => setSelectedServerId(undefined)}>{serverDetailsAndExistingActions}</DetailPane> : null}
</div>
```

Keep existing modal state and functions unchanged. Put connect/edit/delete buttons in both the selected row action area and detail pane, but route both through the existing `connect`, `openEdit`, and `setDeleteTarget` functions.

- [ ] **Step 5: Run feature and application tests**

Run:

```bash
pnpm --filter @opspilot/desktop test -- src/features/dashboard/dashboard-page.test.tsx src/features/servers/server-list-page.test.tsx src/App.test.tsx
pnpm --filter @opspilot/desktop typecheck
pnpm --filter @opspilot/desktop lint
```

Expected: PASS; server mutation and host-key tests must remain unchanged and pass.

- [ ] **Step 6: Review checkpoint**

After approval to commit:

```bash
git add apps/desktop/src/App.tsx apps/desktop/src/features/dashboard apps/desktop/src/features/servers apps/desktop/src/styles.css
git commit -m "feat(ui): 对齐仪表盘与服务器工作区"
```

### Task 4: Align Terminal and AI Agent workspaces

**Files:**

- Modify: `apps/desktop/src/features/terminal/terminal-page.tsx`
- Modify: `apps/desktop/src/features/terminal/terminal-page.test.tsx`
- Modify: `apps/desktop/src/features/terminal/xterm-viewport.tsx`
- Modify: `apps/desktop/src/features/agent/agent-page.tsx`
- Modify: `apps/desktop/src/features/agent/agent-page.test.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**

- Consumes: Task 1 primitives and existing terminal/Agent contract types.
- Preserves: `TerminalPage({ connections, core, pendingSession, onPendingSessionClaimed })` and the complete xterm subscription/write/close lifecycle.
- Preserves: immutable `ApprovalProof` submission through `RiskDecisionDialog`.

- [ ] **Step 1: Write failing layout behavior tests**

Extend the terminal test after the session opens:

```tsx
expect(screen.getByLabelText('终端连接摘要')).toHaveTextContent('web-01');
expect(screen.getByRole('complementary', { name: '终端 AI 助手' })).toBeVisible();
expect(screen.getByRole('link', { name: '前往 AI Agent 工作区' })).toHaveAttribute('href', '#agent');
```

Extend the Agent success test:

```tsx
expect(screen.getByRole('region', { name: 'Agent 对话' })).toBeVisible();
expect(screen.getByRole('region', { name: '执行计划' })).toBeVisible();
expect(screen.getByRole('region', { name: '审批队列' })).toBeVisible();
expect(screen.getByRole('table', { name: 'Agent Trace' })).toBeVisible();
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm --filter @opspilot/desktop test -- src/features/terminal/terminal-page.test.tsx src/features/agent/agent-page.test.tsx
```

Expected: FAIL on the missing labelled regions.

- [ ] **Step 3: Implement the terminal split workspace**

Add a compact connection summary using the selected `ConnectedServer` fields and session state. Place `.terminal-shell` in the primary column and a labelled `<aside>` in the secondary column. The aside must show the selected server scope, explain that generated operations are reviewed in the Agent workspace, and link to `#agent`; it must not display a simulated conversation or approval.

Keep `XtermViewport` mounted only for active sessions. Preserve multiline paste confirmation, stream gap warnings, session tabs, pending Docker Exec claims, terminal resize, and `Object.freeze(Object.prototype)` compatibility.

- [ ] **Step 4: Implement the Agent three-column workspace and real trace**

Convert the current three panels into labelled regions for conversation, execution plan, and approval queue. Render the currently emitted `run` as a one-row `Agent Trace` table with its real id, status, input summary, output summary, and `updatedAt`. When no run exists, render an explicit empty row rather than sample trace data. Keep `RiskDecisionDialog` as the only approval action surface.

- [ ] **Step 5: Run terminal/Agent and freeze regressions**

Run:

```bash
pnpm --filter @opspilot/desktop test -- src/features/terminal/terminal-page.test.tsx src/features/terminal/session-store.test.ts src/features/agent/agent-page.test.tsx
pnpm --filter @opspilot/desktop test -- vite/xterm-freeze-prototype.test.ts
pnpm --filter @opspilot/desktop typecheck
```

Expected: PASS, including multiline paste guarding and immutable approval proof submission.

- [ ] **Step 6: Review checkpoint**

After approval to commit:

```bash
git add apps/desktop/src/features/terminal apps/desktop/src/features/agent apps/desktop/src/styles.css
git commit -m "feat(ui): 重构终端与 Agent 工作区"
```

### Task 5: Align Projects, Docker, and Nginx operational workspaces

**Files:**

- Modify: `apps/desktop/src/features/projects/project-page.tsx`
- Modify: `apps/desktop/src/features/projects/project-page.test.tsx`
- Modify: `apps/desktop/src/features/docker/docker-page.tsx`
- Modify: `apps/desktop/src/features/docker/docker-page.test.tsx`
- Modify: `apps/desktop/src/features/nginx/nginx-page.tsx`
- Modify: `apps/desktop/src/features/nginx/nginx-page.test.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**

- Consumes: `DetailPane`, `MetricCard`, `PageHeader`, `Panel`, `ProgressBar`, and existing contract types.
- Preserves: project detection/create/deploy, Docker load/log/stats/exec/mutations, and Nginx discover/read/diff/apply flows.

- [ ] **Step 1: Write failing selected-detail tests**

For Projects, assert that clicking a real project row opens a labelled detail pane containing its root path and deployment strategy. For Docker, extend the existing test with:

```tsx
fireEvent.click(screen.getByRole('button', { name: '查看 web 详情' }));
expect(screen.getByRole('complementary', { name: 'web 详情' })).toHaveTextContent('nginx:alpine');
```

For Nginx, after reading the real configuration, assert:

```tsx
expect(screen.getByLabelText('Nginx 安全变更流程')).toHaveTextContent('配置校验');
expect(screen.getByRole('complementary', { name: 'Nginx 配置详情' })).toHaveTextContent('/etc/nginx/nginx.conf');
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm --filter @opspilot/desktop test -- src/features/projects/project-page.test.tsx src/features/docker/docker-page.test.tsx src/features/nginx/nginx-page.test.tsx
```

Expected: FAIL because the labelled detail panes and reference workflow structure are absent.

- [ ] **Step 3: Implement Projects layout**

Add `selectedProjectId` derived from the real `projects` array. Place the detection/create controls in a compact expandable creation panel, project table and real deployment state in the main column, and project properties/actions in `DetailPane`. Render a five-step pipeline only after a real deployment has been prepared or submitted; otherwise show “尚未创建部署任务”. Keep all revisions and approval behavior unchanged.

- [ ] **Step 4: Implement Docker layout**

Add `selectedContainerId`, select a container when its detail button, logs, stats, or action is used, and render all existing actions through the same functions. The top metric cards may only show Engine version, running count, stopped count, and transport because the Core does not expose image/volume counts. Put actual `DockerStats` values in the detail pane and logs in a dark panel. Show “指标不可用” until `dockerStats` succeeds.

- [ ] **Step 5: Implement Nginx layout**

Rename the visual five-step chain to snapshot, candidate, configuration validation, reload, and health check while preserving the Core operation name and arguments. Use the left primary area for configuration editing and diff. Show discovered path, selected server, change state, and safety notes in a labelled right detail pane. Do not invent a site list because the current Core exposes only discovered configuration.

- [ ] **Step 6: Run operational feature regressions**

Run:

```bash
pnpm --filter @opspilot/desktop test -- src/features/projects/project-page.test.tsx src/features/docker/docker-page.test.tsx src/features/nginx/nginx-page.test.tsx src/app/risk-decision-dialog.test.tsx
pnpm --filter @opspilot/desktop typecheck
pnpm --filter @opspilot/desktop lint
```

Expected: PASS; exact L3 confirmation and Docker approval assertions remain green.

- [ ] **Step 7: Review checkpoint**

After approval to commit:

```bash
git add apps/desktop/src/features/projects apps/desktop/src/features/docker apps/desktop/src/features/nginx apps/desktop/src/styles.css
git commit -m "feat(ui): 对齐项目与服务管理页面"
```

### Task 6: Unify Files, Tasks, and Settings

**Files:**

- Modify: `apps/desktop/src/features/files/file-manager-page.tsx`
- Modify: `apps/desktop/src/features/files/file-manager-page.test.tsx`
- Modify: `apps/desktop/src/features/tasks/task-center.tsx`
- Modify: `apps/desktop/src/features/tasks/task-center.test.tsx`
- Modify: `apps/desktop/src/features/settings/model-settings.tsx`
- Modify: `apps/desktop/src/features/settings/model-settings.test.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**

- Consumes: Task 1 primitives and existing page props.
- Preserves: SFTP file operations, task loading/status, model profile CRUD, API-key handling, and all current error messages.

- [ ] **Step 1: Add failing structural assertions**

Add one meaningful design-system assertion to each existing behavior test:

```tsx
expect(screen.getByRole('heading', { name: '文件管理' })).toBeVisible();
expect(screen.getByRole('region', { name: '远端文件列表' })).toBeVisible();
```

```tsx
expect(screen.getByRole('table', { name: '任务与日志' })).toBeVisible();
```

```tsx
expect(screen.getByRole('region', { name: '模型配置' })).toBeVisible();
expect(screen.getByRole('region', { name: '已保存模型' })).toBeVisible();
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm --filter @opspilot/desktop test -- src/features/files/file-manager-page.test.tsx src/features/tasks/task-center.test.tsx src/features/settings/model-settings.test.tsx
```

Expected: FAIL on the missing labelled regions while existing Core behavior assertions still run.

- [ ] **Step 3: Replace page-specific wrappers with shared primitives**

Use `PageHeader`, `Panel`, `SectionHeader`, `EmptyState`, and existing form/table elements. Keep the file browser as list plus preview, Task Center as table plus status feedback, and Settings as configuration form plus saved-profile list. Do not add tabs or controls without Core-backed behavior.

Add desktop responsive rules at 1180px: collapse the side navigation, stack three-column Agent regions, move detail panes below tables only when their main table would become narrower than 640px, and preserve a minimum 600px terminal column. Do not create mobile navigation.

- [ ] **Step 4: Run secondary-page regressions**

Run:

```bash
pnpm --filter @opspilot/desktop test -- src/features/files/file-manager-page.test.tsx src/features/tasks/task-center.test.tsx src/features/settings/model-settings.test.tsx
pnpm --filter @opspilot/desktop typecheck
pnpm --filter @opspilot/desktop lint
```

Expected: PASS with no accessibility-query failures or lint warnings.

- [ ] **Step 5: Review checkpoint**

After approval to commit:

```bash
git add apps/desktop/src/features/files apps/desktop/src/features/tasks apps/desktop/src/features/settings apps/desktop/src/styles.css
git commit -m "feat(ui): 统一辅助工作区视觉语言"
```

### Task 7: Complete renderer, native, and visual verification

**Files:**

- Modify: `tests/e2e/renderer/app-shell.spec.ts`
- Modify: `tests/e2e/native/app-shell.e2e.ts`
- Modify: `apps/desktop/src/styles.css` only for defects proven during validation.

**Interfaces:**

- Consumes: the finished route names, headings, accessible labels, and existing renderer/native fixtures.
- Produces: regression coverage for the approved shell, all seven core pages, and the xterm frozen-prototype boot path.

- [ ] **Step 1: Write failing renderer navigation coverage**

Add a route table and verify each page through visible navigation:

```ts
const routes = [
  ['服务器', '服务器管理'],
  ['终端', '远程终端'],
  ['AI Agent', 'AI Agent'],
  ['项目', '项目与发布'],
  ['Docker', 'Docker'],
  ['Nginx', 'Nginx'],
] as const;

for (const [navigation, heading] of routes) {
  await page.getByRole('button', { name: navigation }).click();
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
}
```

Also assert the light shell marker and persistent production/Core status using accessible text rather than CSS colors.

- [ ] **Step 2: Run renderer E2E and verify RED or expose integration defects**

Run:

```bash
pnpm test:e2e:renderer
```

Expected before final fixes: at least one new navigation or structure assertion fails.

- [ ] **Step 3: Update native coverage without weakening keyring requirements**

Keep the explicit `secretStoreReady` precondition. After the existing terminal navigation, assert that the terminal AI aside is present and that no blank body is rendered. Do not change the native fixture to bypass Tauri ACL or the operating-system credential store.

- [ ] **Step 4: Run the complete automated verification ladder**

Run in this order:

```bash
pnpm --filter @opspilot/desktop test
pnpm test:e2e:renderer
pnpm lint
pnpm typecheck
pnpm build:desktop
pnpm test
pnpm build:e2e:native
pnpm test:e2e:native
git diff --check
```

Expected: every command PASS. If native E2E reports an unavailable credential store, configure the host keyring and rerun; do not weaken the assertion.

- [ ] **Step 5: Perform desktop visual inspection at the reference size**

Run the desktop app at 1448×1086 and inspect Dashboard, Servers, Terminal, Agent, Projects, Docker, and Nginx. Confirm:

- the shell is light and compact with no horizontal page overflow;
- selected list rows align with their detail panes;
- terminal input, xterm canvas, and AI aside remain visible;
- empty states explain missing connections/data without sample records;
- production and dangerous actions remain textually identifiable;
- no white screen, clipped dialog, unreadable contrast, or frozen navigation appears.

Capture a screenshot of the final Dashboard and Terminal for the handoff report.

- [ ] **Step 6: Final review checkpoint**

Summarize modified files, verification output, known Core-data limitations, and visual evidence. Only after the user explicitly approves a commit, stage exactly the reviewed UI and existing white-screen fix files and invoke the separate `git-commit` workflow.
