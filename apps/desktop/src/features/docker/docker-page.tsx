import { useEffect, useState } from 'react';
import type {
  ApprovalProof,
  ApprovalRequest,
  DockerContainer,
  DockerStats,
  DockerVersion,
  ServerSummary,
  TerminalSession,
} from '@opspilot/contracts';

import type { CoreClient } from '../../api/core';
import { RiskDecisionDialog } from '../../app/risk-decision-dialog';
import { DetailPane, MetricCard, PageHeader, Panel, ProgressBar, SectionHeader } from '../../app/ui/layout';
import type { ConnectedServer } from '../terminal/terminal-page';

export function DockerPage({ connections, core, onExec }: {
  connections: ConnectedServer[];
  core: CoreClient;
  onExec?(session: TerminalSession, server: ServerSummary): void;
}) {
  const [serverId, setServerId] = useState(connections[0]?.server.id ?? '');
  const [version, setVersion] = useState<DockerVersion>();
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [selectedContainerId, setSelectedContainerId] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [logs, setLogs] = useState('');
  const [stats, setStats] = useState<DockerStats>();
  const [approval, setApproval] = useState<ApprovalRequest>();
  const [message, setMessage] = useState('');
  const connected = connections.find((item) => item.server.id === serverId);
  const selectedContainer = containers.find((container) => container.id === selectedContainerId);

  useEffect(() => { if (!serverId && connections[0]) setServerId(connections[0].server.id); }, [connections, serverId]);

  const load = async () => {
    if (!connected || !core.dockerVersion || !core.dockerContainers) { setMessage('请先建立可信 SSH 连接'); return; }
    setMessage('正在查询 Docker CLI…');
    try {
      const [nextVersion, nextContainers] = await Promise.all([
        core.dockerVersion(connected.connection), core.dockerContainers(connected.connection, true),
      ]);
      setVersion(nextVersion); setContainers(nextContainers); setLoaded(true); setMessage('');
    } catch { setLoaded(false); setMessage('Docker 不可用或当前用户没有权限'); }
  };

  const showLogs = async (container: DockerContainer) => {
    if (!connected || !core.dockerLogs) return;
    setSelectedContainerId(container.id);
    try { setLogs(await core.dockerLogs(connected.connection, container.names, 200)); }
    catch { setLogs('日志读取失败'); }
  };
  const showStats = async (container: DockerContainer) => {
    if (!connected || !core.dockerStats) return;
    setSelectedContainerId(container.id);
    try { setStats(await core.dockerStats(connected.connection, container.names)); }
    catch { setStats(undefined); setMessage('容器指标读取失败'); }
  };
  const openExec = async (container: DockerContainer) => {
    if (!connected || !core.openDockerExec) return;
    setSelectedContainerId(container.id);
    try {
      const session = await core.openDockerExec(connected.connection, container.names, 120, 32);
      setMessage(`已为 ${container.names} 创建隔离 Exec 会话`);
      onExec?.(session, connected.server);
    } catch { setMessage('Docker Exec 创建失败；请检查容器状态与 shell 可用性'); }
  };
  const prepare = async (name: string, container: DockerContainer) => {
    if (!connected || !core.prepareOperation) return;
    setSelectedContainerId(container.id);
    try {
      const result = await core.prepareOperation({
        toolCallId: crypto.randomUUID(), runId: crypto.randomUUID(), serverId: connected.server.id, name, schemaVersion: 1,
        args: { connection: connected.connection, container: container.names },
      });
      if (result.kind === 'awaiting_approval') setApproval(result);
      else if (result.kind === 'blocked') setMessage(`操作被阻断：${result.risk.reason}`);
    } catch { setMessage('Docker 操作计划校验失败'); }
  };
  const approve = async (proof: ApprovalProof) => {
    if (!core.approveOperation) return;
    try { await core.approveOperation(proof); setApproval(undefined); setMessage('Docker 任务已提交'); }
    catch { setMessage('审批已失效或任务提交失败'); }
  };
  const reject = async () => {
    if (!approval) return;
    try { await core.rejectOperation?.(approval.approvalId); } finally { setApproval(undefined); setMessage('已拒绝，容器未变更'); }
  };

  const running = containers.filter((item) => item.state === 'running').length;
  const stopped = containers.length - running;

  return <div className="page-stack docker-page">
    <PageHeader actions={<><select aria-label="Docker 服务器" onChange={(event) => setServerId(event.target.value)} value={serverId}><option value="">选择服务器</option>{connections.map(({ server }) => <option key={server.id} value={server.id}>{server.name}</option>)}</select><button className="primary" onClick={() => void load()} type="button">加载 Docker</button></>} description="查询使用远端 Docker CLI；任何写操作先由 Rust 风险网关准备。" eyebrow="Containers" title="Docker" />
    {message ? <div className="alert success-alert" role="status">{message}</div> : null}
    <section className="metrics-grid compact" aria-label="Docker 指标">
      <MetricCard detail={version ? `API ${version.apiVersion}` : '等待连接'} icon="docker" label="Engine" value={version?.version ?? '—'} />
      <MetricCard detail="来自容器列表" icon="activity" label="运行中" tone="success" value={loaded ? running : '—'} />
      <MetricCard detail="来自容器列表" icon="alert" label="已停止" tone="warning" value={loaded ? stopped : '—'} />
      <MetricCard detail={version ? `${version.os} / ${version.arch}` : 'Core 未提供镜像与卷统计'} icon="terminal" label="传输" value={version?.transport ?? '—'} />
    </section>
    <div className={selectedContainer ? 'docker-workspace has-detail' : 'docker-workspace'}>
      <div className="docker-main">
        <Panel className="docker-table-panel"><SectionHeader count={containers.length} title="容器列表" /><div className="table-wrap"><table aria-label="Docker 容器"><thead><tr><th>容器</th><th>镜像</th><th>状态</th><th>端口</th><th>操作</th></tr></thead><tbody>{containers.length === 0 ? <tr><td className="empty-cell" colSpan={5}>{loaded ? '当前服务器没有容器' : '等待加载容器'}</td></tr> : containers.map((container) => <tr className={container.id === selectedContainerId ? 'selected-row' : undefined} key={container.id}><td><button aria-label={`查看 ${container.names} 详情`} className="server-name-button" onClick={() => setSelectedContainerId(container.id)} type="button"><strong>{container.names}</strong><small>{container.id}</small></button></td><td>{container.image}</td><td><span className="status-badge"><i />{container.status}</span></td><td>{container.ports || '—'}</td><td><div className="row-actions"><button aria-label={`查看 ${container.names} 日志`} onClick={() => void showLogs(container)} type="button">日志</button><button aria-label={`查看 ${container.names} 指标`} onClick={() => void showStats(container)} type="button">指标</button>{container.state === 'running' ? <><button aria-label={`进入 ${container.names} Exec`} onClick={() => void openExec(container)} type="button">Exec</button><button aria-label={`停止 ${container.names}`} onClick={() => void prepare('docker.container.stop', container)} type="button">停止</button></> : <button aria-label={`启动 ${container.names}`} onClick={() => void prepare('docker.container.start', container)} type="button">启动</button>}<button aria-label={`重启 ${container.names}`} onClick={() => void prepare('docker.container.restart', container)} type="button">重启</button><button aria-label={`删除 ${container.names}`} onClick={() => void prepare('docker.container.remove', container)} type="button">删除</button></div></td></tr>)}</tbody></table></div></Panel>
        <Panel className="log-panel"><SectionHeader description="最近 200 行真实输出" title="容器日志" /><pre>{logs || '选择容器查看日志'}</pre></Panel>
      </div>
      {selectedContainer ? <DetailPane onClose={() => { setSelectedContainerId(undefined); setStats(undefined); }} subtitle={selectedContainer.id} title={selectedContainer.names}><div className="detail-status-line"><span className="status-badge"><i />{selectedContainer.status}</span></div><dl className="detail-list"><div><dt>镜像</dt><dd>{selectedContainer.image}</dd></div><div><dt>端口</dt><dd>{selectedContainer.ports || '未暴露端口'}</dd></div><div><dt>状态</dt><dd>{selectedContainer.state}</dd></div></dl>{stats ? <><ProgressBar detail={stats.cpuPercent} label="CPU" value={Number.parseFloat(stats.cpuPercent)} /><ProgressBar detail={`${stats.memoryUsage} · ${stats.memoryPercent}`} label="内存" value={Number.parseFloat(stats.memoryPercent)} /><dl className="detail-list"><div><dt>网络</dt><dd>{stats.networkIo}</dd></div><div><dt>块设备</dt><dd>{stats.blockIo}</dd></div></dl></> : <div className="assistant-note"><strong>指标不可用</strong><p>点击表格中的“指标”后由 Core 实时读取。</p></div>}</DetailPane> : null}
    </div>
    {approval ? <RiskDecisionDialog environment={connected?.server.environment ?? 'other'} request={approval} onApprove={(proof) => void approve(proof)} onReject={() => void reject()} /> : null}
  </div>;
}
