import { useEffect, useState } from 'react';
import type { ApprovalProof, ApprovalRequest } from '@opspilot/contracts';

import type { CoreClient } from '../../api/core';
import { RiskDecisionDialog } from '../../app/risk-decision-dialog';
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

  return <div className="page-stack"><div className="page-heading"><div><p className="eyebrow">SAFE CONFIGURATION</p><h1>Nginx</h1><p>固定执行快照、nginx -t、原子替换、reload 与健康检查。</p></div><div className="heading-actions"><select aria-label="Nginx 服务器" onChange={(event) => setServerId(event.target.value)} value={serverId}><option value="">选择服务器</option>{connections.map(({ server }) => <option key={server.id} value={server.id}>{server.name}</option>)}</select><button className="primary" onClick={() => void discover()} type="button">发现并读取配置</button></div></div>
    <ol className="safety-chain"><li><b>1</b>创建快照</li><li><b>2</b>候选配置</li><li><b>3</b>nginx -t</li><li><b>4</b>原子替换</li><li><b>5</b>健康检查</li></ol>
    {message ? <div className="alert success-alert" role="status">{message}</div> : null}
    <div className="nginx-layout"><section className="panel"><div className="panel-title"><h2>{path || '尚未选择配置'}</h2><span className="status-badge"><i />源码模式</span></div><textarea aria-label="Nginx 候选配置" disabled={!path} onChange={(event) => setCandidate(event.target.value)} value={candidate} /><button className="primary" disabled={!path || candidate === baseline} onClick={() => void prepare()} type="button">准备安全变更</button></section><section className="panel diff-panel"><h2>保存前 Diff</h2>{candidate === baseline ? <div className="conversation-empty">修改候选配置后显示 Diff</div> : <pre><span className="diff-remove">- {baseline}</span>{'\n'}<span className="diff-add">+ {candidate}</span></pre>}</section></div>
    {approval ? <RiskDecisionDialog environment={connected?.server.environment ?? 'other'} request={approval} onApprove={(proof) => void approve(proof)} onReject={() => void reject()} /> : null}
  </div>;
}
