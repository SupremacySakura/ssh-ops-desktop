import { useState, type ReactNode } from 'react';

import { Icon, type IconName } from './icons';
import { useTheme } from './theme';

export type WorkspaceRoute =
  | 'dashboard' | 'servers' | 'terminal' | 'agent' | 'projects'
  | 'files' | 'docker' | 'nginx' | 'tasks' | 'settings';

const NAVIGATION: Array<{ route: WorkspaceRoute; icon: IconName; label: string; badge?: number }> = [
  { route: 'dashboard', icon: 'dashboard', label: '仪表盘' },
  { route: 'servers', icon: 'server', label: '服务器' },
  { route: 'terminal', icon: 'terminal', label: '终端' },
  { route: 'agent', icon: 'agent', label: 'AI Agent' },
  { route: 'projects', icon: 'project', label: '项目' },
  { route: 'files', icon: 'file', label: '文件' },
  { route: 'docker', icon: 'docker', label: 'Docker' },
  { route: 'nginx', icon: 'nginx', label: 'Nginx' },
  { route: 'tasks', icon: 'history', label: '任务与日志' },
  { route: 'settings', icon: 'settings', label: '设置' },
];

const SIDEBAR_KEY = 'opspilot.sidebar';

function readSidebarCollapsed(): boolean {
  try { return localStorage.getItem(SIDEBAR_KEY) === 'collapsed'; } catch { return false; }
}

interface AppShellProps {
  children: ReactNode;
  coreReady: boolean;
  coreVersion: string;
  onNavigate(route: WorkspaceRoute): void;
  route: WorkspaceRoute;
}

export function AppShell({
  children,
  coreReady,
  coreVersion,
  onNavigate,
  route,
}: AppShellProps) {
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const { theme, toggle } = useTheme();
  const page = NAVIGATION.find((item) => item.route === route);

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      const next = !value;
      try { localStorage.setItem(SIDEBAR_KEY, next ? 'collapsed' : 'expanded'); } catch { /* ignore */ }
      return next;
    });
  };

  const navItem = (item: typeof NAVIGATION[number]) => (
    <button
      aria-current={route === item.route ? 'page' : undefined}
      aria-label={item.label}
      className={route === item.route ? 'nav-item active' : 'nav-item'}
      key={item.route}
      onClick={() => onNavigate(item.route)}
      title={collapsed ? item.label : undefined}
      type="button"
    >
      <Icon name={item.icon} />
      <span>{item.label}</span>
      {item.badge ? <span className="nav-badge">{item.badge}</span> : null}
    </button>
  );

  return (
    <div className={collapsed ? 'app-shell sidebar-collapsed' : 'app-shell'}>
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="brand-mark">O</div>
          <div className="brand-name">OpsPilot</div>
          <button
            aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
            className="sidebar-collapse-btn"
            onClick={toggleCollapsed}
            title={collapsed ? '展开侧边栏' : '收起侧边栏'}
            type="button"
          >
            <Icon className={collapsed ? 'is-reversed' : undefined} name="collapse" />
          </button>
        </div>
        <nav aria-label="主导航" className="sidebar-nav">
          <div className="nav-section">工作区</div>
          {NAVIGATION.slice(0, 9).map(navItem)}
          <div className="nav-section">系统</div>
          {NAVIGATION.slice(9).map(navItem)}
        </nav>
        <div className="sidebar-footer">
          <div className="status-pill">
            <span className="status-dot" />
            <span>{coreReady ? 'Core 运行正常' : 'Core 未就绪'} · {coreVersion}</span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <span>工作区</span>
            <Icon name="chevron-right" size={14} />
            <span style={{ color: 'var(--label-primary)', fontWeight: 600 }}>{page?.label ?? '仪表盘'}</span>
          </div>
          <div className="topbar-actions">
            <div className="search-box">
              <Icon name="search" size={16} />
              <input className="input" placeholder="搜索服务器、任务、文件..." type="text" />
            </div>
            <button aria-label="通知" className="btn btn-icon" title="通知" type="button"><Icon name="bell" size={16} /></button>
            <button aria-label="帮助" className="btn btn-icon" title="帮助" type="button"><Icon name="help" size={16} /></button>
            <button
              aria-label={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
              aria-pressed={theme === 'dark'}
              className="btn btn-icon theme-toggle"
              onClick={toggle}
              title={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
              type="button"
            >
              <Icon className="icon-sun" name="sun" size={16} />
              <Icon className="icon-moon" name="moon" size={16} />
            </button>
          </div>
        </header>
        <section className="content">
          <div className="content-grid">{children}</div>
        </section>
      </main>
    </div>
  );
}
