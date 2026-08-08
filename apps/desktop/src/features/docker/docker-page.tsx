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
import type { ConnectedServer } from '../terminal/terminal-page';

export function DockerPage({ connections, core, onExec }: {
  connections: ConnectedServer[];
  core: CoreClient;
  onExec?(session: TerminalSession, server: ServerSummary): void;
}) {
  const [serverId, setServerId] = useState(connections[0]?.server.id ?? '');
  const [version, setVersion] = useState<DockerVersion>();
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [logs, setLogs] = useState('');
  const [stats, setStats] = useState<DockerStats>();
  const [approval, setApproval] = useState<ApprovalRequest>();
  const [message, setMessage] = useState('');
  const connected = connections.find((item) => item.server.id === serverId);

  useEffect(() => { if (!serverId && connections[0]) setServerId(connections[0].server.id); }, [connections, serverId]);

  const load = async () => {
    if (!connected || !core.dockerVersion || !core.dockerContainers) { setMessage('请先建立可信 SSH 连接'); return; }
    setMessage('正在查询 Docker CLI…');
    try {
      const [nextVersion, nextContainers] = await Promise.all([
        core.dockerVersion(connected.connection), core.dockerContainers(connected.connection, true),
      ]);
      setVersion(nextVersion); setContainers(nextContainers); setMessage('');
    } catch { setMessage('Docker 不可用或当前用户没有权限'); }
  };

  const showLogs = async (container: DockerContainer) => {
    if (!connected || !core.dockerLogs) return;
    try { setLogs(await core.dockerLogs(connected.connection, container.names, 200)); }
    catch { setLogs('日志读取失败'); }
  };

  const showStats = async (container: DockerContainer) => {
    if (!connected || !core.dockerStats) return;
    try { setStats(await core.dockerStats(connected.connection, container.names)); }
    catch { setMessage('容器指标读取失败'); }
  };

  const openExec = async (container: DockerContainer) => {
    if (!connected || !core.openDockerExec) return;
    try {
      const session = await core.openDockerExec(connected.connection, container.names, 120, 32);
      setMessage(`已为 ${container.names} 创建隔离 Exec 会话`);
      onExec?.(session, connected.server);
    } catch {
      setMessage('Docker Exec 创建失败；请检查容器状态与 shell 可用性');
    }
  };

  const prepare = async (name: string, container: DockerContainer) => {
    if (!connected || !core.prepareOperation) return;
    const toolCallId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    try {
      const result = await core.prepareOperation({
        toolCallId, runId, serverId: connected.server.id, name, schemaVersion: 1,
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

  return <div className="page-stack"><div className="page-heading"><div><p className="eyebrow">CONTAINERS</p><h1>Docker</h1><p>查询使用远端 Docker CLI；任何写操作先由 Rust 风险网关准备。</p></div><div className="heading-actions"><select aria-label="Docker 服务器" onChange={(event) => setServerId(event.target.value)} value={serverId}><option value="">选择服务器</option>{connections.map(({ server }) => <option key={server.id} value={server.id}>{server.name}</option>)}</select><button className="primary" onClick={() => void load()} type="button">加载 Docker</button></div></div>
    {message ? <div className="alert success-alert" role="status">{message}</div> : null}
    <div className="metrics-grid compact"><Metric label="Engine" value={version?.version ?? '—'} /><Metric label="运行中" value={String(containers.filter((item) => item.state === 'running').length)} /><Metric label="已停止" value={String(containers.filter((item) => item.state !== 'running').length)} /><Metric label="传输" value={version?.transport ?? '—'} /></div>
    <div className="docker-layout"><section className="panel"><div className="table-wrap"><table aria-label="Docker 容器"><thead><tr><th>容器</th><th>镜像</th><th>状态</th><th>端口</th><th>操作</th></tr></thead><tbody>{containers.length === 0 ? <tr><td className="empty-cell" colSpan={5}>等待加载容器</td></tr> : containers.map((container) => <tr key={container.id}><td><strong>{container.names}</strong><small>{container.id}</small></td><td>{container.image}</td><td>{container.status}</td><td>{container.ports || '—'}</td><td><div className="row-actions"><button aria-label={`查看 ${container.names} 日志`} onClick={() => void showLogs(container)} type="button">日志</button><button aria-label={`查看 ${container.names} 指标`} onClick={() => void showStats(container)} type="button">指标</button>{container.state === 'running' ? <><button aria-label={`进入 ${container.names} Exec`} onClick={() => void openExec(container)} type="button">Exec</button><button aria-label={`停止 ${container.names}`} onClick={() => void prepare('docker.container.stop', container)} type="button">停止</button></> : <button aria-label={`启动 ${container.names}`} onClick={() => void prepare('docker.container.start', container)} type="button">启动</button>}<button aria-label={`重启 ${container.names}`} onClick={() => void prepare('docker.container.restart', container)} type="button">重启</button><button aria-label={`删除 ${container.names}`} onClick={() => void prepare('docker.container.remove', container)} type="button">删除</button></div></td></tr>)}</tbody></table></div></section><section className="panel log-panel"><h2>容器日志与指标</h2>{stats ? <dl className="risk-details"><div><dt>CPU</dt><dd>{stats.cpuPercent}</dd></div><div><dt>内存</dt><dd>{stats.memoryUsage} · {stats.memoryPercent}</dd></div><div><dt>网络</dt><dd>{stats.networkIo}</dd></div></dl> : null}<pre>{logs || '选择容器查看最近 200 行日志'}</pre></section></div>
    {approval ? <RiskDecisionDialog environment={connected?.server.environment ?? 'other'} request={approval} onApprove={(proof) => void approve(proof)} onReject={() => void reject()} /> : null}
  </div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <article className="metric-card"><span>{label}</span><strong>{value}</strong></article>;
}
