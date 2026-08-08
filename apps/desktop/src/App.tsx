import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { ModelProfileSummary, ServerSummary } from '@opspilot/contracts';

import type { AgentAvailability, CoreClient, CoreHealth } from './api/core';
import { AppShell, type WorkspaceRoute } from './app/app-shell';
import { DashboardPage } from './features/dashboard/dashboard-page';
import { AgentPage } from './features/agent/agent-page';
import { ServerListPage } from './features/servers/server-list-page';
import { SettingsPage } from './features/settings/model-settings';
import type { ConnectedServer, PendingTerminalSession } from './features/terminal/terminal-page';
import { FileManagerPage } from './features/files/file-manager-page';
import { DockerPage } from './features/docker/docker-page';
import { NginxPage } from './features/nginx/nginx-page';
import { ProjectsPage } from './features/projects/project-page';
import { TasksPage } from './features/tasks/task-center';

const TerminalPage = lazy(async () => {
  const terminal = await import('./features/terminal/terminal-page');
  return { default: terminal.TerminalPage };
});

interface AppProps { core: CoreClient }
type HealthState = { status: 'loading' } | { status: 'loaded'; health: CoreHealth } | { status: 'error' };

function initialRoute(): WorkspaceRoute {
  const route = window.location.hash.replace(/^#\/?/u, '') as WorkspaceRoute;
  return ['dashboard', 'servers', 'terminal', 'files', 'agent', 'projects', 'docker', 'nginx', 'tasks', 'settings'].includes(route)
    ? route : 'dashboard';
}

export default function App({ core }: AppProps) {
  const [healthState, setHealthState] = useState<HealthState>({ status: 'loading' });
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [agent, setAgent] = useState<AgentAvailability>();
  const [profiles, setProfiles] = useState<ModelProfileSummary[]>([]);
  const [connections, setConnections] = useState<ConnectedServer[]>([]);
  const [pendingTerminal, setPendingTerminal] = useState<PendingTerminalSession>();
  const [route, setRoute] = useState<WorkspaceRoute>(initialRoute);
  const [environment, setEnvironment] = useState('all');

  useEffect(() => {
    let active = true;
    setHealthState({ status: 'loading' });
    async function load() {
      try {
        const health = await core.health();
        if (!active) return;
        setHealthState({ status: 'loaded', health });
        const [loadedServers, availability, loadedProfiles] = await Promise.all([
          core.servers?.().catch(() => []) ?? Promise.resolve([]),
          core.agentStatus?.().catch(() => ({ agentAvailable: false, reason: 'Agent 状态不可用' }))
            ?? Promise.resolve({ agentAvailable: false, reason: 'Agent Sidecar 未配置' }),
          core.modelProfiles?.().catch(() => []) ?? Promise.resolve([]),
        ]);
        if (active) { setServers(loadedServers); setAgent(availability); setProfiles(loadedProfiles); }
      } catch {
        if (active) setHealthState({ status: 'error' });
      }
    }
    void load();
    return () => { active = false; };
  }, [core]);

  const visibleServers = useMemo(() => environment === 'all'
    ? servers : servers.filter((server) => server.environment === environment), [environment, servers]);

  if (healthState.status === 'loading') return <main className="boot-state"><span className="brand-mark">O</span><p>正在检查 Core</p></main>;
  if (healthState.status === 'error') return <main className="boot-state error"><span className="brand-mark">!</span><p role="alert">无法读取 Core 状态</p><small>请重新启动 OpsPilot；不会尝试执行任何远端操作。</small></main>;

  const ready = healthState.health.databaseReady && healthState.health.secretStoreReady;
  const navigate = (next: WorkspaceRoute) => { window.location.hash = next; setRoute(next); };
  return <AppShell
    coreReady={ready}
    coreVersion={healthState.health.version}
    environment={environment}
    onEnvironmentChange={setEnvironment}
    onNavigate={navigate}
    route={route}
  >
    {!ready ? <div className="alert warning-alert" role="alert"><strong>Core 未就绪</strong><span>数据库或系统凭据库不可用，写操作已禁用。</span></div> : null}
    {route === 'dashboard' ? <DashboardPage
      agent={agent}
      connections={connections}
      core={core}
      onAddServer={() => navigate('servers')}
      onOpenAgent={() => navigate('agent')}
      onOpenTerminal={() => navigate('terminal')}
      servers={visibleServers}
    /> : null}
    {route === 'servers' ? <ServerListPage
      core={core}
      onConnected={(server, connection) => setConnections((current) => [
        { server, connection }, ...current.filter((item) => item.server.id !== server.id),
      ])}
      onCreated={(server) => setServers((current) => [server, ...current])}
      onDeleted={(serverId) => {
        setServers((current) => current.filter((server) => server.id !== serverId));
        setConnections((current) => current.filter((item) => item.server.id !== serverId));
      }}
      onUpdated={(server) => {
        setServers((current) => current.map((item) => item.id === server.id ? server : item));
        setConnections((current) => current.map((item) => item.server.id === server.id
          ? { ...item, server }
          : item));
      }}
      servers={visibleServers}
    /> : null}
    {route === 'terminal' ? <Suspense fallback={<div className="panel">正在加载终端…</div>}><TerminalPage connections={connections} core={core} onPendingSessionClaimed={() => setPendingTerminal(undefined)} pendingSession={pendingTerminal} /></Suspense> : null}
    {route === 'files' ? <FileManagerPage connections={connections} core={core} /> : null}
    {route === 'agent' ? <AgentPage availability={agent} connections={connections} core={core} profiles={profiles} servers={visibleServers} /> : null}
    {route === 'projects' ? <ProjectsPage connections={connections} core={core} /> : null}
    {route === 'docker' ? <DockerPage connections={connections} core={core} onExec={(session, server) => { setPendingTerminal({ session, server }); navigate('terminal'); }} /> : null}
    {route === 'nginx' ? <NginxPage connections={connections} core={core} /> : null}
    {route === 'tasks' ? <TasksPage core={core} /> : null}
    {route === 'settings' ? <SettingsPage core={core} /> : null}
  </AppShell>;
}
