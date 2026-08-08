import { useEffect, useState } from 'react';
import type {
  LinuxMetrics,
  ListeningPort,
  OsRelease,
  ServerSummary,
  SystemService,
} from '@opspilot/contracts';

import type { AgentAvailability, CoreClient } from '../../api/core';
import type { ConnectedServer } from '../terminal/terminal-page';

export function DashboardPage({ agent, connections, core, onAddServer, servers }: {
  agent?: AgentAvailability;
  connections: ConnectedServer[];
  core: CoreClient;
  onAddServer?: () => void;
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
  useEffect(() => { if (!selectedServerId && connections[0]) setSelectedServerId(connections[0].server.id); }, [connections, selectedServerId]);
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
    ? Math.round((metrics.memory.usedBytes / metrics.memory.totalBytes) * 100) : undefined;
  return (
    <div className="page-stack">
      <div className="page-heading"><div><p className="eyebrow">OPERATIONS OVERVIEW</p><h1>服务器总览</h1><p>基础设施状态、连接入口与最近活动集中在一个工作区。</p></div><button className="primary" onClick={onAddServer} type="button">＋ 添加服务器</button></div>
      <section className="metrics-grid" aria-label="关键指标">
        <article className="metric-card"><span>服务器</span><strong>{servers.length}</strong><small>{production} 台生产环境</small></article>
        <article className="metric-card"><span>可信连接</span><strong>{connections.length}</strong><small>由 Core 实时验证</small></article>
        <article className="metric-card"><span>运行中任务</span><strong>{runningTasks}</strong><small>持久化任务状态</small></article>
        <article className={agent?.agentAvailable ? 'metric-card' : 'metric-card warning'}><span>Agent</span><strong>{agent?.agentAvailable ? '就绪' : '降级'}</strong><small>人工功能保持可用</small></article>
      </section>
      <div className="dashboard-grid">
        <section className="panel wide"><div className="panel-title"><h2>实时资源</h2><span className="muted">不保存长期监控数据</span></div><div className="metric-controls"><select aria-label="指标服务器" onChange={(event) => setSelectedServerId(event.target.value)} value={selectedServerId}><option value="">选择已连接服务器</option>{connections.map(({ server }) => <option key={server.id} value={server.id}>{server.name}</option>)}</select><button onClick={() => void loadMetrics()} type="button">刷新指标</button></div>{metricError ? <div className="alert warning-alert" role="alert">{metricError}</div> : null}{metrics || os || ports || services ? <div className="live-metrics"><div><span>系统</span><strong>{os?.prettyName ?? '不可用'}</strong></div><div><span>内存</span><strong>{memoryPercent === undefined ? '不可用' : `${memoryPercent}%`}</strong></div><div><span>Load 1m</span><strong>{metrics?.load?.one ?? '不可用'}</strong></div><div><span>磁盘</span><strong>{metrics ? metrics.disks.length : '不可用'}</strong></div><div><span>服务</span><strong>{services ? services.length : '不可用'}</strong></div><div><span>监听端口</span><strong>{ports ? ports.length : '不可用'}</strong></div>{metrics?.unavailable.map((reason) => <p key={reason}>字段不可用：{reason}</p>)}</div> : <div className="chart-placeholder"><div className="chart-line" /><span>选择服务器后加载资源、服务与端口</span></div>}</section>
        <section className="panel"><div className="panel-title"><h2>最近活动</h2></div><ul className="activity-list"><li><span className="activity-icon">✓</span><div><strong>Core 安全边界已就绪</strong><small>刚刚</small></div></li><li><span className="activity-icon">↻</span><div><strong>等待服务器连接</strong><small>SSH / SFTP / 运维</small></div></li></ul></section>
      </div>
      {services || ports ? <div className="dashboard-grid"><section className="panel"><div className="panel-title"><h2>服务状态</h2><span className="count-badge">{services?.length ?? 0}</span></div><ul className="activity-list">{services?.slice(0, 8).map((service) => <li key={service.unit}><div><strong>{service.unit}</strong><small>{service.activeState} / {service.subState}</small></div></li>)}</ul></section><section className="panel"><div className="panel-title"><h2>监听端口</h2><span className="count-badge">{ports?.length ?? 0}</span></div><ul className="activity-list">{ports?.slice(0, 8).map((port) => <li key={`${port.protocol}:${port.address}:${port.port}`}><div><strong>{port.protocol.toUpperCase()} {port.address}:{port.port}</strong><small>{port.process ?? '进程不可用'}</small></div></li>)}</ul></section></div> : null}
      <section className="panel"><div className="panel-title"><h2>服务器健康状态</h2><span className="count-badge">{servers.length}</span></div><ServerTable servers={servers.slice(0, 6)} /></section>
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
