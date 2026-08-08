import { useEffect, useState } from 'react';
import type { ApprovalProof, ApprovalRequest } from '@opspilot/contracts';

import type { CoreClient } from '../../api/core';
import { RiskDecisionDialog } from '../../app/risk-decision-dialog';
import { DetailPane, PageHeader, Panel, SectionHeader } from '../../app/ui/layout';
import type { ConnectedServer } from '../terminal/terminal-page';

export function NginxPage({ connections, core }: { connections: ConnectedServer[]; core: CoreClient }) {
  const [serverId, setServerId] = useState(connections[0]?.server.id ?? '');
  const [path, setPath] = useState('');
  const [baseline, setBaseline] = useState('');
  const [candidate, setCandidate] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
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
      setPath(discovered); setBaseline(text); setCandidate(text); setDetailsOpen(true); setMessage('');
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

  return <div className="page-stack nginx-page">
    <PageHeader actions={<><select aria-label="Nginx 服务器" onChange={(event) => setServerId(event.target.value)} value={serverId}><option value="">选择服务器</option>{connections.map(({ server }) => <option key={server.id} value={server.id}>{server.name}</option>)}</select><button className="primary" onClick={() => void discover()} type="button">发现并读取配置</button></>} description="固定执行快照、配置校验、原子替换、平滑重载与健康检查。" eyebrow="Safe configuration" title="Nginx" />
    <ol aria-label="Nginx 安全变更流程" className="safety-chain"><li><b>1</b><span>创建快照</span></li><li><b>2</b><span>候选配置</span></li><li><b>3</b><span>配置校验</span><small>nginx -t</small></li><li><b>4</b><span>平滑重载</span></li><li><b>5</b><span>健康检查</span></li></ol>
    {message ? <div className="alert success-alert" role="status">{message}</div> : null}
    <div className={path && detailsOpen ? 'nginx-workspace has-detail' : 'nginx-workspace'}>
      <div className="nginx-main">
        <Panel className="nginx-editor-panel"><SectionHeader actions={<span className="status-badge"><i />{path ? (changed ? '候选已修改' : '与线上一致') : '等待发现'}</span>} title={path || '尚未选择配置'} /><textarea aria-label="Nginx 候选配置" disabled={!path} onChange={(event) => setCandidate(event.target.value)} value={candidate} /><button className="primary" disabled={!changed} onClick={() => void prepare()} type="button">准备安全变更</button></Panel>
        <Panel className="diff-panel"><SectionHeader description="提交审批前核对真实候选内容" title="保存前 Diff" />{candidate === baseline ? <div className="conversation-empty">修改候选配置后显示 Diff</div> : <pre><span className="diff-remove">- {baseline}</span>{'\n'}<span className="diff-add">+ {candidate}</span></pre>}</Panel>
      </div>
      {path && detailsOpen ? <DetailPane ariaLabel="Nginx 配置详情" onClose={() => setDetailsOpen(false)} subtitle={connected?.server.name ?? '服务器不可用'} title="Nginx 配置"><div className="detail-status-line"><span className="status-badge"><i />{changed ? '待校验' : '已读取'}</span></div><dl className="detail-list"><div><dt>配置路径</dt><dd>{path}</dd></div><div><dt>目标服务器</dt><dd>{connected?.server.name ?? '不可用'}</dd></div><div><dt>环境</dt><dd>{connected?.server.environment ?? 'unknown'}</dd></div><div><dt>变更状态</dt><dd>{changed ? '候选内容已修改' : '候选内容与线上一致'}</dd></div></dl><div className="assistant-note"><strong>固定安全链路</strong><p>Core 会执行快照、nginx -t、原子替换、reload 与健康检查；UI 不会绕过其中任何一步。</p></div></DetailPane> : null}
    </div>
    {approval ? <RiskDecisionDialog environment={connected?.server.environment ?? 'other'} request={approval} onApprove={(proof) => void approve(proof)} onReject={() => void reject()} /> : null}
  </div>;
}
