import { useEffect, useState } from 'react';
import type { ApprovalProof, ApprovalRequest, ProjectDetection, ProjectSummary } from '@opspilot/contracts';

import type { CoreClient } from '../../api/core';
import { RiskDecisionDialog } from '../../app/risk-decision-dialog';
import { DetailPane, PageHeader, Panel, SectionHeader } from '../../app/ui/layout';
import { Select } from '../../app/ui/select';
import type { ConnectedServer } from '../terminal/terminal-page';

export function ProjectsPage({ connections, core }: { connections: ConnectedServer[]; core: CoreClient }) {
  const [serverId, setServerId] = useState(connections[0]?.server.id ?? '');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const [name, setName] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [detection, setDetection] = useState<ProjectDetection>();
  const [revisions, setRevisions] = useState<Record<string, string>>({});
  const [approval, setApproval] = useState<ApprovalRequest>();
  const [message, setMessage] = useState('');
  const connected = connections.find((item) => item.server.id === serverId);
  const selectedProject = projects.find((project) => project.id === selectedProjectId);

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
      setSelectedProjectId(project.id);
      if (project.deployStrategy === 'docker_compose') setRevisions((items) => ({ ...items, [project.id]: 'compose' }));
      setMessage('项目已创建');
    } catch { setMessage('项目创建失败'); }
  };
  const deploy = async (project: ProjectSummary) => {
    const revision = project.deployStrategy === 'docker_compose' ? 'compose' : revisions[project.id];
    if (!connected || !core.prepareOperation || !revision) return;
    setSelectedProjectId(project.id);
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

  return <div className="page-stack projects-page">
    <PageHeader actions={<Select aria-label="项目服务器" onChange={(value) => setServerId(value)} options={[{ value: '', label: '选择服务器' }, ...connections.map(({ server }) => ({ value: server.id, label: server.name }))]} value={serverId} />} description="检测运行时、持久化项目，并通过可审查计划执行发布。" eyebrow="Deployments" title="项目与发布" />
    <Panel className="project-form"><label>项目根目录<input aria-label="项目根目录" onChange={(event) => setRootPath(event.target.value)} placeholder="/srv/app" value={rootPath} /></label><button onClick={() => void detect()} type="button">检测项目</button><label>项目名称<input aria-label="项目名称" onChange={(event) => setName(event.target.value)} value={name} /></label><label>Git 仓库（Compose 可留空）<input aria-label="Git 仓库" onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="https://example.com/team/app.git" value={repositoryUrl} /></label><button className="primary" disabled={!detection || !name || (detection.primary !== 'docker_compose' && !repositoryUrl)} onClick={() => void create()} type="button">创建项目</button>{detection ? <span className="status-badge"><i />{detection.primary} · {Math.round(detection.confidence * 100)}%</span> : null}</Panel>
    {message ? <div className="alert success-alert" role="status">{message}</div> : null}
    <div className={selectedProject ? 'projects-workspace has-detail' : 'projects-workspace'}>
      <div className="projects-main">
        <Panel className="project-list-panel"><SectionHeader count={projects.length} title="项目列表" /><div className="table-wrap"><table aria-label="项目列表"><thead><tr><th>项目</th><th>根目录</th><th>运行时</th><th>策略</th><th>发布版本</th><th>操作</th></tr></thead><tbody>{projects.length === 0 ? <tr><td className="empty-cell" colSpan={6}>暂无项目</td></tr> : projects.map((project) => { const compose = project.deployStrategy === 'docker_compose'; const revision = compose ? 'compose' : revisions[project.id] ?? ''; return <tr className={project.id === selectedProjectId ? 'selected-row' : undefined} key={project.id}><td><button aria-label={`查看 ${project.name} 详情`} className="server-name-button" onClick={() => setSelectedProjectId(project.id)} type="button"><strong>{project.name}</strong></button></td><td>{project.rootPath}</td><td>{project.runtime}</td><td>{project.deployStrategy}</td><td><input aria-label={`发布版本 ${project.name}`} onChange={(event) => setRevisions({ ...revisions, [project.id]: event.target.value })} placeholder="Git revision" readOnly={compose} value={revision} /></td><td><button aria-label={`发布 ${project.name}`} disabled={!revision} onClick={() => void deploy(project)} type="button">{compose ? '应用 Compose' : '发布'}</button></td></tr>; })}</tbody></table></div></Panel>
        <Panel><SectionHeader description="只反映当前准备或提交的真实任务" title="部署流水线" />{approval || message === '发布任务已提交' ? <ol className="deployment-pipeline"><li className="done">读取项目</li><li className="done">生成计划</li><li className={approval ? 'active' : 'done'}>{approval ? '等待审批' : '审批完成'}</li><li className={message === '发布任务已提交' ? 'active' : ''}>任务提交</li><li>健康检查</li></ol> : <div className="conversation-empty">尚未创建部署任务</div>}</Panel>
      </div>
      {selectedProject ? <DetailPane onClose={() => setSelectedProjectId(undefined)} subtitle={connected?.server.name ?? '服务器不可用'} title={selectedProject.name}><div className="detail-status-line"><span className="status-badge"><i />{selectedProject.runtime}</span></div><dl className="detail-list"><div><dt>根目录</dt><dd>{selectedProject.rootPath}</dd></div><div><dt>部署策略</dt><dd>{selectedProject.deployStrategy}</dd></div><div><dt>仓库</dt><dd>{selectedProject.repositoryUrl ?? '未配置'}</dd></div><div><dt>目标版本</dt><dd>{revisions[selectedProject.id] ?? '尚未填写'}</dd></div></dl></DetailPane> : null}
    </div>
    {approval ? <RiskDecisionDialog environment={connected?.server.environment ?? 'other'} request={approval} onApprove={(proof) => void approve(proof)} onReject={() => void reject()} /> : null}
  </div>;
}
