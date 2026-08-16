import { useState, type ReactNode } from 'react';

import { Icon, type IconName } from './icons';
import { Select } from './ui/select';

export type WorkspaceRoute =
  | 'dashboard' | 'servers' | 'terminal' | 'agent' | 'projects'
  | 'files' | 'docker' | 'nginx' | 'tasks' | 'settings';

const NAVIGATION: Array<{ route: WorkspaceRoute; icon: IconName; label: string }> = [
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

interface AppShellProps {
  children: ReactNode;
  coreReady: boolean;
  coreVersion: string;
  environment: string;
  onEnvironmentChange(value: string): void;
  onNavigate(route: WorkspaceRoute): void;
  route: WorkspaceRoute;
}

export function AppShell({
  children,
  coreReady,
  coreVersion,
  environment,
  onEnvironmentChange,
  onNavigate,
  route,
}: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={collapsed ? 'app-shell sidebar-collapsed' : 'app-shell'}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><Icon name="activity" size={19} /></span>
          <span className="brand-name">OpsPilot</span>
        </div>
        <nav aria-label="主导航">
          {NAVIGATION.map((item) => (
            <button
              aria-current={route === item.route ? 'page' : undefined}
              aria-label={item.label}
              className={route === item.route ? 'nav-item active' : 'nav-item'}
              key={item.route}
              onClick={() => onNavigate(item.route)}
              title={item.label}
              type="button"
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <div className="license-card">
          <span className="license-icon"><Icon name="help" size={16} /></span>
          <div><strong>本地优先</strong><small>数据留在你的设备</small></div>
        </div>
        <button
          aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
          className="collapse-button"
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? '展开侧栏' : '收起侧栏'}
          type="button"
        >
          <Icon className={collapsed ? 'is-reversed' : undefined} name="collapse" />
          <span>收起侧栏</span>
        </button>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button aria-label="搜索服务器、项目或命令" className="command-button" type="button">
            <Icon name="search" size={16} />
            <span>搜索服务器、项目或命令</span>
            <kbd>⌘ K</kbd>
          </button>
          <div className="topbar-context">
            <div aria-label="当前环境" className="environment-control">
              <span className={environment === 'production' ? 'environment-dot production' : 'environment-dot'} />
              <Select aria-label="环境" onChange={(value) => onEnvironmentChange(value)} options={[
                { value: 'all', label: '全部环境' },
                { value: 'production', label: '生产环境' },
                { value: 'staging', label: '预发布' },
                { value: 'development', label: '开发环境' },
              ]} value={environment} />
            </div>
            {environment === 'production' ? <span className="production-chip"><Icon name="alert" size={13} />生产环境</span> : null}
            <div aria-label="Core 状态" className={coreReady ? 'core-status ready' : 'core-status'} role="status">
              <span className="status-dot" />
              <span>{coreReady ? 'Core 已就绪' : 'Core 未就绪'}</span>
              <small>Core {coreVersion}</small>
            </div>
            <button aria-label="通知" className="topbar-icon-button" type="button"><Icon name="bell" /></button>
            <div className="user-menu" aria-label="当前用户">
              <span className="avatar">OP</span>
              <div><strong>本地用户</strong><small>设备管理员</small></div>
              <Icon name="chevron-down" size={14} />
            </div>
          </div>
        </header>
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}
