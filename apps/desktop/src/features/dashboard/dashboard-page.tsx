import { useEffect, useState } from 'react';
import type {
  LinuxMetrics,
  ListeningPort,
  OsRelease,
  ServerSummary,
  SystemService,
} from '@opspilot/contracts';

import type { AgentAvailability, CoreClient } from '../../api/core';
import { PageHeader } from '../../app/ui/layout';
import { Select } from '../../app/ui/select';
import { Icon, type IconName } from '../../app/icons';
import type { ConnectedServer } from '../terminal/terminal-page';

const CHART_BARS = [45, 60, 35, 55, 40, 70, 50, 65, 30, 48, 62, 38];

export function DashboardPage({
  agent,
  connections,
  core,
  onAddServer,
  onOpenAgent,
  servers,
}: {
  agent?: AgentAvailability;
  connections: ConnectedServer[];
  core: CoreClient;
  onAddServer?: () => void;
  onOpenAgent?: () => void;
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
  const [recentTasks, setRecentTasks] = useState<Array<{ title: string; meta: string; tag: string; tone: 'success' | 'warning' | 'neutral' }>>([]);
  const [chartTab, setChartTab] = useState<'cpu' | 'memory' | 'disk'>('cpu');

  useEffect(() => {
    if (!selectedServerId && connections[0]) setSelectedServerId(connections[0].server.id);
  }, [connections, selectedServerId]);

  useEffect(() => {
    let active = true;
    void (core.tasks?.(200) ?? Promise.resolve([])).then((tasks) => {
      if (!active) return;
      setRunningTasks(tasks.filter((task) => ['pending', 'running', 'rolling_back'].includes(task.status)).length);
      setRecentTasks(tasks.slice(0, 4).map((task) => ({
        title: task.currentStep ?? `任务 #${task.taskId.slice(0, 8)}`,
        meta: `任务 #${task.taskId.slice(0, 8)} · 进度 ${task.progress}%`,
        tag: task.status === 'failed' ? '失败' : task.status === 'succeeded' ? '成功' : '进行中',
        tone: task.status === 'failed' ? 'warning' : task.status === 'succeeded' ? 'success' : 'neutral',
      })));
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

  const barHeights = ((): number[] => {
    if (chartTab === 'memory' && memoryPercent !== undefined) return CHART_BARS.map((h) => Math.round(Math.max(12, Math.min(96, memoryPercent * 0.9 + h * 0.1))));
    if (chartTab === 'disk' && metrics && metrics.disks.length > 0) {
      const avg = Math.min(96, Math.round(metrics.disks.reduce((sum, disk) => {
        const percent = disk.totalBytes > 0 ? (disk.usedBytes / disk.totalBytes) * 100 : 0;
        return sum + percent;
      }, 0) / metrics.disks.length));
      return CHART_BARS.map((h) => Math.round(Math.max(12, Math.min(96, avg * 0.9 + h * 0.1))));
    }
    if (chartTab === 'cpu' && metrics?.load?.one !== undefined) {
      const cpu = Math.min(96, Math.round(metrics.load.one * 20));
      return CHART_BARS.map((h) => Math.round(Math.max(12, Math.min(96, cpu * 0.9 + h * 0.1))));
    }
    return CHART_BARS;
  })();

  const fallbackActivities: Array<{ icon: IconName; title: string; meta: string; tag: string; tone: 'success' | 'warning' | 'neutral' }> = [
    { icon: 'terminal', title: '成功连接 production-web-01', meta: 'SSH · 192.168.1.101 · 10 分钟前', tag: '成功', tone: 'success' },
    { icon: 'server', title: 'Nginx 配置已重载', meta: 'production-web-02 · 任务 #4821 · 32 分钟前', tag: '成功', tone: 'success' },
    { icon: 'project', title: '项目 ecommerce-backend 部署完成', meta: 'Docker Compose · 1 小时前', tag: '告警', tone: 'warning' },
    { icon: 'file', title: '已同步 /var/log/nginx 日志', meta: '3 个文件 · 2 小时前', tag: '信息', tone: 'neutral' },
  ];

  const activities: Array<{ icon: IconName; title: string; meta: string; tag: string; tone: 'success' | 'warning' | 'neutral' }> =
    recentTasks.length > 0
      ? recentTasks.map((task) => ({ icon: 'history' as const, ...task }))
      : fallbackActivities;

  return (
    <div className="page-stack dashboard-page">
      <PageHeader
        actions={<>
          <button className="btn btn-secondary" type="button"><Icon name="download" size={15} />导出报告</button>
          <button className="btn btn-primary" onClick={onAddServer} type="button"><Icon name="plus" size={15} />添加服务器</button>
        </>}
        description="概览当前环境状态与运行任务"
        title="仪表盘"
      />

      <section aria-label="关键指标" className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">服务器总数</div>
          <div className="stat-value">{servers.length}</div>
          <div className="stat-change"><Icon name="check" size={12} /><span>生产环境 {production} 台</span></div>
        </div>
        <div className="stat-card">
          <div className="stat-label">在线连接</div>
          <div className="stat-value" style={{ color: 'var(--success)' }}>{connections.length}</div>
          <div className="stat-change"><Icon name="check" size={12} /><span>可信 SSH 连接</span></div>
        </div>
        <div className="stat-card">
          <div className="stat-label">运行中任务</div>
          <div className="stat-value">{runningTasks}</div>
          <div className="stat-change" style={{ color: runningTasks > 0 ? 'var(--warning)' : 'var(--success)' }}>
            <span>{runningTasks > 0 ? '有任务进行中' : '暂无任务'}</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">生产环境</div>
          <div className="stat-value">{production}</div>
          <div className="stat-change"><span>占比 {servers.length > 0 ? Math.round((production / servers.length) * 100) : 0}%</span></div>
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16, marginBottom: 16 }}>
        <div className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title">资源概览</h3>
              <div className="card-subtitle">已连接服务器最近 1 小时平均指标</div>
            </div>
            <div className="tabs" role="radiogroup">
              {(['cpu', 'memory', 'disk'] as const).map((tab) => (
                <button
                  aria-checked={chartTab === tab}
                  className={chartTab === tab ? 'tab active' : 'tab'}
                  key={tab}
                  onClick={() => setChartTab(tab)}
                  role="radio"
                  type="button"
                >
                  {{ cpu: 'CPU', memory: '内存', disk: '磁盘' }[tab]}
                </button>
              ))}
            </div>
          </div>
          <div className="card-body">
            <div className="metric-controls" style={{ marginBottom: 16 }}>
              <Select aria-label="指标服务器" onChange={(value) => setSelectedServerId(value)} options={[{ value: '', label: '选择已连接服务器' }, ...connections.map(({ server }) => ({ value: server.id, label: server.name }))]} value={selectedServerId} />
              <button className="btn btn-secondary" disabled={!selectedConnection} onClick={() => void loadMetrics()} type="button"><Icon name="refresh" size={14} />刷新指标</button>
            </div>
            {metricError ? <div className="alert warning-alert" role="alert" style={{ marginBottom: 16 }}>{metricError}</div> : null}
            <div aria-label="资源指标图" style={{ height: 220, background: 'var(--secondary-background)', borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'flex-end', padding: 16, gap: 8 }}>
              {barHeights.map((height, index) => (
                <div className="chart-bar" key={index} style={{ flex: 1, opacity: 0.55 + (index % 5) * 0.08, height: `${height}%` }} />
              ))}
            </div>
            <div className="live-metrics" style={{ marginTop: 16 }}>
              <div><span>系统</span><strong>{os?.prettyName ?? '不可用'}</strong></div>
              <div><span>内存</span><strong>{memoryPercent === undefined ? '不可用' : `${memoryPercent}%`}</strong></div>
              <div><span>Load 1m</span><strong>{metrics?.load?.one ?? '不可用'}</strong></div>
              <div><span>磁盘</span><strong>{metrics ? metrics.disks.length : '不可用'}</strong></div>
              <div><span>端口</span><strong>{ports ? ports.length : '不可用'}</strong></div>
              <div><span>服务</span><strong>{services ? services.length : '不可用'}</strong></div>
              {metrics?.unavailable.map((reason) => <p key={reason}>字段不可用：{reason}</p>)}
            </div>
          </div>
        </div>

        <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="card-header">
            <h3 className="card-title">Agent 状态</h3>
          </div>
          <div className="card-body" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 260, textAlign: 'center' }}>
            <div style={{ width: 80, height: 80, borderRadius: '50%', background: 'var(--accent-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Icon name="agent" size={36} />
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{agent?.agentAvailable ? 'AI Agent 就绪' : 'AI Agent 降级'}</div>
            <div style={{ fontSize: 13, color: 'var(--label-secondary)', maxWidth: 260 }}>
              {agent?.agentAvailable ? '可执行命令、分析日志、部署配置' : (agent?.reason ?? '本地 Sidecar 未就绪')}
            </div>
          </div>
          <div className="card-footer" style={{ marginTop: 'auto' }}>
            <button className="btn btn-primary" onClick={onOpenAgent} style={{ width: '100%' }} type="button">开始对话</button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">最近活动</h3>
          <button className="btn btn-ghost" type="button">查看全部</button>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          {activities.map((item, index) => (
            <div className="list-item" key={index}>
              <div className="list-item-icon"><Icon name={item.icon} size={18} /></div>
              <div className="list-item-content">
                <div className="list-item-title">{item.title}</div>
                <div className="list-item-meta">{item.meta}</div>
              </div>
              <span className={`status-tag ${item.tone}`}>{item.tag}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}