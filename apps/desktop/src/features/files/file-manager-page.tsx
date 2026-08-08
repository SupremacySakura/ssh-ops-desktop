import { useEffect, useState } from 'react';
import type {
  ApprovalProof,
  ApprovalRequest,
  RemoteFileContent,
  RemoteFileEntry,
} from '@opspilot/contracts';

import type { CoreClient } from '../../api/core';
import { Icon } from '../../app/icons';
import { RiskDecisionDialog } from '../../app/risk-decision-dialog';
import { PageHeader, Panel, SectionHeader } from '../../app/ui/layout';
import type { ConnectedServer } from '../terminal/terminal-page';

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

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
  const [approval, setApproval] = useState<ApprovalRequest>();
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!serverId && connections[0]) setServerId(connections[0].server.id);
  }, [connections, serverId]);

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
    await prepareWrite(target, [...new Uint8Array(await upload.arrayBuffer())]);
  };

  const approve = async (proof: ApprovalProof) => {
    if (!core.approveOperation) return;
    try {
      await core.approveOperation(proof);
      setApproval(undefined);
      setUpload(undefined);
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

  const download = async () => {
    if (!content || !connected || !core.downloadFile) return;
    try {
      const result = await core.downloadFile({
        connection: connected.connection,
        path: content.path,
      });
      saveBrowserDownload(result.path.split('/').at(-1) ?? 'download', result.bytes);
      setMessage(`下载已准备，SHA-256 ${result.sha256}`);
    } catch {
      setMessage('下载失败；仅支持不超过 16 MiB 的普通文件');
    }
  };

  return <div className="page-stack files-page">
    <PageHeader actions={<span className="status-badge"><i />可信 SFTP</span>} description="SFTP 浏览、上传、下载与冲突校验由 Rust Core 执行；写入统一进入审批网关。" eyebrow="Secure file transfer" title="远程文件" />
    <Panel aria-label="文件操作" className="file-toolbar"><select aria-label="文件服务器" onChange={(event) => setServerId(event.target.value)} value={serverId}><option value="">选择服务器</option>{connections.map(({ server }) => <option key={server.id} value={server.id}>{server.name}</option>)}</select><input aria-label="远程目录" onChange={(event) => setPath(event.target.value)} value={path} /><button onClick={() => void browse()} type="button">浏览目录</button><label className="file-upload-control"><span>选择本地文件</span><input aria-label="上传本地文件" onChange={(event) => setUpload(event.target.files?.[0])} type="file" /></label><button className="primary" disabled={!upload} onClick={() => void prepareUpload()} type="button">上传到当前目录</button></Panel>
    {message ? <div className="alert warning-alert" role="status">{message}</div> : null}
    <div className="file-layout"><Panel aria-label="远端文件列表" className="file-browser-panel"><SectionHeader count={entries.length} description="目录内容来自当前可信 SSH 连接" title={path} /><ul className="file-list">{path !== '/' ? <li><button onClick={() => void browse(parentPath(path))} type="button"><span className="file-kind-icon"><Icon name="collapse" /></span><strong>上级目录</strong><small>{parentPath(path)}</small></button></li> : null}{entries.map((entry) => <li key={entry.path}><button aria-label={`打开 ${entry.name}`} onClick={() => void open(entry)} type="button"><span className="file-kind-icon"><Icon name={entry.kind === 'directory' ? 'project' : 'file'} /></span><strong>{entry.name}</strong><small>{entry.kind} · {entry.size} B</small></button></li>)}</ul></Panel><Panel aria-label="文件预览与编辑" className="file-preview"><SectionHeader actions={content ? <button onClick={() => void download()} type="button">下载</button> : null} description={content ? '保存前会校验打开时的 SHA-256' : '支持普通文本文件'} title={content?.path ?? '文件编辑'} />{content ? <><textarea aria-label="文件编辑内容" onChange={(event) => setDraft(event.target.value)} value={draft} /><div className="file-editor-actions"><button className="primary" disabled={draft === baseline} onClick={() => void prepareSave()} type="button">查看 Diff 并保存</button></div><dl className="risk-details"><div><dt>打开时 SHA-256</dt><dd className="digest">{content.sha256}</dd></div><div><dt>大小</dt><dd>{content.bytes.length} B</dd></div></dl></> : <div className="conversation-empty">选择一个普通文件进行预览或编辑</div>}</Panel></div>
    {content && draft !== baseline ? <Panel className="diff-panel"><SectionHeader description="远端文件不会在审批前发生变化" title="保存前 Diff" /><pre>{lineDiff(baseline, draft)}</pre></Panel> : null}
    {approval ? <RiskDecisionDialog environment={connected?.server.environment ?? 'other'} request={approval} onApprove={(proof) => void approve(proof)} onReject={() => void reject()} /> : null}
  </div>;
}

function parentPath(path: string): string {
  const parent = path.replace(/\/$/u, '').split('/').slice(0, -1).join('/');
  return parent || '/';
}

function joinRemotePath(directory: string, name: string): string {
  return `${directory === '/' ? '' : directory.replace(/\/$/u, '')}/${name}`;
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
