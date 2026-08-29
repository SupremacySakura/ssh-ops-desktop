import { useEffect, useState } from 'react';
import type { ApprovalProof, ApprovalRequest } from '@opspilot/contracts';

import type { CoreClient } from '../../api/core';
import { RiskDecisionDialog } from '../../app/risk-decision-dialog';
import { Select } from '../../app/ui/select';
import type { ConnectedServer } from '../terminal/terminal-page';

export function NginxPage({ connections, core }: { connections: ConnectedServer[]; core: CoreClient }) {
  const [serverId, setServerId] = useState(connections[0]?.server.id ?? '');
  const [path, setPath] = useState('');
  const [baseline, setBaseline] = useState('');
  const [candidate, setCandidate] = useState('');
  const [approval, setApproval] = useState<ApprovalRequest>();
  const [message, setMessage] = useState('');
  const connected = connections.find((item) => item.server.id === serverId);

  useEffect(() => { if (!serverId && connections[0]) setServerId(connections[0].server.id); }, [connections, serverId]);

  const discover = async () => {
    if (!connected || !core.nginxDiscover || !core.nginxRead) { setMessage('请先建立可信 SSH 连接'); return; }
    setMessage('正在发现 Nginx…');
    try {
      const discovered = await core.nginxDiscover(connected.connection);
      const bytes = await core.nginxRead(connected.connection, discovered);
      const text = new TextDecoder().decode(Uint8Array.from(bytes));
      setPath(discovered); setBaseline(text); setCandidate(text); setMessage('');
    } catch { setMessage('Nginx 未安装、权限不足或配置无法读取'); }
  };

  const prepare = async () => {
    if (!connected || !path || !candidate || !core.prepareOperation) return;
    try {
      const result = await core.prepareOperation({
        toolCallId: crypto.randomUUID(), runId: crypto.randomUUID(), serverId: connected.server.id,
        name: 'nginx.apply', schemaVersion: 1,
        args: { connection: connected.connection, livePath: path, mainConfigPath: path, candidate, healthUrl: null, confirmationTarget: path },
      });
      if (result.kind === 'awaiting_approval') setApproval(result);
      else if (result.kind === 'blocked') setMessage(`操作被阻断：${result.risk.reason}`);
    } catch { setMessage('候选配置或变更计划未通过 Core 校验'); }
  };

  const approve = async (proof: ApprovalProof) => {
    if (!core.approveOperation) return;
    try { await core.approveOperation(proof); setApproval(undefined); setMessage('Nginx 变更任务已提交'); }
    catch { setMessage('审批已失效或任务提交失败'); }
  };

  const reject = async () => {
    if (!approval) return;
    try { await core.rejectOperation?.(approval.approvalId); } finally { setApproval(undefined); setMessage('已拒绝，live 配置未变更'); }
  };

  const changed = path !== '' && candidate !== baseline;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Nginx</h1>
          <p>站点配置与 SSL 管理</p>
        </div>
        <div className="page-actions">
          <div style={{ width: 180 }}>
            <Select
              aria-label="Nginx 服务器"
              onChange={(value) => setServerId(value)}
              options={connections.map(({ server }) => ({ value: server.id, label: server.name }))}
              placeholder={connections.length === 0 ? '选择服务器' : '请选择服务器'}
              value={serverId}
            />
          </div>
          <button className="btn btn-primary" onClick={() => void discover()} type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
            <span>新建站点</span>
          </button>
        </div>
      </div>

      {message ? <div className="alert success-alert" role="status" style={{ marginBottom: 16 }}>{message}</div> : null}

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">配置编辑器</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {path ? <span className="status-badge"><i />{changed ? '候选已修改' : '与线上一致'}</span> : null}
            <button className="btn btn-primary" disabled={!changed} onClick={() => void prepare()} type="button">保存并重载</button>
          </div>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <textarea
            aria-label="Nginx 候选配置"
            className="textarea code-editor"
            disabled={!path}
            onChange={(event) => setCandidate(event.target.value)}
            placeholder="点击“编辑”或“新建站点”从远端读取配置…"
            style={{ minHeight: 320, border: 'none', borderRadius: 0 }}
            value={candidate}
          />
        </div>
      </div>

      {approval ? <RiskDecisionDialog environment={connected?.server.environment ?? 'other'} request={approval} onApprove={(proof) => void approve(proof)} onReject={() => void reject()} /> : null}
    </>
  );
}
