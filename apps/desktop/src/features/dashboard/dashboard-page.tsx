import { useEffect, useState } from 'react';
import type {
  LinuxMetrics,
  ListeningPort,
  OsRelease,
  ServerSummary,
  SystemService,
} from '@opspilot/contracts';

import type { AgentAvailability, CoreClient } from '../../api/core';
import { EmptyState, MetricCard, PageHeader, Panel, SectionHeader } from '../../app/ui/layout';
import type { ConnectedServer } from '../terminal/terminal-page';

export function DashboardPage({
  agent,
  connections,
  core,
  onAddServer,
  onOpenAgent,
  onOpenTerminal,
  servers,
}: {
  agent?: AgentAvailability;
  connections: ConnectedServer[];
  core: CoreClient;
  onAddServer?: () => void;
  onOpenAgent?: () => void;
  onOpenTerminal?: () => void;
  servers: ServerSummary[];
}) {
  const production = servers.filter((server) => server.environment === 'production').length;
  const [selectedServerId, setSelectedServerId] = useState(connections[0]?.server.id ?? '');
  const [metrics, setMetrics] = useState<LinuxMetrics>();
  const [os, setOs] = useState<OsRelease>();
  const [ports, setPorts] = useState<ListeningPort[]>();
  const [services, setServices] = useState<SystemService[]>();
  const [metricError, setMetricError] = useState('');
  const [runningTasks, setRunningTasks] = useState(0);

  useEffect(() => {
    if (!selectedServerId && connections[0]) setSelectedServerId(connections[0].server.id);
  }, [connections, selectedServerId]);

  useEffect(() => {
    let active = true;
    void (core.tasks?.(200) ?? Promise.resolve([])).then((tasks) => {
      if (active) setRunningTasks(tasks.filter((task) => ['pending', 'running', 'rolling_back'].includes(task.status)).length);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [core]);

  const loadMetrics = async () => {
    const connected = connections.find((item) => item.server.id === selectedServerId);
    if (!connected || !core.systemMetrics || !core.systemProbe || !core.systemPorts || !core.systemServices) {
      setMetricError('请先建立可信 SSH 连接');
      return;
    }
    const results = await Promise.allSettled([
      core.systemMetrics(connected.connection),
      core.systemProbe(connected.connection),
      core.systemPorts(connected.connection),
      core.systemServices(connected.connection),
    ] as const);
    const unavailable: string[] = [];
    if (results[0].status === 'fulfilled') setMetrics(results[0].value);
    else { setMetrics(undefined); unavailable.push('资源指标'); }
    if (results[1].status === 'fulfilled') setOs(results[1].value);
    else { setOs(undefined); unavailable.push('系统信息'); }
    if (results[2].status === 'fulfilled') setPorts(results[2].value);
    else { setPorts(undefined); unavailable.push('监听端口'); }
    if (results[3].status === 'fulfilled') setServices(results[3].value);
    else { setServices(undefined); unavailable.push('服务状态'); }
    setMetricError(unavailable.length > 0
      ? `${unavailable.join('、')}暂不可用；不会用 0 冒充真实数据`
      : '');
  };

  const memoryPercent = metrics?.memory && metrics.memory.totalBytes > 0
    ? Math.round((metrics.memory.usedBytes / metrics.memory.totalBytes) * 100)
    : undefined;
  const selectedConnection = connections.find((item) => item.server.id === selectedServerId);

  return (
    <div className="page-stack dashboard-page">
      <PageHeader
        actions={<>
          <button onClick={onAddServer} type="button">＋ 添加服务器</button>
          <button onClick={onOpenTerminal} type="button">打开终端</button>
          <button className="primary" onClick={onOpenAgent} type="button">AI 巡检</button>
        </>}
        description="基础设施状态、连接入口与实时探测集中在一个工作区。"
        eyebrow="Operations overview"
        title="服务器总览"
      />
      <section aria-label="关键指标" className="metrics-grid">
        <MetricCard detail={`${production} 台生产环境`} icon="server" label="服务器" tone="primary" value={servers.length} />
        <MetricCard detail="由 Core 实时验证" icon="terminal" label="可信连接" tone="success" value={connections.length} />
        <MetricCard detail="持久化任务状态" icon="history" label="运行中任务" tone={runningTasks > 0 ? 'warning' : 'primary'} value={runningTasks} />
        <MetricCard detail={agent?.agentAvailable ? '本地 Sidecar 可用' : agent?.reason ?? '人工功能保持可用'} icon="agent" label="AI Agent" tone={agent?.agentAvailable ? 'ai' : 'warning'} value={agent?.agentAvailable ? '就绪' : '降级'} />
      </section>
      <div className="dashboard-grid">
        <Panel className="dashboard-resource-panel">
          <SectionHeader description="按需读取，不保存长期监控数据" title="实时资源" />
          <div className="metric-controls">
            <select aria-label="指标服务器" onChange={(event) => setSelectedServerId(event.target.value)} value={selectedServerId}>
              <option value="">选择已连接服务器</option>
              {connections.map(({ server }) => <option key={server.id} value={server.id}>{server.name}</option>)}
            </select>
            <button disabled={!selectedConnection} onClick={() => void loadMetrics()} type="button">刷新指标</button>
          </div>
          {metricError ? <div className="alert warning-alert" role="alert">{metricError}</div> : null}
          {metrics || os || ports || services ? (
            <div className="live-metrics">
              <div><span>系统</span><strong>{os?.prettyName ?? '不可用'}</strong></div>
              <div><span>内存</span><strong>{memoryPercent === undefined ? '不可用' : `${memoryPercent}%`}</strong></div>
              <div><span>Load 1m</span><strong>{metrics?.load?.one ?? '不可用'}</strong></div>
              <div><span>磁盘</span><strong>{metrics ? metrics.disks.length : '不可用'}</strong></div>
              <div><span>服务</span><strong>{services ? services.length : '不可用'}</strong></div>
              <div><span>监听端口</span><strong>{ports ? ports.length : '不可用'}</strong></div>
              {metrics?.unavailable.map((reason) => <p key={reason}>字段不可用：{reason}</p>)}
            </div>
          ) : connections.length === 0 ? (
            <EmptyState action={<button onClick={onAddServer} type="button">添加服务器</button>} description="建立可信 SSH 连接后，可在这里按需读取系统、资源、服务和端口信息。" icon="server" title="暂无已连接服务器" />
          ) : (
            <EmptyState action={<button onClick={() => void loadMetrics()} type="button">读取实时指标</button>} description={`从 ${selectedConnection?.server.name ?? '所选服务器'} 读取当前状态，不会生成虚假趋势。`} icon="activity" title="尚未加载资源指标" />
          )}
        </Panel>
        <Panel>
          <SectionHeader title="最近活动" />
          <EmptyState description="当前 Core 尚未提供活动流接口；任务执行记录可在“任务与日志”中查看。" icon="history" title="暂无可展示的活动记录" />
        </Panel>
      </div>
      <div className="dashboard-bottom-grid">
        <Panel>
          <SectionHeader count={servers.length} title="服务器健康状态" />
          <ServerTable servers={servers.slice(0, 6)} />
        </Panel>
        <Panel>
          <SectionHeader count={(services?.length ?? 0) + (ports?.length ?? 0)} title="服务与端口" />
          {services || ports ? <div className="probe-list">
            {services?.slice(0, 4).map((service) => <div key={service.unit}><span className="status-dot" /><strong>{service.unit}</strong><small>{service.activeState} / {service.subState}</small></div>)}
            {ports?.slice(0, 4).map((port) => <div key={`${port.protocol}:${port.address}:${port.port}`}><span className="status-dot" /><strong>{port.protocol.toUpperCase()} {port.address}:{port.port}</strong><small>{port.process ?? '进程不可用'}</small></div>)}
          </div> : <EmptyState description="选择已连接服务器并刷新指标后显示。" icon="activity" title="尚未探测服务与端口" />}
        </Panel>
      </div>
    </div>
  );
}

export function ServerTable({ servers }: { servers: ServerSummary[] }) {
  return (
    <div className="table-wrap"><table aria-label="服务器健康状态"><thead><tr><th>服务器</th><th>地址</th><th>环境</th><th>认证</th><th>最近连接</th><th>状态</th></tr></thead><tbody>
      {servers.length === 0 ? <tr><td colSpan={6} className="empty-cell">尚未添加服务器。先建立一台服务器以开始运维。</td></tr> : servers.map((server) => <tr key={server.id}><td><strong>{server.name}</strong><small>{server.username}</small></td><td>{server.host}:{server.port}</td><td><span className={`environment-badge ${server.environment}`}>{environmentLabel(server.environment)}</span></td><td>{server.authType.replaceAll('_', ' ')}</td><td>{server.lastConnectedAt ?? '尚未连接'}</td><td><span className="status-badge"><i />待检查</span></td></tr>)}
    </tbody></table></div>
  );
}

export function environmentLabel(environment: ServerSummary['environment']) {
  return ({ production: '生产', staging: '预发布', development: '开发', other: '其他' })[environment];
}
