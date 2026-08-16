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
import { DetailPane, FilterBar, PageHeader } from '../../app/ui/layout';
import { Select } from '../../app/ui/select';
import { environmentLabel } from '../dashboard/dashboard-page';

interface ServerListPageProps {
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

export function ServerListPage({
  core, onConnected, onCreated, onDeleted, onUpdated, servers,
}: ServerListPageProps) {
  const [query, setQuery] = useState('');
  const [environmentFilter, setEnvironmentFilter] = useState('all');
  const [groupFilter, setGroupFilter] = useState('all');
  const [authFilter, setAuthFilter] = useState('all');
  const [selectedServerId, setSelectedServerId] = useState<string>();
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

  const filtered = useMemo(() => servers.filter((server) => {
    const matchesQuery = `${server.name} ${server.host} ${server.username}`.toLowerCase().includes(query.toLowerCase());
    const matchesEnvironment = environmentFilter === 'all' || server.environment === environmentFilter;
    const matchesGroup = groupFilter === 'all' || (groupFilter === 'ungrouped' ? !server.groupId : server.groupId === groupFilter);
    const matchesAuth = authFilter === 'all' || server.authType === authFilter;
    return matchesQuery && matchesEnvironment && matchesGroup && matchesAuth;
  }), [authFilter, environmentFilter, groupFilter, query, servers]);
  const selectedServer = filtered.find((server) => server.id === selectedServerId);

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

  return <div className="page-stack server-catalog-page">
    <PageHeader
      actions={<><button onClick={() => setImportOpen(true)} type="button">批量导入</button><button aria-label="新增服务器" className="primary" onClick={openCreate} type="button">＋ 新增服务器</button></>}
      description="连接配置、分组、环境边界和认证方式集中管理。"
      eyebrow="Server catalog"
      title="服务器管理"
    />
    {message ? <div className="alert success-alert" role="status">{message}</div> : null}
    {formOpen ? <section className="panel server-form" aria-label="服务器表单"><div className="panel-title"><h2>{editingId ? '编辑服务器' : '新增服务器'}</h2><button onClick={() => setFormOpen(false)} type="button">关闭</button></div><div className="form-grid"><label>服务器名称<input aria-label="服务器名称" onChange={(event) => setForm({ ...form, name: event.target.value })} value={form.name} /></label><label>主机地址<input aria-label="主机地址" onChange={(event) => setForm({ ...form, host: event.target.value })} value={form.host} /></label><label>端口<input aria-label="端口" max={65535} min={1} onChange={(event) => setForm({ ...form, port: Number(event.target.value) })} type="number" value={form.port} /></label><label>用户名<input aria-label="用户名" onChange={(event) => setForm({ ...form, username: event.target.value })} value={form.username} /></label><label>环境<Select aria-label="服务器环境" onChange={(value) => setForm({ ...form, environment: value as ServerInput['environment'] })} options={[{ value: 'production', label: '生产环境' }, { value: 'staging', label: '预发布' }, { value: 'development', label: '开发环境' }, { value: 'other', label: '其他' }]} value={form.environment} /></label><label>认证方式<Select aria-label="认证方式" onChange={(value) => { setCredential(''); setForm({ ...form, authType: value as ServerInput['authType'] }); }} options={[{ value: 'password', label: '密码' }, { value: 'private_key', label: '私钥' }, { value: 'ssh_agent', label: 'SSH Agent' }, { value: 'certificate', label: '证书' }]} value={form.authType} /></label><label>分组<Select aria-label="服务器分组" onChange={(value) => setForm({ ...form, groupId: value || undefined })} options={[{ value: '', label: '未分组' }, ...groups.map((group) => ({ value: group.id, label: group.name }))]} value={form.groupId ?? ''} /></label>{form.authType !== 'ssh_agent' ? <label>{form.authType === 'password' ? '密码' : '私钥/证书口令'}<input aria-label={form.authType === 'password' ? '密码' : '私钥或证书口令'} autoComplete="new-password" onChange={(event) => setCredential(event.target.value)} placeholder={editingId ? '留空则保留现有凭据' : ''} type="password" value={credential} /></label> : null}</div><div className="heading-actions"><input aria-label="新分组名称" onChange={(event) => setGroupName(event.target.value)} placeholder="新分组名称" value={groupName} /><button disabled={!groupName.trim()} onClick={() => void createGroup()} type="button">创建分组</button><button className="primary" onClick={() => void save()} type="button">{editingId ? '保存修改' : '保存服务器'}</button></div></section> : null}
    <FilterBar resultCount={filtered.length}>
      <input aria-label="搜索服务器" onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、地址或用户" value={query} />
      <Select aria-label="环境筛选" onChange={(value) => setEnvironmentFilter(value)} options={[{ value: 'all', label: '全部环境' }, { value: 'production', label: '生产环境' }, { value: 'staging', label: '预发布' }, { value: 'development', label: '开发环境' }, { value: 'other', label: '其他' }]} value={environmentFilter} />
      <Select aria-label="分组筛选" onChange={(value) => setGroupFilter(value)} options={[{ value: 'all', label: '全部分组' }, { value: 'ungrouped', label: '未分组' }, ...groups.map((group) => ({ value: group.id, label: group.name }))]} value={groupFilter} />
      <Select aria-label="认证筛选" onChange={(value) => setAuthFilter(value)} options={[{ value: 'all', label: '全部认证' }, { value: 'password', label: '密码' }, { value: 'private_key', label: '私钥' }, { value: 'ssh_agent', label: 'SSH Agent' }, { value: 'certificate', label: '证书' }]} value={authFilter} />
      <button onClick={() => { setQuery(''); setEnvironmentFilter('all'); setGroupFilter('all'); setAuthFilter('all'); }} type="button">重置</button>
    </FilterBar>
    <div className={selectedServer ? 'catalog-layout has-detail' : 'catalog-layout'}>
      <section className="panel catalog-table"><div className="table-wrap"><table aria-label="服务器列表"><thead><tr><th>名称 / 用途</th><th>地址</th><th>环境</th><th>分组</th><th>认证方式</th><th>操作</th></tr></thead><tbody>{filtered.length === 0 ? <tr><td className="empty-cell" colSpan={6}>没有匹配的服务器</td></tr> : filtered.map((server) => <tr className={selectedServerId === server.id ? 'selected-row' : undefined} key={server.id}><td><button aria-label={`查看 ${server.name} 详情`} className="server-name-button" onClick={() => setSelectedServerId(server.id)} type="button"><strong>{server.name}</strong><small>{server.username}</small></button></td><td>{server.host}:{server.port}</td><td><span className={`environment-badge ${server.environment}`}>{environmentLabel(server.environment)}</span></td><td>{groups.find((group) => group.id === server.groupId)?.name ?? '未分组'}</td><td>{server.authType.replaceAll('_', ' ')}</td><td><div className="row-actions"><button aria-label={`连接 ${server.name}`} className="link-button" onClick={() => connect(server)} type="button">连接</button><button aria-label={`编辑 ${server.name}`} onClick={() => openEdit(server)} type="button">编辑</button><button aria-label={`删除 ${server.name}`} onClick={() => setDeleteTarget(server)} type="button">删除</button></div></td></tr>)}</tbody></table></div></section>
      {selectedServer ? <DetailPane onClose={() => setSelectedServerId(undefined)} subtitle={`${selectedServer.host}:${selectedServer.port}`} title={selectedServer.name}>
        <div className="detail-status-line"><span className={`environment-badge ${selectedServer.environment}`}>{environmentLabel(selectedServer.environment)}</span><span className="status-badge"><i />{selectedServer.lastConnectedAt ? '曾连接' : '尚未连接'}</span></div>
        <dl className="detail-list"><div><dt>登录用户</dt><dd>{selectedServer.username}</dd></div><div><dt>认证方式</dt><dd>{selectedServer.authType.replaceAll('_', ' ')}</dd></div><div><dt>分组</dt><dd>{groups.find((group) => group.id === selectedServer.groupId)?.name ?? '未分组'}</dd></div><div><dt>最近连接</dt><dd>{selectedServer.lastConnectedAt ?? '尚无记录'}</dd></div></dl>
        <div className="detail-actions"><button aria-label={`从详情连接 ${selectedServer.name}`} className="primary" onClick={() => connect(selectedServer)} type="button">连接服务器</button><button aria-label={`从详情编辑 ${selectedServer.name}`} onClick={() => openEdit(selectedServer)} type="button">编辑配置</button><button aria-label={`从详情删除 ${selectedServer.name}`} className="danger" onClick={() => setDeleteTarget(selectedServer)} type="button">删除</button></div>
      </DetailPane> : null}
    </div>
    {importOpen ? <Modal onClose={() => setImportOpen(false)} open>
      <section aria-label="批量导入服务器" aria-modal="true" className="risk-dialog" role="dialog">
        <h2>批量导入服务器</h2>
        <label>格式<Select aria-label="导入格式" onChange={(value) => setImportFormat(value as ServerImportFormat)} options={[{ value: 'csv', label: 'CSV' }, { value: 'json', label: 'JSON' }]} value={importFormat} /></label>
        <textarea aria-label="导入内容" onChange={(event) => setImportSource(event.target.value)} placeholder="name,host,port,username,environment,authType" value={importSource} />
        {importPreview ? <ul className="file-list">{importPreview.rows.map((row) => <li key={row.rowId}><label><input checked={selectedRows.includes(row.rowId)} disabled={row.status !== 'valid'} onChange={(event) => setSelectedRows((current) => event.target.checked ? [...current, row.rowId] : current.filter((id) => id !== row.rowId))} type="checkbox" />{row.status === 'error' ? row.error : `${row.server.name} · ${row.status}`}</label></li>)}</ul> : null}
        <footer><button onClick={() => setImportOpen(false)} type="button">取消</button><button disabled={!importSource.trim()} onClick={() => void previewImport()} type="button">预检</button><button className="primary" disabled={!importPreview || selectedRows.length === 0} onClick={() => void applyImport()} type="button">应用有效行</button></footer>
      </section>
    </Modal> : null}
    {deleteTarget ? <Modal onClose={() => setDeleteTarget(undefined)} open>
      <section aria-label="确认删除服务器" aria-modal="true" className="risk-dialog" role="alertdialog">
        <h2>删除服务器</h2>
        <p>将删除 {deleteTarget.name}、关联元数据和系统凭据。该操作不可撤销。</p>
        <footer><button onClick={() => setDeleteTarget(undefined)} type="button">取消</button><button className="danger" onClick={() => void remove()} type="button">确认删除</button></footer>
      </section>
    </Modal> : null}
    {keyPathServer ? <Modal onClose={() => setKeyPathServer(undefined)} open>
      <section aria-label="连接参数" aria-modal="true" className="risk-dialog" role="dialog">
        <h2>选择本地私钥</h2>
        <p>路径只交给 Rust SSH Core，不会写入日志。</p>
        <label className="confirmation-field">私钥路径<input aria-label="私钥路径" onChange={(event) => setPrivateKeyPath(event.target.value)} value={privateKeyPath} /></label>
        <footer><button onClick={() => setKeyPathServer(undefined)} type="button">取消</button><button className="primary" disabled={!privateKeyPath} onClick={() => { const server = keyPathServer; setKeyPathServer(undefined); void connectWith(server, server.authType === 'certificate' ? { kind: 'certificate', certificatePath: `${privateKeyPath}-cert.pub`, privateKeyPath, expectedPrincipal: server.username } : { kind: 'private_key', privateKeyPath }); }} type="button">连接</button></footer>
      </section>
    </Modal> : null}
    {hostKey?.outcome.kind === 'host_key_required' ? <Modal onClose={() => setHostKey(undefined)} open>
      <section aria-label="确认主机指纹" aria-modal="true" className="risk-dialog" role="alertdialog">
        <h2>首次连接：确认主机指纹</h2>
        <p>{hostKey.server.host}:{hostKey.server.port} · {hostKey.outcome.prompt.algorithm}</p>
        <code>{hostKey.outcome.prompt.sha256}</code>
        <footer><button onClick={() => setHostKey(undefined)} type="button">关闭</button><button className="primary" onClick={() => void trust()} type="button">信任此指纹</button></footer>
      </section>
    </Modal> : null}
    {hostKey?.outcome.kind === 'host_key_changed' ? <Modal onClose={() => setHostKey(undefined)} open>
      <section aria-label="主机指纹已变化" aria-modal="true" className="risk-dialog" role="alertdialog">
        <h2>主机指纹已变化</h2>
        <p>连接已由 Core 阻断。请通过可信渠道人工核验，不能直接继续。</p>
        <dl className="risk-details"><div><dt>原指纹</dt><dd>{hostKey.outcome.expectedSha256}</dd></div><div><dt>新指纹</dt><dd>{hostKey.outcome.actualSha256}</dd></div></dl>
        <footer><button onClick={() => setHostKey(undefined)} type="button">关闭</button></footer>
      </section>
    </Modal> : null}
  </div>;
}
