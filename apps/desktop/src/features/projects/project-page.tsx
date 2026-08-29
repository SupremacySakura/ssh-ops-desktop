import { useEffect, useState } from 'react';
import type { ApprovalProof, ApprovalRequest, ProjectDetection, ProjectSummary } from '@opspilot/contracts';

import type { CoreClient } from '../../api/core';
import { RiskDecisionDialog } from '../../app/risk-decision-dialog';
import { PageHeader } from '../../app/ui/layout';
import { Modal } from '../../app/ui/modal';
import { Select } from '../../app/ui/select';
import { Icon } from '../../app/icons';
import type { ConnectedServer } from '../terminal/terminal-page';

export function ProjectsPage({ connections, core }: { connections: ConnectedServer[]; core: CoreClient }) {
  const [serverId, setServerId] = useState(connections[0]?.server.id ?? '');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [name, setName] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [detection, setDetection] = useState<ProjectDetection>();
  const [formOpen, setFormOpen] = useState(false);
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
      setFormOpen(false);
      setDetection(undefined);
      setName(''); setRootPath(''); setRepositoryUrl('');
      setMessage('项目已创建');
    } catch { setMessage('项目创建失败'); }
  };

  const deploy = async (project: ProjectSummary) => {
    if (!connected || !core.prepareOperation) return;
    try {
      const result = await core.prepareOperation({
        toolCallId: crypto.randomUUID(), runId: crypto.randomUUID(), serverId: project.serverId,
        name: 'deploy.run', schemaVersion: 1,
        args: { connection: connected.connection, projectId: project.id, revision: 'latest', healthUrl: null },
      });
      if (result.kind === 'awaiting_approval') setApproval(result);
      else if (result.kind === 'blocked') setMessage(`发布被阻断：${result.risk.reason}`);
      else setMessage('发布任务已提交');
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

  return (
    <div className="page-stack projects-page">
      <PageHeader
        actions={
          <>
            <Select aria-label="项目服务器" onChange={(value) => setServerId(value)} options={[{ value: '', label: '选择服务器' }, ...connections.map(({ server }) => ({ value: server.id, label: server.name }))]} value={serverId} />
            <button className="btn btn-secondary" type="button"><Icon name="download" size={15} />导入仓库</button>
            <button className="btn btn-primary" onClick={() => setFormOpen(true)} type="button"><Icon name="plus" size={15} />新建项目</button>
          </>
        }
        description="管理代码仓库与部署配置"
        title="项目"
      />

      {message ? <div className="alert success-alert" role="status">{message}</div> : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 16 }}>
        {projects.length === 0
          ? <div className="conversation-empty">暂无项目，先新建或从服务器检测。</div>
          : projects.map((project) => (
            <div className="card" key={project.id}>
              <div className="card-body">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                  <div className="list-item-icon"><Icon name="project" size={18} /></div>
                  <div>
                    <div style={{ fontWeight: 600 }}>{project.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--label-secondary)' }}>{project.runtime} · {project.deployStrategy}</div>
                  </div>
                </div>
                <div style={{ fontSize: 13, color: 'var(--label-secondary)', marginBottom: 16 }}>{project.rootPath}</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span className="status-tag neutral">{project.deployStrategy === 'docker_compose' ? 'Docker' : 'Release'}</span>
                  {project.repositoryUrl ? <span className="status-tag neutral">Git</span> : null}
                </div>
              </div>
              <div className="card-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--label-secondary)' }}>{project.repositoryUrl ?? '未配置仓库'}</span>
                <button className="btn btn-ghost" onClick={() => void deploy(project)} style={{ height: 28, padding: '0 10px', fontSize: 12 }} type="button">部署</button>
              </div>
            </div>
          ))}
      </div>

      {formOpen ? <Modal onClose={() => setFormOpen(false)} open>
        <section aria-label="新建项目" aria-modal="true" className="risk-dialog" role="dialog">
          <h2>新建项目</h2>
          <label>项目根目录<input aria-label="项目根目录" onChange={(event) => setRootPath(event.target.value)} placeholder="/srv/app" value={rootPath} /></label>
          <button className="btn btn-secondary" disabled={!rootPath} onClick={() => void detect()} type="button">检测项目</button>
          <label>项目名称<input aria-label="项目名称" onChange={(event) => setName(event.target.value)} value={name} /></label>
          <label>Git 仓库（可留空）<input aria-label="Git 仓库" onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="https://example.com/team/app.git" value={repositoryUrl} /></label>
          {detection ? <span className="status-badge"><i />{detection.primary} · {Math.round(detection.confidence * 100)}%</span> : null}
          <footer>
            <button className="btn btn-secondary" onClick={() => setFormOpen(false)} type="button">取消</button>
            <button className="btn btn-primary" disabled={!detection || !name} onClick={() => void create()} type="button">创建项目</button>
          </footer>
        </section>
      </Modal> : null}
      {approval ? <RiskDecisionDialog environment={connected?.server.environment ?? 'other'} request={approval} onApprove={(proof) => void approve(proof)} onReject={() => void reject()} /> : null}
    </div>
  );
}
