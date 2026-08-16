import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react';
import type {
  ApprovalProof,
  ApprovalRequest,
  RemoteFileContent,
  RemoteFileEntry,
} from '@opspilot/contracts';

import type { CoreClient } from '../../api/core';
import { Icon } from '../../app/icons';
import { RiskDecisionDialog } from '../../app/risk-decision-dialog';
import { languageForPath } from '../../app/ui/code-language';
import { PageHeader, Panel, SectionHeader } from '../../app/ui/layout';
import { Modal } from '../../app/ui/modal';
import { Select } from '../../app/ui/select';
import type { ConnectedServer } from '../terminal/terminal-page';

// Monaco 体积大，仅在真正打开文件编辑器时加载。
const CodeEditor = lazy(async () => {
  const module = await import('../../app/ui/code-editor');
  return { default: module.CodeEditor };
});

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_FOLDER_UPLOAD_FILES = 128;
const MAX_FOLDER_UPLOAD_BYTES = 16 * 1024 * 1024;

interface FileContextMenuState {
  entry: RemoteFileEntry;
  x: number;
  y: number;
}

export function FileManagerPage({ connections, core }: {
  connections: ConnectedServer[];
  core: CoreClient;
}) {
  const [serverId, setServerId] = useState(connections[0]?.server.id ?? '');
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
  const [content, setContent] = useState<RemoteFileContent>();
  const [draft, setDraft] = useState('');
  const [upload, setUpload] = useState<File>();
  const [uploadFolder, setUploadFolder] = useState<File[]>();
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [renameTarget, setRenameTarget] = useState<RemoteFileEntry>();
  const [renameValue, setRenameValue] = useState('');
  const [contextMenu, setContextMenu] = useState<FileContextMenuState>();
  const [approval, setApproval] = useState<ApprovalRequest>();
  const [message, setMessage] = useState('');
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!serverId && connections[0]) setServerId(connections[0].server.id);
  }, [connections, serverId]);

  useEffect(() => {
    if (!contextMenu) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) setContextMenu(undefined);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(undefined);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);

  // 菜单以鼠标坐标定位，靠近视口边缘时向内钳制，避免溢出无法完整点选。
  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const menu = contextMenuRef.current;
    const rect = menu.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width - 8);
    const maxTop = Math.max(0, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.min(contextMenu.x, maxLeft)}px`;
    menu.style.top = `${Math.min(contextMenu.y, maxTop)}px`;
  }, [contextMenu]);

  const connected = connections.find((item) => item.server.id === serverId);
  const baseline = content
    ? new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(content.bytes))
    : '';

  const browse = async (nextPath = path) => {
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

  const closeEditor = () => {
    setContent(undefined);
    setDraft('');
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

  const prepareSave = async () => {
    if (!content || draft === baseline) return;
    await prepareWrite(content.path, [...new TextEncoder().encode(draft)], content.sha256);
  };

  const prepareUpload = async () => {
    if (!upload) return;
    if (upload.size > MAX_UPLOAD_BYTES || !safeFileName(upload.name)) {
      setMessage('上传文件必须不超过 4 MiB，且文件名不能包含路径或控制字符');
      return;
    }
    const target = joinRemotePath(path, upload.name);
    await prepareWrite(target, await readFileBytes(upload));
  };

  const confirmNewFile = async () => {
    if (!safeFileName(newFileName)) {
      setMessage('文件名不能为空，且不能包含路径或控制字符');
      return;
    }
    await prepareWrite(joinRemotePath(path, newFileName), []);
    setNewFileOpen(false);
    setNewFileName('');
  };

  const startRename = (entry: RemoteFileEntry) => {
    setRenameTarget(entry);
    setRenameValue(entry.name);
  };

  const confirmRename = async (entry: RemoteFileEntry) => {
    const nextName = renameValue;
    if (!safeFileName(nextName) || nextName === entry.name) {
      setMessage('新名称必须与原名不同，且不能包含路径或控制字符');
      return;
    }
    if (!connected || !core.prepareOperation) {
      setMessage('写入网关不可用');
      return;
    }
    try {
      const result = await core.prepareOperation({
        toolCallId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        serverId: connected.server.id,
        name: 'file.rename',
        schemaVersion: 1,
        args: {
          connection: connected.connection,
          path: entry.path,
          target: joinRemotePath(path, nextName),
        },
      });
      if (result.kind === 'awaiting_approval') setApproval(result);
      else if (result.kind === 'blocked') setMessage(`操作被阻断：${result.risk.reason}`);
    } catch {
      setMessage('重命名计划无效或目标已存在');
    }
    setRenameTarget(undefined);
    setRenameValue('');
  };

  const selectFolder = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = '';
    const totalBytes = selected.reduce((total, file) => total + file.size, 0);
    const validPaths = selected.every((file) => fileRelativePath(file).split('/').every(safeFileName));
    if (selected.length === 0
      || selected.length > MAX_FOLDER_UPLOAD_FILES
      || totalBytes > MAX_FOLDER_UPLOAD_BYTES
      || !validPaths) {
      setUploadFolder(undefined);
      setMessage('文件夹须包含 1–128 个文件、总大小不超过 16 MiB，且相对路径每段都是合法文件名');
      return;
    }
    setUploadFolder(selected);
  };

  const removeFolderFile = (index: number) => {
    if (!uploadFolder) return;
    const next = uploadFolder.filter((_, itemIndex) => itemIndex !== index);
    setUploadFolder(next.length > 0 ? next : undefined);
  };

  const prepareUploadFolder = async () => {
    if (!uploadFolder) return;
    if (!connected || !core.prepareOperation) {
      setMessage('写入网关不可用');
      return;
    }
    try {
      const files = await Promise.all(uploadFolder.map(async (file) => ({
        path: fileRelativePath(file),
        bytes: await readFileBytes(file),
      })));
      const result = await core.prepareOperation({
        toolCallId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        serverId: connected.server.id,
        name: 'file.upload_tree',
        schemaVersion: 1,
        args: {
          connection: connected.connection,
          rootPath: path,
          files,
        },
      });
      if (result.kind === 'awaiting_approval') setApproval(result);
      else if (result.kind === 'blocked') setMessage(`操作被阻断：${result.risk.reason}`);
    } catch {
      setMessage('读取本地文件夹失败或上传计划无效');
    }
  };

  const approve = async (proof: ApprovalProof) => {
    if (!core.approveOperation) return;
    try {
      await core.approveOperation(proof);
      setApproval(undefined);
      setUpload(undefined);
      setUploadFolder(undefined);
      await browse();
      setMessage('文件任务已成功执行；请刷新目录或重新打开文件确认远端结果');
    } catch {
      setMessage('审批已失效、文件发生冲突或远端写入失败');
    }
  };

  const reject = async () => {
    if (!approval) return;
    try {
      await core.rejectOperation?.(approval.approvalId);
    } finally {
      setApproval(undefined);
      setMessage('已拒绝，远程文件未变更');
    }
  };

  const downloadPath = async (targetPath: string) => {
    if (!connected || !core.downloadFile) return;
    try {
      const result = await core.downloadFile({
        connection: connected.connection,
        path: targetPath,
      });
      saveBrowserDownload(result.path.split('/').at(-1) ?? 'download', result.bytes);
      setMessage(`下载已准备，SHA-256 ${result.sha256}`);
    } catch {
      setMessage('下载失败；仅支持不超过 16 MiB 的普通文件');
    }
  };

  return <div className="page-stack files-page">
    <PageHeader actions={<span className="status-badge"><i />可信 SFTP</span>} description="SFTP 浏览、上传、下载与冲突校验由 Rust Core 执行；写入统一进入审批网关。" eyebrow="Secure file transfer" title="远程文件" />
    <Panel aria-label="文件操作" className="file-toolbar">
      <Select aria-label="文件服务器" onChange={setServerId} options={[{ value: '', label: '选择服务器' }, ...connections.map(({ server }) => ({ value: server.id, label: server.name }))]} value={serverId} />
      <input aria-label="远程目录" onChange={(event) => setPath(event.target.value)} value={path} />
      <button onClick={() => void browse()} type="button">浏览目录</button>
      <button onClick={() => setNewFileOpen(true)} type="button">新建文件</button>
      <label className="file-upload-control"><input aria-label="上传本地文件" className="sr-only" onChange={(event) => setUpload(event.target.files?.[0])} type="file" /><span>上传文件</span></label>
      <label className="file-upload-control"><input aria-label="上传本地文件夹" className="sr-only" onChange={selectFolder} type="file" {...({ webkitdirectory: '' } as Record<string, string>)} /><span>上传文件夹</span></label>
    </Panel>
    {message ? <div className="alert warning-alert" role="status">{message}</div> : null}
    {upload ? <Panel aria-label="待上传文件" className="upload-staging">
      <ul className="upload-staging-list">
        <li>
          <span className="file-kind-icon"><Icon name="file" /></span>
          <strong className="upload-staging-name">{upload.name}</strong>
          <small className="upload-staging-size">{formatBytes(upload.size)}</small>
          <button aria-label={`移除 ${upload.name}`} className="upload-staging-remove" onClick={() => setUpload(undefined)} type="button"><Icon name="close" size={14} /></button>
        </li>
      </ul>
      <div className="upload-staging-actions">
        <button onClick={() => setUpload(undefined)} type="button">清空</button>
        <button className="primary" onClick={() => void prepareUpload()} type="button">上传到当前目录</button>
      </div>
    </Panel> : null}
    {uploadFolder ? <Panel aria-label="待上传文件夹" className="upload-staging">
      <ul className="upload-staging-list">
        {uploadFolder.map((file, index) => {
          const name = fileRelativePath(file);
          return <li key={`${name}-${index}`}>
            <span className="file-kind-icon"><Icon name="file" /></span>
            <strong className="upload-staging-name">{name}</strong>
            <small className="upload-staging-size">{formatBytes(file.size)}</small>
            <button aria-label={`移除 ${name}`} className="upload-staging-remove" onClick={() => removeFolderFile(index)} type="button"><Icon name="close" size={14} /></button>
          </li>;
        })}
      </ul>
      <div className="upload-staging-actions">
        <button onClick={() => setUploadFolder(undefined)} type="button">清空</button>
        <button className="primary" onClick={() => void prepareUploadFolder()} type="button">上传文件夹到当前目录</button>
      </div>
    </Panel> : null}
    <Panel aria-label="远端文件列表" className="file-browser-panel">
      <SectionHeader count={entries.length} description="目录内容来自当前可信 SSH 连接" title={path} />
      <ul className="file-list">
        {path !== '/' ? <li><button onClick={() => void browse(parentPath(path))} type="button"><span className="file-kind-icon"><Icon name="collapse" /></span><strong>上级目录</strong><small>{parentPath(path)}</small></button></li> : null}
        {entries.map((entry) => <li key={entry.path} onContextMenu={(event) => {
          event.preventDefault();
          setContextMenu({ entry, x: event.clientX, y: event.clientY });
        }}>{renameTarget?.path === entry.path ? <span className="file-rename-row"><input aria-label={`新名称 ${entry.name}`} onChange={(event) => setRenameValue(event.target.value)} value={renameValue} /><button onClick={() => void confirmRename(entry)} type="button">确认</button><button onClick={() => setRenameTarget(undefined)} type="button">取消</button></span> : <button aria-label={`打开 ${entry.name}`} onClick={() => void open(entry)} type="button"><span className="file-kind-icon"><Icon name={entry.kind === 'directory' ? 'project' : 'file'} /></span><strong>{entry.name}</strong><small>{entry.kind} · {entry.size} B</small></button>}</li>)}
      </ul>
    </Panel>
    {contextMenu ? <div aria-label={`${contextMenu.entry.name} 操作`} className="file-context-menu" ref={contextMenuRef} role="menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
      <button onClick={() => { setContextMenu(undefined); void open(contextMenu.entry); }} role="menuitem" type="button">打开</button>
      <button onClick={() => { setContextMenu(undefined); startRename(contextMenu.entry); }} role="menuitem" type="button">重命名</button>
      {contextMenu.entry.kind === 'file' ? <button onClick={() => { setContextMenu(undefined); void downloadPath(contextMenu.entry.path); }} role="menuitem" type="button">下载</button> : null}
    </div> : null}
    {approval ? <RiskDecisionDialog environment={connected?.server.environment ?? 'other'} request={approval} onApprove={(proof) => void approve(proof)} onReject={() => void reject()} /> : null}
    <Modal onClose={closeEditor} open={Boolean(content)}>
      {content ? <section aria-label={content.path} aria-modal="true" className="file-editor-dialog" role="alertdialog">
        <header>
          <h2>{content.path}</h2>
          <button aria-label="关闭文件编辑" className="ui-icon-button" onClick={closeEditor} type="button"><Icon name="close" /></button>
        </header>
        <Suspense fallback={<div className="code-editor-loading" role="status"><span className="code-editor-spinner" aria-hidden="true" /><p>正在加载编辑器…</p></div>}>
          <CodeEditor aria-label="文件编辑内容" language={languageForPath(content.path)} onChange={setDraft} value={draft} />
        </Suspense>
        <dl className="risk-details">
          <div><dt>打开时 SHA-256</dt><dd className="digest">{content.sha256}</dd></div>
          <div><dt>大小</dt><dd>{content.bytes.length} B</dd></div>
        </dl>
        {draft !== baseline ? <div className="file-editor-diff"><h3>保存前 Diff</h3><pre>{lineDiff(baseline, draft)}</pre></div> : null}
        <footer>
          <button onClick={() => void downloadPath(content.path)} type="button">下载</button>
          <button className="primary" disabled={draft === baseline} onClick={() => void prepareSave()} type="button">查看 Diff 并保存</button>
        </footer>
      </section> : null}
    </Modal>
    <Modal onClose={() => setNewFileOpen(false)} open={newFileOpen}>
      <section aria-label="新建文件" aria-modal="true" className="risk-dialog" role="alertdialog">
        <h2>新建文件</h2>
        <p>在当前目录 {path} 下创建一个空文件；已存在同名文件时后端会拒绝。</p>
        <input aria-label="新文件名" onChange={(event) => setNewFileName(event.target.value)} placeholder="例如 notes.txt" value={newFileName} />
        <footer>
          <button onClick={() => setNewFileOpen(false)} type="button">取消</button>
          <button className="primary" onClick={() => void confirmNewFile()} type="button">确认</button>
        </footer>
      </section>
    </Modal>
  </div>;
}

function parentPath(path: string): string {
  const parent = path.replace(/\/$/u, '').split('/').slice(0, -1).join('/');
  return parent || '/';
}

function joinRemotePath(directory: string, name: string): string {
  return `${directory === '/' ? '' : directory.replace(/\/$/u, '')}/${name}`;
}

function fileRelativePath(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

// IPC 为 JSON 序列化，bytes 必须以 number[] 传递；对 16 MiB 上限的文件夹上传，展开为
// number 数组会放大内存（约 8 字节/字节 + JSON 文本），有界但需留意，后续可改二进制通道。
async function readFileBytes(file: File): Promise<number[]> {
  return [...new Uint8Array(await file.arrayBuffer())];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function safeFileName(name: string): boolean {
  const hasControlCharacter = Array.from(name).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  return name.length > 0
    && name !== '.'
    && name !== '..'
    && !name.includes('/')
    && !name.includes('\\')
    && !hasControlCharacter;
}

function lineDiff(before: string, after: string): string {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  const length = Math.max(oldLines.length, newLines.length);
  const lines: string[] = [];
  for (let index = 0; index < length; index += 1) {
    if (oldLines[index] === newLines[index]) lines.push(`  ${oldLines[index] ?? ''}`);
    else {
      if (oldLines[index] !== undefined) lines.push(`- ${oldLines[index]}`);
      if (newLines[index] !== undefined) lines.push(`+ ${newLines[index]}`);
    }
  }
  return lines.join('\n');
}

function saveBrowserDownload(name: string, bytes: number[]) {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)]));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}
