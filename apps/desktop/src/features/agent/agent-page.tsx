import { useEffect, useState } from 'react';
import type {
  AgentRunSummary, AgentThreadSummary, AgentToolDescriptor, ApprovalProof, ApprovalRequest,
  ModelProfileSummary, ServerSummary,
} from '@opspilot/contracts';

import type { AgentAvailability, CoreClient } from '../../api/core';
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
  const [catalog, setCatalog] = useState<AgentToolDescriptor[]>([]);
  const [threads, setThreads] = useState<AgentThreadSummary[]>([]);
  const [serverId, setServerId] = useState(servers[0]?.id ?? '');
  const [profileId, setProfileId] = useState(profiles.find((item) => item.isDefault)?.id ?? profiles[0]?.id ?? '');
  const [input, setInput] = useState('');
  const [run, setRun] = useState<AgentRunSummary>();
  const [error, setError] = useState('');
  const [approval, setApproval] = useState<ApprovalRequest>();
  const [approvalMessage, setApprovalMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const unavailable = availability?.agentAvailable !== true;

  useEffect(() => {
    let active = true;
    void Promise.all([
      core.agentCatalog?.().catch(() => []) ?? Promise.resolve([]),
      core.agentThreads?.().catch(() => []) ?? Promise.resolve([]),
    ]).then(([tools, existingThreads]) => {
      if (active) { setCatalog(tools); setThreads(existingThreads); }
    });
    return () => { active = false; };
  }, [core]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let active = true;
    void core.subscribeAgentApproval?.((request) => {
      if (active) { setApproval(request); setApprovalMessage(''); }
    }).then((stop) => { if (active) unsubscribe = stop; else stop(); });
    return () => { active = false; unsubscribe?.(); };
  }, [core]);

  useEffect(() => {
    if (!serverId && servers[0]) setServerId(servers[0].id);
  }, [serverId, servers]);
  useEffect(() => {
    if (!profileId && profiles[0]) {
      setProfileId(profiles.find((item) => item.isDefault)?.id ?? profiles[0].id);
    }
  }, [profileId, profiles]);

  const start = async () => {
    setError('');
    if (!serverId || !profileId || !input.trim()) {
      setError('请选择服务器和模型，并输入目标');
      return;
    }
    const connection = connections.find((item) => item.server.id === serverId)?.connection;
    if (!connection) {
      setError('请先在服务器页面建立可信连接，再让 Agent 读取实时状态');
      return;
    }
    if (!core.startAgentRun || !core.createAgentThread) {
      setError('当前 Core 不支持 Agent 运行');
      return;
    }
    setBusy(true);
    try {
      let thread = threads[0];
      if (!thread) {
        thread = await core.createAgentThread(input.trim().slice(0, 80));
        setThreads([thread]);
      }
      setRun(await core.startAgentRun({
        threadId: thread.id, serverId, modelProfileId: profileId, connection, input: input.trim(),
      }));
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

  const selectedEnvironment = servers.find((server) => server.id === serverId)?.environment ?? 'other';

  return <div className="page-stack">
    <div className="page-heading"><div><p className="eyebrow">LOCAL AI OPERATOR</p><h1>AI Agent</h1><p>Agent 只能调用 Rust 发布的工具目录，写操作与人工操作共用同一审批门。</p></div></div>
    {unavailable ? <div className="alert warning-alert" role="alert"><strong>AI Agent 暂不可用</strong><span>{availability?.reason ?? '正在检查本地 Sidecar。'}；人工终端、Docker 和 Nginx 功能不受影响。</span></div> : <div className="alert success-alert">Agent 已就绪</div>}
    <div className="tool-chips" aria-label="Agent 工具目录">{catalog.map((tool) => <span key={tool.name}>{tool.name}</span>)}</div>
    <div className="agent-layout">
      <section className="panel"><h2>对话</h2><div className="agent-scope">
        <label>服务器<select aria-label="Agent 服务器" onChange={(event) => setServerId(event.target.value)} value={serverId}><option value="">请选择</option>{servers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}</select></label>
        <label>模型<select aria-label="Agent 模型" onChange={(event) => setProfileId(event.target.value)} value={profileId}><option value="">请选择</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
      </div><textarea aria-label="Agent 输入" onChange={(event) => setInput(event.target.value)} placeholder="例如：解释这台服务器的状态，并提出安全建议" value={input} /><button className="primary" disabled={unavailable || busy} onClick={() => void start()} type="button">生成计划并运行</button>{error ? <p role="alert">{error}</p> : null}</section>
      <section className="panel"><h2>执行计划</h2>{run ? <ol className="run-plan"><li><strong>读取服务器概览</strong><span>Rust Core · L0</span></li><li><strong>生成解释</strong><span>远程模型 · 最小上下文</span></li></ol> : <div className="conversation-empty">等待结构化计划</div>}</section>
      <section className="panel"><h2>结果与审批</h2>{run ? <div className="run-result"><span className="status-badge"><i />{statusLabel(run.status)}</span><p>{run.outputSummary ?? '写操作正在等待你的审批。'}</p><small>Run {run.id}</small></div> : <div className="conversation-empty">没有待审批项</div>}</section>
    </div>
    {approval ? <RiskDecisionDialog environment={selectedEnvironment} request={approval} onApprove={(proof) => void approve(proof)} onReject={() => void reject()} /> : null}
    {approvalMessage ? <div className="alert success-alert" role="status">{approvalMessage}</div> : null}
    <a className="manual-link" href="#terminal">打开终端</a>
  </div>;
}

function statusLabel(status: AgentRunSummary['status']): string {
  if (status === 'succeeded') return '已完成';
  if (status === 'awaiting_approval') return '等待审批';
  if (status === 'failed') return '失败';
  return '运行中';
}
