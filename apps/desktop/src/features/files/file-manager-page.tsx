import { useEffect, useState } from 'react';
import type { ApprovalProof, ApprovalRequest, RemoteFileContent, RemoteFileEntry } from '@opspilot/contracts';

import type { CoreClient } from '../../api/core';
import { Modal } from '../../app/ui/modal';
import { RiskDecisionDialog } from '../../app/risk-decision-dialog';
import type { ConnectedServer } from '../terminal/terminal-page';

export function FileManagerPage({ connections, core }: {
  connections: ConnectedServer[];
  core: CoreClient;
}) {
  const [serverId, setServerId] = useState(connections[0]?.server.id ?? '');
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
  const [content, setContent] = useState<RemoteFileContent>();
  const [draft, setDraft] = useState('');
  const [approval, setApproval] = useState<ApprovalRequest>();
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!serverId && connections[0]) setServerId(connections[0].server.id);
  }, [connections, serverId]);

  const connected = connections.find((item) => item.server.id === serverId);
  const baseline = content
    ? new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(content.bytes))
    : '';

  useEffect(() => { void browse('/'); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [connected?.server.id]);

  const browse = async (nextPath: string) => {
    if (!connected || !core.listFiles) {
      setMessage('请先建立可信 SSH 连接');
      return;
    }
    setMessage('正在读取远程目录…');
    try {
      setEntries(await core.listFiles({ connection: connected.connection, path: nextPath }));
      setPath(nextPath);
      setContent(undefined);
      setDraft('');
      setMessage('');
    } catch {
      setMessage('目录读取失败或当前服务器不支持 SFTP');
    }
  };

  const open = async (entry: RemoteFileEntry) => {
    if (entry.kind === 'directory') {
      await browse(entry.path);
      return;
    }
    if (entry.kind !== 'file' || !connected || !core.readFile) return;
    setMessage('正在读取文件…');
    try {
      const next = await core.readFile({ connection: connected.connection, path: entry.path });
      setContent(next);
      setDraft(new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(next.bytes)));
      setMessage('');
    } catch {
      setMessage('文件无法预览；编辑仅支持不超过 1 MiB 的普通文件');
    }
  };

  const prepareWrite = async (targetPath: string, bytes: number[], expectedSha256?: string) => {
    if (!connected || !core.prepareOperation) {
      setMessage('写入网关不可用');
      return;
    }
    try {
      const result = await core.prepareOperation({
        toolCallId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        serverId: connected.server.id,
        name: 'file.write',
        schemaVersion: 1,
        args: {
          connection: connected.connection,
          path: targetPath,
          bytes,
          ...(expectedSha256 ? { expectedSha256 } : {}),
        },
      });
      if (result.kind === 'awaiting_approval') setApproval(result);
      else if (result.kind === 'blocked') setMessage(`操作被阻断：${result.risk.reason}`);
    } catch {
      setMessage('远程文件已变化、目标已存在或写入计划无效');
    }
  };

  const save = async () => {
    if (!content || draft === baseline) return;
    await prepareWrite(content.path, [...new TextEncoder().encode(draft)], content.sha256);
  };

  const upload = async (file: File) => {
    if (!file) return;
    const target = joinRemotePath(path, file.name);
    await prepareWrite(target, await readFileBytes(file));
  };

  const approve = async (proof: ApprovalProof) => {
    try { await core.approveOperation?.(proof); setApproval(undefined); setMessage('写入任务已提交'); }
    catch { setMessage('审批已失效或任务提交失败'); }
  };

  const reject = async () => {
    if (!approval) return;
    try { await core.rejectOperation?.(approval.approvalId); } finally { setApproval(undefined); setMessage('已拒绝，未执行写入'); }
  };

  const closeEditor = () => {
    setContent(undefined);
    setDraft('');
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>文件</h1>
          <p>浏览与编辑远程服务器文件</p>
        </div>
        <div className="page-actions">
          <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
            <span>上传文件</span>
            <input aria-label="上传本地文件" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ''; }} type="file" />
          </label>
        </div>
      </div>

      {message ? <div className="alert success-alert" role="status">{message}</div> : null}

      <div className="card file-browser-panel">
        <div className="ui-section-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h3 className="card-title">文件树 · {connected?.server.name ?? '未选择服务器'}</h3>
            <div className="card-subtitle" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path}</div>
          </div>
          <button className="btn btn-secondary" onClick={() => void browse(path)} type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
            <span>刷新</span>
          </button>
        </div>
        <div className="file-list">
          {path !== '/' ? (
            <button aria-label="返回上一级" onClick={() => void browse(parentPath(path))} type="button">
              <span className="file-kind-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5" /><polyline points="5 12 12 5 19 12" /></svg></span>
              <span>..</span>
              <small>上一级</small>
            </button>
          ) : null}
          {entries.length === 0 ? (
            <div style={{ padding: '24px 16px', fontSize: 13, color: 'var(--label-secondary)' }}>{connected ? '目录为空' : '暂无文件；先建立可信连接。'}</div>
          ) : entries.map((entry) => (
            <button key={entry.path} onClick={() => void open(entry)} type="button">
              <span className="file-kind-icon">
                {entry.kind === 'directory' ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><polyline points="14 2 14 8 20 8" /></svg>
                )}
              </span>
              <span>{entry.name}</span>
              {entry.kind === 'file' && entry.size !== undefined ? <small>{formatSize(entry.size)}</small> : null}
            </button>
          ))}
        </div>
      </div>

      <Modal onClose={closeEditor} open={!!content}>
        <section aria-label="编辑远程文件" aria-modal="true" className="file-editor-dialog" role="dialog">
          <header>
            <h2>{content?.path ?? ''}</h2>
            <button aria-label="关闭编辑器" className="btn btn-icon" onClick={closeEditor} title="关闭" type="button">×</button>
          </header>
          <div className="code-editor-host">
            <textarea
              aria-label="文件编辑内容"
              className="textarea code-editor"
              onChange={(event) => setDraft(event.target.value)}
              style={{ width: '100%', height: '100%', fontSize: 13, lineHeight: 1.6, fontFamily: '"SF Mono", Menlo, Monaco, Consolas, monospace', resize: 'vertical' }}
              value={draft}
            />
          </div>
          <footer>
            <button className="btn btn-secondary" disabled={!content || draft === baseline} onClick={() => setDraft(baseline)} type="button">撤销</button>
            <button className="btn btn-primary" disabled={!content || draft === baseline} onClick={() => void save()} type="button">保存</button>
          </footer>
        </section>
      </Modal>

      {approval ? <RiskDecisionDialog environment={connected?.server.environment ?? 'other'} request={approval} onApprove={(proof) => void approve(proof)} onReject={() => void reject()} /> : null}
    </>
  );
}

function joinRemotePath(directory: string, name: string): string {
  if (directory === '/' || directory === '') return `/${name}`;
  return `${directory.replace(/\/$/u, '')}/${name}`;
}

function parentPath(current: string): string {
  if (current === '/' || current === '') return '/';
  const trimmed = current.replace(/\/+$/u, '');
  const index = trimmed.lastIndexOf('/');
  return index <= 0 ? '/' : trimmed.slice(0, index);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function readFileBytes(file: File): Promise<number[]> {
  const buffer = await file.arrayBuffer();
  return [...new Uint8Array(buffer)];
}
