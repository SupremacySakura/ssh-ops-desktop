import { useEffect, useMemo, useState } from 'react';
import type {
  ConnectOutcome,
  ConnectionAuth,
  ConnectionHandle,
  ServerGroup,
  ServerImportFormat,
  ServerImportPreview,
  ServerInput,
  ServerSummary,
} from '@opspilot/contracts';

import type { CoreClient } from '../../api/core';
import { Modal } from '../../app/ui/modal';
import { Select } from '../../app/ui/select';
import type { ConnectedServer } from '../terminal/terminal-page';

interface ServerListPageProps {
  connections?: ConnectedServer[];
  core: CoreClient;
  onConnected?(server: ServerSummary, connection: ConnectionHandle): void;
  onCreated(server: ServerSummary): void;
  onDeleted?(serverId: string): void;
  onUpdated?(server: ServerSummary): void;
  servers: ServerSummary[];
}

const INITIAL_FORM: ServerInput = {
  name: '', host: '', port: 22, username: '', environment: 'production', authType: 'password', tagIds: [],
};

const ENVIRONMENT_TONE: Record<ServerSummary['environment'], string> = {
  production: 'neutral',
  staging: 'warning',
  development: 'neutral',
  other: 'neutral',
};

const AUTH_LABEL: Record<ServerSummary['authType'], string> = {
  password: '密码',
  private_key: '密钥',
  ssh_agent: 'SSH Agent',
  certificate: '证书',
};

export function ServerListPage({
  connections = [], core, onConnected, onCreated, onDeleted, onUpdated, servers,
}: ServerListPageProps) {
  const [query, setQuery] = useState('');
  const [environmentFilter, setEnvironmentFilter] = useState('all');
  const [groupFilter, setGroupFilter] = useState('all');
  const [authFilter, setAuthFilter] = useState('all');
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [form, setForm] = useState<ServerInput>(INITIAL_FORM);
  const [credential, setCredential] = useState('');
  const [groups, setGroups] = useState<ServerGroup[]>([]);
  const [groupName, setGroupName] = useState('');
  const [message, setMessage] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ServerSummary>();
  const [hostKey, setHostKey] = useState<{ server: ServerSummary; outcome: ConnectOutcome }>();
  const [keyPathServer, setKeyPathServer] = useState<ServerSummary>();
  const [privateKeyPath, setPrivateKeyPath] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importFormat, setImportFormat] = useState<ServerImportFormat>('csv');
  const [importSource, setImportSource] = useState('');
  const [importPreview, setImportPreview] = useState<ServerImportPreview>();
  const [selectedRows, setSelectedRows] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    void (core.serverGroups?.() ?? Promise.resolve([]))
      .then((items) => { if (active) setGroups(items); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [core]);

  const connectedServerIds = useMemo(
    () => new Set(connections.map((item) => item.server.id)),
    [connections],
  );

  const rows = useMemo(() => servers.filter((server) => {
    const matchesQuery = `${server.name} ${server.host} ${server.username}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());
    const matchesEnvironment = environmentFilter === 'all' || server.environment === environmentFilter;
    const matchesGroup = groupFilter === 'all' || (groupFilter === 'ungrouped' ? !server.groupId : server.groupId === groupFilter);
    const matchesAuth = authFilter === 'all' || server.authType === authFilter;
    return matchesQuery && matchesEnvironment && matchesGroup && matchesAuth;
  }), [authFilter, environmentFilter, groupFilter, query, servers]);

  const connectionStateOf = (server: ServerSummary): 'connected' | 'previously' | 'never' =>
    connectedServerIds.has(server.id) ? 'connected' : server.lastConnectedAt ? 'previously' : 'never';

  const openCreate = () => {
    setEditingId(undefined);
    setForm(INITIAL_FORM);
    setCredential('');
    setFormOpen(true);
  };

  const openEdit = (server: ServerSummary) => {
    setEditingId(server.id);
    setForm({
      name: server.name,
      host: server.host,
      port: server.port,
      username: server.username,
      environment: server.environment,
      authType: server.authType,
      ...(server.groupId ? { groupId: server.groupId } : {}),
      tagIds: server.tagIds,
    });
    setCredential('');
    setFormOpen(true);
  };

  const save = async () => {
    setMessage('');
    const original = editingId ? servers.find((server) => server.id === editingId) : undefined;
    const needsNewCredential = form.authType !== 'ssh_agent'
      && (!original || original.authType !== form.authType);
    if (needsNewCredential && !credential) {
      setMessage('新认证方式必须同时提供凭据');
      return;
    }
    try {
      const saved = editingId
        ? await core.updateServer?.(editingId, form)
        : await core.createServer?.(form);
      if (!saved) throw new Error('server mutation is unavailable');
      if (form.authType !== 'ssh_agent' && credential) {
        if (!core.setServerCredential) throw new Error('credential store is unavailable');
        await core.setServerCredential({ serverId: saved.id, secret: credential });
      }
      setCredential('');
      if (editingId) onUpdated?.(saved);
      else onCreated(saved);
      setFormOpen(false);
      setMessage(editingId ? '服务器配置已更新' : '服务器与凭据已保存');
    } catch {
      setMessage('保存失败，请检查字段、冲突和系统凭据库');
    }
  };

  const createGroup = async () => {
    if (!groupName.trim() || !core.createServerGroup) return;
    try {
      const group = await core.createServerGroup({ name: groupName, sortOrder: groups.length });
      setGroups((items) => [...items, group]);
      setGroupName('');
      setForm({ ...form, groupId: group.id });
    } catch {
      setMessage('分组创建失败，名称可能已存在');
    }
  };

  const remove = async () => {
    if (!deleteTarget || !core.deleteServer) return;
    try {
      await core.deleteServer({ serverId: deleteTarget.id, confirmed: true });
      onDeleted?.(deleteTarget.id);
      setMessage('服务器及其凭据引用已删除');
      setDeleteTarget(undefined);
    } catch {
      setMessage('删除失败；凭据库不可用时 Core 会保留记录供重试');
    }
  };

  const previewImport = async () => {
    if (!core.previewServerImport || !importSource.trim()) return;
    try {
      const preview = await core.previewServerImport({ format: importFormat, source: importSource });
      setImportPreview(preview);
      setSelectedRows(preview.rows.filter((row) => row.status === 'valid').map((row) => row.rowId));
      setMessage('导入预检完成；只会应用勾选的有效行');
    } catch {
      setMessage('导入预检失败，请检查格式和 10,000 行限制');
    }
  };

  const applyImport = async () => {
    if (!core.applyServerImport || !importPreview || selectedRows.length === 0) return;
    try {
      const result = await core.applyServerImport({
        importId: importPreview.importId,
        rowIds: selectedRows,
      });
      result.servers.forEach((server) => onCreated(server));
      setImportOpen(false);
      setImportPreview(undefined);
      setImportSource('');
      setMessage(`已导入 ${result.servers.length} 台服务器`);
    } catch {
      setMessage('导入预览已过期、被使用或数据发生冲突，请重新预检');
    }
  };

  const connectWith = async (server: ServerSummary, auth: ConnectionAuth) => {
    if (!core.connect) {
      setMessage('当前 Core 不支持 SSH 连接');
      return;
    }
    setMessage(`正在连接 ${server.name}…`);
    try {
      const outcome = await core.connect({ serverId: server.id, auth });
      if (outcome.kind === 'ready') {
        onConnected?.(server, outcome.connection);
        setMessage(`${server.name} 已建立可信连接`);
        setHostKey(undefined);
      } else {
        setMessage('');
        setHostKey({ server, outcome });
      }
    } catch {
      setMessage(`${server.name} 连接失败，请检查认证与网络`);
    }
  };

  const connect = (server: ServerSummary) => {
    if (server.authType === 'password') {
      void connectWith(server, { kind: 'password' });
      return;
    }
    if (server.authType === 'ssh_agent') {
      void connectWith(server, { kind: 'ssh_agent' });
      return;
    }
    setPrivateKeyPath('');
    setKeyPathServer(server);
  };

  const trust = async () => {
    if (!hostKey || hostKey.outcome.kind !== 'host_key_required' || !core.trustHostKey) return;
    try {
      await core.trustHostKey(hostKey.server.id, hostKey.outcome.prompt.verificationId);
      setHostKey(undefined);
      setMessage('主机指纹已信任；请重新连接完成认证');
    } catch {
      setMessage('指纹确认已过期，请重新连接获取最新指纹');
    }
  };

  return (
    <div className="page-stack server-catalog-page">
      <div className="page-header">
        <div>
          <h1>服务器</h1>
          <p>管理 SSH 主机、分组与连接状态</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={() => setImportOpen(true)} type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
            <span>导入</span>
          </button>
          <button className="btn btn-primary" onClick={openCreate} type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
            <span>添加服务器</span>
          </button>
        </div>
      </div>

      {message ? <div className="alert success-alert" role="status">{message}</div> : null}

      <div className="card mb-2">
        <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div className="search-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            <input
              aria-label="搜索服务器"
              className="input"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索名称、IP、用户名..."
              type="text"
              value={query}
            />
          </div>
          <div style={{ width: 140 }}>
            <Select
              aria-label="环境筛选"
              onChange={(value) => setEnvironmentFilter(value)}
              options={[
                { value: 'all', label: '所有环境' },
                { value: 'production', label: 'production' },
                { value: 'staging', label: 'staging' },
                { value: 'development', label: 'development' },
              ]}
              value={environmentFilter}
            />
          </div>
          <div style={{ width: 140 }}>
            <Select
              aria-label="分组筛选"
              onChange={(value) => setGroupFilter(value)}
              options={[
                { value: 'all', label: '所有分组' },
                { value: 'ungrouped', label: '未分组' },
                ...groups.map((group) => ({ value: group.id, label: group.name })),
              ]}
              value={groupFilter}
            />
          </div>
          <div style={{ width: 140 }}>
            <Select
              aria-label="认证筛选"
              onChange={(value) => setAuthFilter(value)}
              options={[
                { value: 'all', label: '认证方式' },
                { value: 'password', label: '密码' },
                { value: 'private_key', label: '密钥' },
                { value: 'ssh_agent', label: 'SSH Agent' },
                { value: 'certificate', label: '证书' },
              ]}
              value={authFilter}
            />
          </div>
          <button className="btn btn-secondary" onClick={() => { setQuery(''); setEnvironmentFilter('all'); setGroupFilter('all'); setAuthFilter('all'); }} style={{ marginLeft: 'auto' }} type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></svg>
            <span>筛选</span>
          </button>
        </div>
      </div>

      <div className="card">
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}><input type="checkbox" /></th>
                <th>服务器</th>
                <th>环境</th>
                <th>认证</th>
                <th>状态</th>
                <th>最近连接</th>
                <th style={{ width: 120 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0
                ? <tr><td className="empty-cell" colSpan={7}>没有匹配的服务器</td></tr>
                : rows.map((server) => {
                  const state = connectionStateOf(server);
                  const stateTone = state === 'connected' ? 'success' : state === 'previously' ? 'warning' : 'neutral';
                  const stateLabel = state === 'connected' ? '已连接' : state === 'previously' ? '未连接' : '离线';
                  return (
                    <tr key={server.id}>
                      <td><input type="checkbox" /></td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div className="list-item-icon" style={{ width: 32, height: 32 }}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" /><path d="M6 6h.01M6 18h.01" /></svg>
                          </div>
                          <div>
                            <div style={{ fontWeight: 600 }}>{server.name}</div>
                            <div style={{ fontSize: 12, color: 'var(--label-secondary)' }}>{server.host}:{server.port} · {server.username}</div>
                          </div>
                        </div>
                      </td>
                      <td><span className={`status-tag ${ENVIRONMENT_TONE[server.environment]}`}>{server.environment}</span></td>
                      <td>{AUTH_LABEL[server.authType]}</td>
                      <td><span className={`status-tag ${stateTone}`}>{stateLabel}</span></td>
                      <td>{server.lastConnectedAt ?? '尚未连接'}</td>
                      <td>
                        <button aria-label={`连接 ${server.name}`} className="btn btn-icon" onClick={() => connect(server)} type="button">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5" /></svg>
                        </button>
                        <button aria-label={`编辑 ${server.name}`} className="btn btn-icon" onClick={() => openEdit(server)} type="button">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                        </button>
                        <button aria-label={`删除 ${server.name}`} className="btn btn-icon" onClick={() => setDeleteTarget(server)} type="button">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
                        </button>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        <div className="card-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: 'var(--label-secondary)' }}>显示 1-{rows.length} 共 {servers.length} 台</span>
          <div className="tabs">
            <button className="tab" type="button">上一页</button>
            <button className="tab active" type="button">1</button>
            <button className="tab" type="button">下一页</button>
          </div>
        </div>
      </div>

      {formOpen ? <Modal onClose={() => setFormOpen(false)} open>
        <section aria-label="服务器表单" aria-modal="true" className="server-form-dialog" role="dialog">
          <header>
            <h2>{editingId ? '编辑服务器' : '新增服务器'}</h2>
            <button className="btn btn-icon" onClick={() => setFormOpen(false)} type="button">关闭</button>
          </header>
          <div className="form-grid">
            <label>服务器名称<input aria-label="服务器名称" onChange={(event) => setForm({ ...form, name: event.target.value })} value={form.name} /></label>
            <label>主机地址<input aria-label="主机地址" onChange={(event) => setForm({ ...form, host: event.target.value })} value={form.host} /></label>
            <label>端口<input aria-label="端口" max={65535} min={1} onChange={(event) => setForm({ ...form, port: Number(event.target.value) })} type="number" value={form.port} /></label>
            <label>用户名<input aria-label="用户名" onChange={(event) => setForm({ ...form, username: event.target.value })} value={form.username} /></label>
            <label>环境<Select aria-label="服务器环境" onChange={(value) => setForm({ ...form, environment: value as ServerInput['environment'] })} options={[{ value: 'production', label: '生产环境' }, { value: 'staging', label: '预发布' }, { value: 'development', label: '开发环境' }, { value: 'other', label: '其他' }]} value={form.environment} /></label>
            <label>认证方式<Select aria-label="认证方式" onChange={(value) => { setCredential(''); setForm({ ...form, authType: value as ServerInput['authType'] }); }} options={[{ value: 'password', label: '密码' }, { value: 'private_key', label: '私钥' }, { value: 'ssh_agent', label: 'SSH Agent' }, { value: 'certificate', label: '证书' }]} value={form.authType} /></label>
            <label>分组<Select aria-label="服务器分组" onChange={(value) => setForm({ ...form, groupId: value || undefined })} options={[{ value: '', label: '未分组' }, ...groups.map((group) => ({ value: group.id, label: group.name }))]} value={form.groupId ?? ''} /></label>
            {form.authType !== 'ssh_agent' ? <label>{form.authType === 'password' ? '密码' : '私钥/证书口令'}<input aria-label={form.authType === 'password' ? '密码' : '私钥或证书口令'} autoComplete="new-password" onChange={(event) => setCredential(event.target.value)} placeholder={editingId ? '留空则保留现有凭据' : ''} type="password" value={credential} /></label> : null}
          </div>
          <footer>
            <input aria-label="新分组名称" onChange={(event) => setGroupName(event.target.value)} placeholder="新分组名称" value={groupName} />
            <button className="btn btn-secondary" disabled={!groupName.trim()} onClick={() => void createGroup()} type="button">创建分组</button>
            <button className="btn btn-primary" onClick={() => void save()} type="button">{editingId ? '保存修改' : '保存服务器'}</button>
          </footer>
        </section>
      </Modal> : null}
      {importOpen ? <Modal onClose={() => setImportOpen(false)} open>
        <section aria-label="批量导入服务器" aria-modal="true" className="risk-dialog" role="dialog">
          <h2>批量导入服务器</h2>
          <label>格式<Select aria-label="导入格式" onChange={(value) => setImportFormat(value as ServerImportFormat)} options={[{ value: 'csv', label: 'CSV' }, { value: 'json', label: 'JSON' }]} value={importFormat} /></label>
          <textarea aria-label="导入内容" onChange={(event) => setImportSource(event.target.value)} placeholder="name,host,port,username,environment,authType" value={importSource} />
          {importPreview ? <ul className="file-list">{importPreview.rows.map((row) => <li key={row.rowId}><label><input checked={selectedRows.includes(row.rowId)} disabled={row.status !== 'valid'} onChange={(event) => setSelectedRows((current) => event.target.checked ? [...current, row.rowId] : current.filter((id) => id !== row.rowId))} type="checkbox" />{row.status === 'error' ? row.error : `${row.server.name} · ${row.status}`}</label></li>)}</ul> : null}
          <footer>
            <button className="btn btn-secondary" onClick={() => setImportOpen(false)} type="button">取消</button>
            <button className="btn btn-secondary" disabled={!importSource.trim()} onClick={() => void previewImport()} type="button">预检</button>
            <button className="btn btn-primary" disabled={!importPreview || selectedRows.length === 0} onClick={() => void applyImport()} type="button">应用有效行</button>
          </footer>
        </section>
      </Modal> : null}
      {deleteTarget ? <Modal onClose={() => setDeleteTarget(undefined)} open>
        <section aria-label="确认删除服务器" aria-modal="true" className="risk-dialog" role="alertdialog">
          <h2>删除服务器</h2>
          <p>将删除 {deleteTarget.name}、关联元数据和系统凭据。该操作不可撤销。</p>
          <footer>
            <button className="btn btn-secondary" onClick={() => setDeleteTarget(undefined)} type="button">取消</button>
            <button className="btn btn-primary danger" onClick={() => void remove()} type="button">确认删除</button>
          </footer>
        </section>
      </Modal> : null}
      {keyPathServer ? <Modal onClose={() => setKeyPathServer(undefined)} open>
        <section aria-label="连接参数" aria-modal="true" className="risk-dialog" role="dialog">
          <h2>选择本地私钥</h2>
          <p>路径只交给 Rust SSH Core，不会写入日志。</p>
          <label className="confirmation-field">私钥路径<input aria-label="私钥路径" onChange={(event) => setPrivateKeyPath(event.target.value)} value={privateKeyPath} /></label>
          <footer>
            <button className="btn btn-secondary" onClick={() => setKeyPathServer(undefined)} type="button">取消</button>
            <button className="btn btn-primary" disabled={!privateKeyPath} onClick={() => { const server = keyPathServer; setKeyPathServer(undefined); void connectWith(server, server.authType === 'certificate' ? { kind: 'certificate', certificatePath: `${privateKeyPath}-cert.pub`, privateKeyPath, expectedPrincipal: server.username } : { kind: 'private_key', privateKeyPath }); }} type="button">连接</button>
          </footer>
        </section>
      </Modal> : null}
      {hostKey?.outcome.kind === 'host_key_required' ? <Modal onClose={() => setHostKey(undefined)} open>
        <section aria-label="确认主机指纹" aria-modal="true" className="risk-dialog" role="alertdialog">
          <h2>首次连接：确认主机指纹</h2>
          <p>{hostKey.server.host}:{hostKey.server.port} · {hostKey.outcome.prompt.algorithm}</p>
          <code>{hostKey.outcome.prompt.sha256}</code>
          <footer>
            <button className="btn btn-secondary" onClick={() => setHostKey(undefined)} type="button">关闭</button>
            <button className="btn btn-primary" onClick={() => void trust()} type="button">信任此指纹</button>
          </footer>
        </section>
      </Modal> : null}
      {hostKey?.outcome.kind === 'host_key_changed' ? <Modal onClose={() => setHostKey(undefined)} open>
        <section aria-label="主机指纹已变化" aria-modal="true" className="risk-dialog" role="alertdialog">
          <h2>主机指纹已变化</h2>
          <p>连接已由 Core 阻断。请通过可信渠道人工核验，不能直接继续。</p>
          <dl className="risk-details"><div><dt>原指纹</dt><dd>{hostKey.outcome.expectedSha256}</dd></div><div><dt>新指纹</dt><dd>{hostKey.outcome.actualSha256}</dd></div></dl>
          <footer>
            <button className="btn btn-secondary" onClick={() => setHostKey(undefined)} type="button">关闭</button>
          </footer>
        </section>
      </Modal> : null}
    </div>
  );
}
