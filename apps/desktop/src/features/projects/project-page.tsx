import { useEffect, useState } from 'react';
import type { ApprovalProof, ApprovalRequest, ProjectDetection, ProjectSummary } from '@opspilot/contracts';

import type { CoreClient } from '../../api/core';
import { RiskDecisionDialog } from '../../app/risk-decision-dialog';
import type { ConnectedServer } from '../terminal/terminal-page';

export function ProjectsPage({ connections, core }: { connections: ConnectedServer[]; core: CoreClient }) {
  const [serverId, setServerId] = useState(connections[0]?.server.id ?? '');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [name, setName] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [detection, setDetection] = useState<ProjectDetection>();
  const [revisions, setRevisions] = useState<Record<string, string>>({});
  const [approval, setApproval] = useState<ApprovalRequest>();
  const [message, setMessage] = useState('');
  const connected = connections.find((item) => item.server.id === serverId);

  useEffect(() => { if (!serverId && connections[0]) setServerId(connections[0].server.id); }, [connections, serverId]);
  useEffect(() => {
    let active = true;
    if (!serverId) { setProjects([]); return () => { active = false; }; }
    void (core.projects?.(serverId) ?? Promise.resolve([])).then((items) => { if (active) setProjects(items); }).catch(() => { if (active) setMessage('项目列表读取失败'); });
    return () => { active = false; };
  }, [core, serverId]);

  const detect = async () => {
    if (!connected || !core.detectProject || !rootPath) { setMessage('请选择已连接服务器并输入根目录'); return; }
    try { setDetection(await core.detectProject(connected.connection, rootPath)); setMessage(''); }
    catch { setMessage('项目检测失败，请检查目录与权限'); }
  };
  const create = async () => {
    if (!connected || !core.createProject || !detection || !name) return;
    try {
      const project = await core.createProject({
        serverId: connected.server.id, name, rootPath, runtime: detection.primary,
        deployStrategy: detection.primary === 'docker_compose' ? 'docker_compose' : 'release_symlink',
        ...(repositoryUrl ? { repositoryUrl } : {}),
      });
      setProjects((items) => [project, ...items]);
      if (project.deployStrategy === 'docker_compose') {
        setRevisions((items) => ({ ...items, [project.id]: 'compose' }));
      }
      setMessage('项目已创建');
    } catch { setMessage('项目创建失败'); }
  };
  const deploy = async (project: ProjectSummary) => {
    const revision = project.deployStrategy === 'docker_compose' ? 'compose' : revisions[project.id];
    if (!connected || !core.prepareOperation || !revision) return;
    try {
      const result = await core.prepareOperation({
        toolCallId: crypto.randomUUID(), runId: crypto.randomUUID(), serverId: project.serverId,
        name: 'deploy.run', schemaVersion: 1,
        args: { connection: connected.connection, projectId: project.id, revision, healthUrl: null },
      });
      if (result.kind === 'awaiting_approval') setApproval(result);
      else if (result.kind === 'blocked') setMessage(`发布被阻断：${result.risk.reason}`);
    } catch { setMessage('发布计划未通过 Core 校验'); }
  };
  const approve = async (proof: ApprovalProof) => {
    try { await core.approveOperation?.(proof); setApproval(undefined); setMessage('发布任务已提交'); }
    catch { setMessage('审批已失效或任务提交失败'); }
  };
  const reject = async () => {
    if (!approval) return;
    try { await core.rejectOperation?.(approval.approvalId); } finally { setApproval(undefined); setMessage('已拒绝，未执行发布'); }
  };

  return <div className="page-stack"><div className="page-heading"><div><p className="eyebrow">DEPLOYMENTS</p><h1>项目与发布</h1><p>检测运行时、持久化项目，并通过可审查计划执行发布。</p></div><select aria-label="项目服务器" onChange={(event) => setServerId(event.target.value)} value={serverId}><option value="">选择服务器</option>{connections.map(({ server }) => <option key={server.id} value={server.id}>{server.name}</option>)}</select></div>
    <section className="panel project-form"><label>项目根目录<input aria-label="项目根目录" onChange={(event) => setRootPath(event.target.value)} placeholder="/srv/app" value={rootPath} /></label><button onClick={() => void detect()} type="button">检测项目</button><label>项目名称<input aria-label="项目名称" onChange={(event) => setName(event.target.value)} value={name} /></label><label>Git 仓库（Compose 可留空）<input aria-label="Git 仓库" onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="https://example.com/team/app.git" value={repositoryUrl} /></label><button className="primary" disabled={!detection || !name || (detection.primary !== 'docker_compose' && !repositoryUrl)} onClick={() => void create()} type="button">创建项目</button>{detection ? <span className="status-badge"><i />{detection.primary} · {Math.round(detection.confidence * 100)}%</span> : null}</section>
    {message ? <div className="alert success-alert" role="status">{message}</div> : null}
    <section className="panel"><div className="table-wrap"><table aria-label="项目列表"><thead><tr><th>项目</th><th>根目录</th><th>运行时</th><th>策略</th><th>发布版本</th><th>操作</th></tr></thead><tbody>{projects.length === 0 ? <tr><td className="empty-cell" colSpan={6}>暂无项目</td></tr> : projects.map((project) => { const compose = project.deployStrategy === 'docker_compose'; const revision = compose ? 'compose' : revisions[project.id] ?? ''; return <tr key={project.id}><td><strong>{project.name}</strong></td><td>{project.rootPath}</td><td>{project.runtime}</td><td>{project.deployStrategy}</td><td><input aria-label={`发布版本 ${project.name}`} onChange={(event) => setRevisions({ ...revisions, [project.id]: event.target.value })} placeholder="Git revision" readOnly={compose} value={revision} /></td><td><button aria-label={`发布 ${project.name}`} disabled={!revision} onClick={() => void deploy(project)} type="button">{compose ? '应用 Compose' : '发布'}</button></td></tr>; })}</tbody></table></div></section>
    {approval ? <RiskDecisionDialog environment={connected?.server.environment ?? 'other'} request={approval} onApprove={(proof) => void approve(proof)} onReject={() => void reject()} /> : null}
  </div>;
}
