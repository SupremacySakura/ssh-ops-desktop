import { useEffect, useState } from 'react';
import type {
  ApprovalProof,
  ApprovalRequest,
  RemoteFileContent,
  RemoteFileEntry,
} from '@opspilot/contracts';

import type { CoreClient } from '../../api/core';
import { RiskDecisionDialog } from '../../app/risk-decision-dialog';
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

  return <div className="page-stack">
    <div className="page-heading"><div><p className="eyebrow">SECURE FILE TRANSFER</p><h1>远程文件</h1><p>SFTP 浏览、上传、下载与冲突校验由 Rust Core 执行；写入统一进入审批网关。</p></div><span className="status-badge"><i />可信 SFTP</span></div>
    <section className="panel file-toolbar"><select aria-label="文件服务器" onChange={(event) => setServerId(event.target.value)} value={serverId}><option value="">选择服务器</option>{connections.map(({ server }) => <option key={server.id} value={server.id}>{server.name}</option>)}</select><input aria-label="远程目录" onChange={(event) => setPath(event.target.value)} value={path} /><button onClick={() => void browse()} type="button">浏览目录</button><label>上传本地文件<input aria-label="上传本地文件" onChange={(event) => setUpload(event.target.files?.[0])} type="file" /></label><button disabled={!upload} onClick={() => void prepareUpload()} type="button">上传到当前目录</button></section>
    {message ? <div className="alert warning-alert" role="status">{message}</div> : null}
    <div className="file-layout"><section className="panel"><div className="panel-title"><h2>{path}</h2><span className="count-badge">{entries.length}</span></div><ul className="file-list">{path !== '/' ? <li><button onClick={() => void browse(parentPath(path))} type="button">↰ 上级目录</button></li> : null}{entries.map((entry) => <li key={entry.path}><button aria-label={`打开 ${entry.name}`} onClick={() => void open(entry)} type="button"><span>{entry.kind === 'directory' ? '▣' : '▤'}</span><strong>{entry.name}</strong><small>{entry.kind} · {entry.size} B</small></button></li>)}</ul></section><section className="panel file-preview"><div className="panel-title"><h2>{content?.path ?? '文件编辑'}</h2>{content ? <button onClick={() => void download()} type="button">下载</button> : null}</div>{content ? <><textarea aria-label="文件编辑内容" onChange={(event) => setDraft(event.target.value)} value={draft} /><button className="primary" disabled={draft === baseline} onClick={() => void prepareSave()} type="button">查看 Diff 并保存</button><dl className="risk-details"><div><dt>打开时 SHA-256</dt><dd className="digest">{content.sha256}</dd></div><div><dt>大小</dt><dd>{content.bytes.length} B</dd></div></dl></> : <div className="conversation-empty">选择一个普通文件进行预览或编辑</div>}</section></div>
    {content && draft !== baseline ? <section className="panel diff-panel"><h2>保存前 Diff</h2><pre>{lineDiff(baseline, draft)}</pre></section> : null}
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
  return name.length > 0
    && name !== '.'
    && name !== '..'
    && !name.includes('/')
    && !name.includes('\\')
    && !/[\u0000-\u001f\u007f]/u.test(name);
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
