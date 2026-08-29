import { useEffect, useState } from 'react';
import type { ApprovalProof, ApprovalRequest, DockerContainer, DockerVersion, ServerSummary, TerminalSession } from '@opspilot/contracts';

import type { CoreClient } from '../../api/core';
import { RiskDecisionDialog } from '../../app/risk-decision-dialog';
import { Select } from '../../app/ui/select';
import type { ConnectedServer } from '../terminal/terminal-page';

export function DockerPage({ connections, core, onExec }: {
  connections: ConnectedServer[];
  core: CoreClient;
  onExec?(session: TerminalSession, server: ServerSummary): void;
}) {
  const [serverId, setServerId] = useState(connections[0]?.server.id ?? '');
  const [version, setVersion] = useState<DockerVersion>();
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [loaded, setLoaded] = useState(false);
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
      setVersion(nextVersion); setContainers(nextContainers); setLoaded(true); setMessage('');
    } catch { setLoaded(false); setMessage('Docker 不可用或当前用户没有权限'); }
  };

  const openExec = async (container: DockerContainer) => {
    if (!connected || !core.openDockerExec) return;
    try {
      const session = await core.openDockerExec(connected.connection, container.names, 120, 32);
      setMessage(`已为 ${container.names} 创建隔离 Exec 会话`);
      onExec?.(session, connected.server);
    } catch { setMessage('Docker Exec 创建失败；请检查容器状态与 shell 可用性'); }
  };

  const prepare = async (name: string, container: DockerContainer) => {
    if (!connected || !core.prepareOperation) return;
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

  return (
    <div className="docker-page">
      <div className="page-header">
        <div>
          <h1>Docker</h1>
          <p>容器与镜像管理</p>
        </div>
        <div className="page-actions">
          <div style={{ width: 180 }}>
            <Select
              aria-label="Docker 服务器"
              onChange={(value) => setServerId(value)}
              options={connections.map(({ server }) => ({ value: server.id, label: server.name }))}
              placeholder={connections.length === 0 ? '选择服务器' : '请选择服务器'}
              value={serverId}
            />
          </div>
          <button className="btn btn-primary" onClick={() => void load()} type="button">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24"><line x1="12" x2="12" y1="5" y2="19" /><line x1="5" x2="19" y1="12" y2="12" /></svg>
            <span>运行容器</span>
          </button>
        </div>
      </div>

      {message ? <div className="alert success-alert" role="status">{message}</div> : null}

      <div className="tabs" style={{ marginBottom: 20 }}>
        <button className="tab active" type="button">容器</button>
        <button className="tab" type="button">镜像</button>
        <button className="tab" type="button">卷</button>
        <button className="tab" type="button">网络</button>
      </div>

      <div className="card">
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>容器</th>
                <th>镜像</th>
                <th>状态</th>
                <th>端口</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {containers.length === 0
                ? <tr><td className="empty-cell" colSpan={5}>{loaded ? '当前服务器没有容器' : '等待加载容器'}</td></tr>
                : containers.map((container) => {
                  const running = container.state === 'running';
                  return (
                    <tr key={container.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{container.names}</div>
                        <div style={{ fontSize: 12, color: 'var(--label-secondary)' }}>{container.id}</div>
                      </td>
                      <td>{container.image}</td>
                      <td><span className={running ? 'status-tag success' : 'status-tag warning'}>{container.status}</span></td>
                      <td>{container.ports || '—'}</td>
                      <td>
                        {running ? (
                          <button aria-label={`停止 ${container.names}`} className="btn btn-icon" onClick={() => void prepare('docker.container.stop', container)} type="button">
                            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24"><rect height="16" width="4" x="6" y="4" /><rect height="16" width="4" x="14" y="4" /></svg>
                          </button>
                        ) : (
                          <button aria-label={`启动 ${container.names}`} className="btn btn-icon" onClick={() => void prepare('docker.container.start', container)} type="button">
                            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5" /></svg>
                          </button>
                        )}
                        <button aria-label={`进入 ${container.names} Exec`} className="btn btn-icon" onClick={() => void openExec(container)} type="button">
                          <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24"><path d="M9 9l-6 3 6 3" /><path d="M13 15l6 3-6-3" /></svg>
                        </button>
                        <button aria-label={`删除 ${container.names}`} className="btn btn-icon" onClick={() => void prepare('docker.container.remove', container)} type="button">
                          <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
                        </button>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>

      {version ? <div style={{ marginTop: 12, fontSize: 12, color: 'var(--label-secondary)' }}>Engine {version.version} · API {version.apiVersion} · {version.os}/{version.arch}</div> : null}

      {approval ? <RiskDecisionDialog environment={connected?.server.environment ?? 'other'} request={approval} onApprove={(proof) => void approve(proof)} onReject={() => void reject()} /> : null}
    </div>
  );
}
