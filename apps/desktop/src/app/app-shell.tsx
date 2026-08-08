import type { ReactNode } from 'react';

export type WorkspaceRoute =
  | 'dashboard' | 'servers' | 'terminal' | 'agent' | 'projects'
  | 'files' | 'docker' | 'nginx' | 'tasks' | 'settings';

const NAVIGATION: Array<{ route: WorkspaceRoute; icon: string; label: string }> = [
  { route: 'dashboard', icon: '◫', label: '仪表盘' },
  { route: 'servers', icon: '▤', label: '服务器' },
  { route: 'terminal', icon: '⌘', label: '终端' },
  { route: 'files', icon: '▥', label: '文件' },
  { route: 'agent', icon: '✦', label: 'AI Agent' },
  { route: 'projects', icon: '◇', label: '项目' },
  { route: 'docker', icon: '▱', label: 'Docker' },
  { route: 'nginx', icon: '⬡', label: 'Nginx' },
  { route: 'tasks', icon: '≡', label: '任务与日志' },
  { route: 'settings', icon: '⚙', label: '设置' },
];

interface AppShellProps {
  route: WorkspaceRoute;
  environment: string;
  onEnvironmentChange(value: string): void;
  onNavigate(route: WorkspaceRoute): void;
  children: ReactNode;
}

export function AppShell({ route, environment, onEnvironmentChange, onNavigate, children }: AppShellProps) {
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand"><span className="brand-mark">O</span><span>OpsPilot</span></div>
        <nav>
          {NAVIGATION.map((item) => (
            <button
              aria-current={route === item.route ? 'page' : undefined}
              className={route === item.route ? 'nav-item active' : 'nav-item'}
              key={item.route}
              onClick={() => onNavigate(item.route)}
              title={item.label}
              type="button"
            >
              <span aria-hidden="true">{item.icon}</span><span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot"><span className="status-dot" />Core 本地运行</div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <label className="environment-select">
            <span>环境</span>
            <select value={environment} onChange={(event) => onEnvironmentChange(event.target.value)}>
              <option value="all">全部环境</option>
              <option value="production">生产环境</option>
              <option value="staging">预发布</option>
              <option value="development">开发环境</option>
            </select>
          </label>
          {environment === 'production' ? <span className="production-chip">● 生产环境</span> : null}
          <button className="command-button" type="button" aria-label="打开全局搜索">⌘ K　搜索服务器、项目或命令</button>
          <div className="topbar-actions"><button type="button" aria-label="通知">◔</button><span className="avatar">OP</span></div>
        </header>
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}
