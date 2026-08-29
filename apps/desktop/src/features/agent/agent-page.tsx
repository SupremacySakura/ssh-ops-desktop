import { useEffect, useState } from 'react';
import type { AgentRunSummary, ApprovalProof, ApprovalRequest, ModelProfileSummary, ServerSummary } from '@opspilot/contracts';

import type { AgentAvailability, CoreClient } from '../../api/core';
import { Icon } from '../../app/icons';
import { PageHeader } from '../../app/ui/layout';
import { RiskDecisionDialog } from '../../app/risk-decision-dialog';
import type { ConnectedServer } from '../terminal/terminal-page';

interface AgentPageProps {
  availability?: AgentAvailability;
  connections: ConnectedServer[];
  core: CoreClient;
  profiles: ModelProfileSummary[];
  servers: ServerSummary[];
}

export function AgentPage({ availability, connections, core, profiles, servers }: AgentPageProps) {
  const serverId = servers[0]?.id ?? '';
  const profileId = profiles.find((item) => item.isDefault)?.id ?? profiles[0]?.id ?? '';
  const [input, setInput] = useState('');
  const [run, setRun] = useState<AgentRunSummary>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<ApprovalRequest>();
  const [approvalMessage, setApprovalMessage] = useState('');
  const unavailable = availability?.agentAvailable !== true;

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let active = true;
    void core.subscribeAgentApproval?.((request) => {
      if (active) { setApproval(request); setApprovalMessage(''); }
    }).then((stop) => { if (active) unsubscribe = stop; else stop(); });
    return () => { active = false; unsubscribe?.(); };
  }, [core]);

  const start = async () => {
    setError('');
    if (!input.trim()) {
      setError('请输入指令或问题');
      return;
    }
    const connection = connections.find((item) => item.server.id === serverId)?.connection;
    if (!serverId || !profileId || !connection) {
      setError('请先在服务器页面建立可信连接');
      return;
    }
    if (!core.startAgentRun || !core.createAgentThread) {
      setError('当前 Core 不支持 Agent 运行');
      return;
    }
    setBusy(true);
    try {
      const thread = await core.createAgentThread(input.trim().slice(0, 80));
      setRun(await core.startAgentRun({ threadId: thread.id, serverId, modelProfileId: profileId, connection, input: input.trim() }));
      setInput('');
    } catch {
      setError('Agent 运行失败；人工运维功能仍可使用');
    } finally {
      setBusy(false);
    }
  };

  const approve = async (proof: ApprovalProof) => {
    if (!core.approveOperation) { setApprovalMessage('当前 Core 不支持审批提交'); return; }
    try {
      await core.approveOperation(proof);
      setApproval(undefined);
      setApprovalMessage('任务已提交，执行状态由任务中心持续跟踪');
    } catch { setApprovalMessage('审批已失效或提交失败，请刷新计划'); }
  };

  const reject = async () => {
    if (!approval || !core.rejectOperation) return;
    try {
      await core.rejectOperation(approval.approvalId);
      setApproval(undefined);
      setApprovalMessage('已拒绝，远端操作未执行');
    } catch { setApprovalMessage('拒绝提交失败，请重试'); }
  };

  const clear = () => { setInput(''); setRun(undefined); setError(''); };

  return (
    <div className="page-stack agent-page">
      <PageHeader
        actions={<button className="btn btn-secondary" onClick={clear} type="button"><Icon name="refresh" size={15} />清空对话</button>}
        description="用自然语言运维你的服务器"
        title="AI Agent"
      />
      {availability && !availability.agentAvailable ? (
        <div className="alert warning-alert" role="alert">
          <strong>AI Agent 暂不可用</strong>
          <span>{availability.reason ?? '本地 Sidecar 未就绪'}</span>
        </div>
      ) : null}
      <div className="chat-container">
        <div className="chat-messages">
          {run ? (
            <div className="chat-message">
              <span className="chat-avatar"><Icon name="agent" size={14} /></span>
              <div className="chat-bubble">{run.outputSummary ?? '任务已提交，等待输出…'}</div>
            </div>
          ) : (
            <div className="conversation-empty">输入指令或问题，Agent 的回复会显示在这里</div>
          )}
        </div>
        <div className="chat-input-area">
          <div className="chat-input-row">
            <input
              aria-label="Agent 输入"
              className="input"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void start(); } }}
              placeholder="输入指令或问题..."
              type="text"
              value={input}
            />
            <button aria-label="发送" className="btn btn-primary" disabled={unavailable || busy} onClick={() => void start()} type="button"><Icon name="send" size={15} /></button>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--label-tertiary)' }}>Agent 将只在获得你确认后执行破坏性操作</div>
          {error ? <p role="alert" style={{ color: 'var(--error)', margin: '8px 0 0' }}>{error}</p> : null}
        </div>
      </div>
      {approval ? <RiskDecisionDialog environment={servers.find((server) => server.id === serverId)?.environment ?? 'other'} request={approval} onApprove={(proof) => void approve(proof)} onReject={() => void reject()} /> : null}
      {approvalMessage ? <div className="alert success-alert" role="status">{approvalMessage}</div> : null}
    </div>
  );
}