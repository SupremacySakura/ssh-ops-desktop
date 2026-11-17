import type {
  ConnectionHandle,
  RemoteFileEntry,
  RemoteFileWriteResult,
  RemoteTextFile,
} from '@opspilot/contracts';
import {
  MAX_EDITABLE_FILE_BYTES,
  MAX_FILE_DOWNLOAD_BYTES,
  RemoteDirectoryPathSchema,
  RemotePathSchema,
} from '@opspilot/contracts';
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileQuestion,
  FileText,
  Folder,
  Link2,
  RefreshCw,
  RotateCw,
  ServerOff,
} from 'lucide-react';
import {
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import type { CoreClient } from '../../api/core';
import {
  breadcrumbItems,
  downloadBlocked,
  downloadName,
  downloadNeedsConfirmation,
  formatFileModifiedAt,
  formatFileSize,
  formatPermissions,
  remoteFileErrorMessage,
} from './file-browser-utils';

const TextFileEditor = lazy(async () => {
  const module = await import('./text-file-editor');
  return { default: module.TextFileEditor };
});

export interface FileJumpRequest {
  nonce: number;
  path: string;
  notice?: string;
}

interface FileBrowserProps {
  active: boolean;
  connection: ConnectionHandle | null;
  connectionStatus: 'ready' | 'connecting' | 'closed';
  core: CoreClient;
  jumpRequest: FileJumpRequest | null;
  onReconnect(): void;
}

type ListState = 'idle' | 'loading' | 'ready' | 'error';

interface FileNotice {
  kind: 'error' | 'info';
  text: string;
}

export function FileBrowser({
  active,
  connection,
  connectionStatus,
  core,
  jumpRequest,
  onReconnect,
}: FileBrowserProps) {
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
  const [listState, setListState] = useState<ListState>('idle');
  const [listError, setListError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [treeChildren, setTreeChildren] = useState<Record<string, RemoteFileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['/']));
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [jumpNotice, setJumpNotice] = useState<string | null>(null);
  const [fileNotice, setFileNotice] = useState<FileNotice | null>(null);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);
  const [editorDocument, setEditorDocument] = useState<RemoteTextFile | null>(null);
  const [editorConnection, setEditorConnection] = useState<ConnectionHandle | null>(null);
  const loadedKey = useRef<string | null>(null);
  const appliedJumpNonce = useRef<number | null>(null);
  const connectionId = connection?.connectionId ?? null;

  useEffect(() => {
    setPath('/');
    setEntries([]);
    setListState('idle');
    setListError(null);
    setTreeChildren({});
    setExpanded(new Set(['/']));
    setSelectedPath(null);
    setFileNotice(null);
    if (connection) setEditorConnection(connection);
    loadedKey.current = null;
  }, [connection, connectionId]);

  useEffect(() => {
    if (!active || connectionStatus !== 'ready' || !connection) return;
    if (jumpRequest && appliedJumpNonce.current !== jumpRequest.nonce) return;
    const requestKey = `${connection.connectionId}\0${path}\0${retryToken}`;
    if (loadedKey.current === requestKey) return;
    let cancelled = false;
    setListState('loading');
    setListError(null);
    setEntries([]);
    void core.listFiles(connection, path)
      .then((result) => {
        if (cancelled) return;
        loadedKey.current = requestKey;
        setEntries(result);
        setTreeChildren((current) => ({
          ...current,
          [path]: result.filter((entry) => entry.kind === 'directory'),
        }));
        setListState('ready');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        loadedKey.current = null;
        setListState('error');
        setListError(remoteFileErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [
    active,
    connection,
    connectionStatus,
    core,
    jumpRequest,
    path,
    retryToken,
  ]);

  useEffect(() => {
    if (!jumpRequest || appliedJumpNonce.current === jumpRequest.nonce) return;
    appliedJumpNonce.current = jumpRequest.nonce;
    const parsed = RemoteDirectoryPathSchema.safeParse(jumpRequest.path);
    const nextPath = parsed.success ? parsed.data : '/';
    setPath(nextPath);
    setSelectedPath(null);
    setFileNotice(null);
    setRetryToken((token) => token + 1);
    setJumpNotice(
      jumpRequest.notice
        ?? (parsed.success ? null : '无法确定终端当前目录，已打开根目录'),
    );
    setExpanded((current) => {
      const next = new Set(current);
      for (const item of breadcrumbItems(nextPath)) next.add(item.path);
      return next;
    });
  }, [jumpRequest]);

  function navigateTo(nextPath: string) {
    const parsed = RemoteDirectoryPathSchema.safeParse(nextPath);
    if (!parsed.success) {
      setFileNotice({ kind: 'error', text: '远程目录路径无效，未打开' });
      return;
    }
    setPath(parsed.data);
    setSelectedPath(null);
    setJumpNotice(null);
    setFileNotice(null);
    setExpanded((current) => {
      const next = new Set(current);
      for (const item of breadcrumbItems(parsed.data)) next.add(item.path);
      return next;
    });
  }

  function toggleExpanded(directory: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(directory)) {
        next.delete(directory);
      } else {
        next.add(directory);
      }
      return next;
    });
  }

  async function openEntry(entry: RemoteFileEntry) {
    if (openingPath !== null) return;
    if (!connection) {
      setFileNotice({ kind: 'error', text: '服务器连接已断开，请重新连接' });
      return;
    }
    if (entry.kind === 'directory') {
      const next = joinDirectory(path, entry.name);
      if (next) navigateTo(next);
      return;
    }
    if (entry.kind === 'symlink') {
      setFileNotice({
        kind: 'error',
        text: '符号链接不进入文本编辑器；如需编辑，请打开其真实普通文件路径。',
      });
      return;
    }
    if (entry.kind !== 'file') {
      setFileNotice({
        kind: 'error',
        text: '该条目不是普通文件，无法在线编辑。',
      });
      return;
    }
    if (entry.size > MAX_EDITABLE_FILE_BYTES) {
      setFileNotice({
        kind: 'error',
        text: `文件 ${entry.name} 超过 1 MiB 在线编辑上限，未在编辑器中打开。`,
      });
      return;
    }
    const remotePath = RemotePathSchema.safeParse(entry.path);
    if (!remotePath.success) {
      setFileNotice({ kind: 'error', text: '远程文件路径无效，未打开编辑器。' });
      return;
    }
    setOpeningPath(entry.path);
    setFileNotice(null);
    try {
      const document = await core.readFile(connection, remotePath.data);
      setEditorConnection(connection);
      setEditorDocument(document);
    } catch (error) {
      setFileNotice({ kind: 'error', text: remoteFileErrorMessage(error) });
    } finally {
      setOpeningPath(null);
    }
  }

  async function download(entry: RemoteFileEntry) {
    if (downloadingPath !== null) return;
    if (!connection) {
      setFileNotice({ kind: 'error', text: '服务器连接已断开，请重新连接' });
      return;
    }
    if (entry.kind !== 'file') {
      setFileNotice({ kind: 'error', text: '只能下载普通文件，符号链接不会跟随。' });
      return;
    }
    if (downloadBlocked(entry.size)) {
      setFileNotice({
        kind: 'error',
        text: `文件 ${entry.name} 超过 ${formatFileSize(MAX_FILE_DOWNLOAD_BYTES)} 下载上限，未开始下载。`,
      });
      return;
    }
    if (
      downloadNeedsConfirmation(entry.size)
      && !window.confirm(
        `文件 ${entry.name} 大小为 ${formatFileSize(entry.size)}，`
        + '下载会占用较多内存与 IPC。仍要下载吗？',
      )
    ) {
      setFileNotice({ kind: 'info', text: '已取消下载。' });
      return;
    }
    const remotePath = RemotePathSchema.safeParse(entry.path);
    if (!remotePath.success) {
      setFileNotice({ kind: 'error', text: '远程文件路径无效，未开始下载。' });
      return;
    }
    setDownloadingPath(entry.path);
    setFileNotice(null);
    try {
      const result = await core.downloadFile(connection, remotePath.data);
      if (result.bytes.length > MAX_FILE_DOWNLOAD_BYTES) {
        throw new Error('Core 返回的下载内容超过 16 MiB 上限');
      }
      const bytes = Uint8Array.from(result.bytes);
      if (typeof URL.createObjectURL !== 'function') {
        throw new Error('当前 WebView 不支持直接生成下载文件');
      }
      const url = URL.createObjectURL(new Blob([bytes]));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = downloadName(entry.path);
      anchor.rel = 'noopener';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setFileNotice({
        kind: 'info',
        text: `已开始下载 ${anchor.download}。桌面版的最终保存位置由 WebView 下载策略决定。`,
      });
    } catch (error) {
      setFileNotice({ kind: 'error', text: remoteFileErrorMessage(error) });
    } finally {
      setDownloadingPath(null);
    }
  }

  function retry() {
    loadedKey.current = null;
    setRetryToken((token) => token + 1);
  }

  function applySaved(result: RemoteFileWriteResult) {
    setEntries((current) => current.map((entry) => (
      entry.path === result.path
        ? { ...entry, size: result.size, modifiedAt: result.modifiedAt }
        : entry
    )));
    setFileNotice({
      kind: 'info',
      text: result.warning
        ? `已保存 ${result.path}。${result.warning}`
        : `已保存 ${result.path}`,
    });
  }

  function applyReloaded(document: RemoteTextFile) {
    setEntries((current) => current.map((entry) => (
      entry.path === document.path
        ? { ...entry, size: document.size, modifiedAt: document.modifiedAt }
        : entry
    )));
  }

  const sortedEntries = [...entries].sort(compareEntries);
  const breadcrumbs = breadcrumbItems(path);
  const offline = connectionStatus === 'closed'
    || (connectionStatus === 'ready' && connection === null);
  const connecting = connectionStatus === 'connecting';
  const editorModal = editorDocument && editorConnection ? (
    <Suspense
      fallback={(
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink/45 p-6">
          <p className="border border-ink bg-shell px-5 py-4 font-mono text-[10px] text-ink">
            正在加载文本编辑器…
          </p>
        </div>
      )}
    >
      <TextFileEditor
        connection={editorConnection}
        core={core}
        document={editorDocument}
        onClose={() => {
          setEditorDocument(null);
          setEditorConnection(null);
        }}
        onReloaded={applyReloaded}
        onSaved={applySaved}
      />
    </Suspense>
  ) : null;

  if (offline) {
    return (
      <>
        <FileStatePanel
          actionLabel="重新连接服务器"
          description="文件浏览需要一条可用的 SFTP 通道。连接恢复后会从根目录重新读取；编辑器中的草稿不会被关闭。"
          icon={<ServerOff aria-hidden className="size-5" strokeWidth={1.5} />}
          onAction={onReconnect}
          title="服务器连接已断开"
        />
        {editorModal}
      </>
    );
  }

  if (connecting) {
    return (
      <>
        <FileStatePanel
          description="SSH 连接建立后，文件视图才会按需打开 SFTP 会话。"
          icon={<RefreshCw aria-hidden className="size-5 animate-pulse" strokeWidth={1.5} />}
          title="正在建立 SSH 连接"
        />
        {editorModal}
      </>
    );
  }

  return (
    <>
      <div className="flex min-h-0 flex-1">
      <aside className="flex w-[232px] shrink-0 flex-col border-r border-hairline bg-shell">
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-hairline px-3">
          <p className="font-mono text-[9px] tracking-[0.16em] text-muted">
            DIRECTORY TREE
          </p>
          <span className="font-mono text-[9px] text-muted">
            {Object.keys(treeChildren).length}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-2">
          <ul aria-label="目录树" className="m-0 list-none p-0">
            <TreeBranch
              currentPath={path}
              depth={0}
              directory="/"
              expanded={expanded}
              onNavigate={navigateTo}
              onToggle={toggleExpanded}
              treeChildren={treeChildren}
            />
          </ul>
        </div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-paper">
        <div className="flex h-10 shrink-0 items-center gap-3 border-b border-hairline bg-shell px-3">
          <nav aria-label="目录面包屑" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {breadcrumbs.map((item, index) => (
              <span className="flex shrink-0 items-center gap-1" key={item.path}>
                {index > 0 ? (
                  <ChevronRight aria-hidden className="size-3 text-muted" strokeWidth={1.5} />
                ) : null}
                <button
                  aria-current={index === breadcrumbs.length - 1 ? 'page' : undefined}
                  aria-label={`跳转到 ${item.path}`}
                  className={`h-7 px-1.5 font-mono text-[10px] ${
                    index === breadcrumbs.length - 1
                      ? 'text-ink'
                      : 'text-muted hover:bg-paper hover:text-ink'
                  }`}
                  onClick={() => navigateTo(item.path)}
                  type="button"
                >
                  {item.label}
                </button>
              </span>
            ))}
          </nav>
          <span className="shrink-0 font-mono text-[9px] tracking-[0.06em] text-muted">
            {sortedEntries.length} ITEMS
          </span>
          <button
            aria-label="刷新目录"
            className="grid size-7 shrink-0 place-items-center border border-hairline bg-paper text-muted hover:border-ink hover:text-ink disabled:opacity-40"
            disabled={listState === 'loading'}
            onClick={retry}
            type="button"
          >
            <RefreshCw
              aria-hidden
              className={`size-3.5 ${listState === 'loading' ? 'animate-spin' : ''}`}
              strokeWidth={1.5}
            />
          </button>
        </div>

        {jumpNotice ? (
          <p
            className="shrink-0 border-b border-warning/40 bg-[#F4EDE0] px-4 py-2 text-[10px] leading-4 text-warning"
            role="status"
          >
            {jumpNotice}
          </p>
        ) : null}

        {fileNotice ? (
          <p
            className={`shrink-0 border-b px-4 py-2 text-[10px] leading-4 ${
              fileNotice.kind === 'error'
                ? 'border-danger/40 bg-[#F4E9E5] text-danger'
                : 'border-success/30 bg-[#EDF2EC] text-success'
            }`}
            role={fileNotice.kind === 'error' ? 'alert' : 'status'}
          >
            {fileNotice.text}
          </p>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto">
          {listState === 'loading' ? (
            <div className="px-4 py-3" role="status">
              <div className="h-px w-full overflow-hidden bg-hairline">
                <span className="block h-full w-1/3 animate-pulse bg-accent" />
              </div>
              <p className="mt-3 font-mono text-[10px] tracking-[0.06em] text-muted">
                正在读取 {path}…
              </p>
            </div>
          ) : null}

          {listState === 'error' ? (
            <div className="grid h-full place-items-center px-8 py-10">
              <div className="w-full max-w-md border-y border-hairline py-7">
                <p className="font-mono text-[9px] tracking-[0.16em] text-danger">
                  SFTP READ FAILED
                </p>
                <h3 className="mt-2 text-[18px] font-semibold text-ink">
                  目录读取失败
                </h3>
                <p className="mt-2 text-[11px] leading-5 text-muted">
                  {listError}
                </p>
                <button
                  className="mt-4 inline-flex h-8 items-center gap-1.5 border border-ink bg-ink px-3 text-[11px] font-medium text-paper"
                  onClick={retry}
                  type="button"
                >
                  <RotateCw aria-hidden className="size-3.5" strokeWidth={1.5} />
                  重试目录
                </button>
              </div>
            </div>
          ) : null}

          {listState === 'ready' && sortedEntries.length === 0 ? (
            <div className="grid h-full place-items-center px-8 py-10">
              <div className="w-full max-w-md border-y border-hairline py-7">
                <p className="font-mono text-[9px] tracking-[0.16em] text-muted">
                  EMPTY DIRECTORY
                </p>
                <h3 className="mt-2 text-[18px] font-semibold text-ink">
                  目录为空
                </h3>
                <p className="mt-2 text-[11px] leading-5 text-muted">
                  {path} 当前没有文件或子目录。
                </p>
                <button
                  className="mt-4 h-8 border border-hairline bg-paper px-3 text-[11px] font-medium text-ink hover:border-ink"
                  onClick={retry}
                  type="button"
                >
                  重新读取
                </button>
              </div>
            </div>
          ) : null}

          {listState === 'ready' && sortedEntries.length > 0 ? (
            <table
              aria-label="目录内容"
              className="w-full table-fixed border-collapse text-left"
            >
              <thead className="sticky top-0 z-10 bg-shell">
                <tr className="h-8 border-b border-hairline font-mono text-[9px] tracking-[0.08em] text-muted">
                  <th className="w-[48%] px-3 font-normal">名称</th>
                  <th className="w-[14%] px-2 text-right font-normal">大小</th>
                  <th className="w-[22%] px-2 font-normal">修改时间</th>
                  <th className="w-[10%] px-2 font-normal">权限</th>
                  <th className="w-[6%] px-2 text-right font-normal">操作</th>
                </tr>
              </thead>
              <tbody>
                {sortedEntries.map((entry) => {
                  const selected = selectedPath === entry.path;
                  const opening = openingPath === entry.path;
                  return (
                    <tr
                      className={`h-9 border-b border-hairline/80 ${
                        selected ? 'bg-[#EFEAE0]' : 'hover:bg-[#F2EFE8]'
                      }`}
                      key={entry.path}
                    >
                      <td className="min-w-0 px-2">
                        <button
                          aria-label={`${entry.kind === 'directory' ? '打开目录' : '打开文件'} ${entry.name}`}
                          className="flex h-8 w-full min-w-0 items-center gap-2 px-1 text-left text-[12px] text-ink"
                          onClick={() => setSelectedPath(entry.path)}
                          onDoubleClick={() => void openEntry(entry)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void openEntry(entry);
                            }
                          }}
                          title={
                            entry.kind === 'directory'
                              ? '双击进入目录'
                              : '双击打开文本文件'
                          }
                          type="button"
                        >
                          <FileKindIcon entry={entry} />
                          <span className="truncate">{entry.name}</span>
                          {opening ? (
                            <span className="ml-auto font-mono text-[8px] text-accent">
                              读取中
                            </span>
                          ) : null}
                        </button>
                      </td>
                      <td className="px-2 text-right font-mono text-[10px] text-muted">
                        {entry.kind === 'directory' ? '—' : formatFileSize(entry.size)}
                      </td>
                      <td className="px-2 font-mono text-[10px] text-muted">
                        {formatFileModifiedAt(entry.modifiedAt)}
                      </td>
                      <td className="px-2 font-mono text-[10px] text-muted">
                        {formatPermissions(entry.permissions)}
                      </td>
                      <td className="px-2 text-right">
                        {entry.kind === 'file' ? (
                          <button
                            aria-label={`下载 ${entry.name}`}
                            className="grid size-7 place-items-center text-muted hover:bg-paper hover:text-ink disabled:opacity-40"
                            disabled={downloadingPath !== null}
                            onClick={() => void download(entry)}
                            title="下载到本地"
                            type="button"
                          >
                            <Download aria-hidden className="size-3.5" strokeWidth={1.5} />
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : null}
        </div>
      </section>

      </div>
      {editorModal}
    </>
  );
}

function TreeBranch({
  currentPath,
  depth,
  directory,
  expanded,
  onNavigate,
  onToggle,
  treeChildren,
}: {
  currentPath: string;
  depth: number;
  directory: string;
  expanded: Set<string>;
  onNavigate(path: string): void;
  onToggle(path: string): void;
  treeChildren: Record<string, RemoteFileEntry[]>;
}) {
  const children = treeChildren[directory] ?? [];
  const isExpanded = expanded.has(directory);
  const current = currentPath === directory;
  const label = directory === '/' ? '/' : directory.split('/').at(-1) ?? directory;
  return (
    <li>
      <div
        className={`flex h-8 items-stretch border-b border-hairline/60 ${
          current ? 'bg-ink text-paper' : 'text-ink hover:bg-paper'
        }`}
      >
        <button
          aria-current={current ? 'page' : undefined}
          aria-label={`目录 ${directory}`}
          className="flex min-w-0 flex-1 items-center gap-2 pr-1 text-left text-[11px]"
          onClick={() => onNavigate(directory)}
          style={{ paddingLeft: `${8 + depth * 12}px` }}
          type="button"
        >
          <Folder
            aria-hidden
            className={`size-3.5 shrink-0 ${current ? 'text-accent' : 'text-muted'}`}
            strokeWidth={1.5}
          />
          <span className="truncate font-mono">{label}</span>
        </button>
        {children.length > 0 ? (
          <button
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? '收起' : '展开'}目录 ${directory}`}
            className={`grid w-7 shrink-0 place-items-center ${
              current ? 'text-[#B9B4A8] hover:text-paper' : 'text-muted hover:text-ink'
            }`}
            onClick={() => onToggle(directory)}
            type="button"
          >
            {isExpanded ? (
              <ChevronDown aria-hidden className="size-3" strokeWidth={1.5} />
            ) : (
              <ChevronRight aria-hidden className="size-3" strokeWidth={1.5} />
            )}
          </button>
        ) : null}
      </div>
      {isExpanded && children.length > 0 ? (
        <ul className="m-0 list-none p-0">
          {children.map((child) => {
            const childPath = joinDirectory(directory, child.name);
            if (!childPath) return null;
            return (
              <TreeBranch
                currentPath={currentPath}
                depth={depth + 1}
                directory={childPath}
                expanded={expanded}
                key={childPath}
                onNavigate={onNavigate}
                onToggle={onToggle}
                treeChildren={treeChildren}
              />
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

function FileKindIcon({ entry }: { entry: RemoteFileEntry }) {
  const className = entry.kind === 'directory' ? 'text-muted' : 'text-[#8C877C]';
  switch (entry.kind) {
    case 'directory':
      return <Folder aria-hidden className={`size-3.5 shrink-0 ${className}`} strokeWidth={1.5} />;
    case 'symlink':
      return <Link2 aria-hidden className={`size-3.5 shrink-0 ${className}`} strokeWidth={1.5} />;
    case 'other':
      return <FileQuestion aria-hidden className={`size-3.5 shrink-0 ${className}`} strokeWidth={1.5} />;
    default:
      return (
        <FileText
          aria-hidden
          className={`size-3.5 shrink-0 ${
            entry.name.includes('.') ? 'text-[#8C877C]' : className
          }`}
          strokeWidth={1.5}
        />
      );
  }
}

function FileStatePanel({
  actionLabel,
  description,
  icon,
  onAction,
  title,
}: {
  actionLabel?: string;
  description: string;
  icon: ReactNode;
  onAction?(): void;
  title: string;
}) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center bg-paper px-8">
      <div className="w-full max-w-lg border-y border-hairline py-8">
        <span className="grid size-10 place-items-center border border-hairline text-muted">
          {icon}
        </span>
        <p className="mt-4 font-mono text-[9px] tracking-[0.16em] text-muted">
          FILE VIEW / OFFLINE
        </p>
        <h3 className="mt-2 text-[20px] font-semibold tracking-[-0.01em] text-ink">
          {title}
        </h3>
        <p className="mt-2 text-[11px] leading-5 text-muted">{description}</p>
        {actionLabel && onAction ? (
          <button
            className="mt-5 inline-flex h-8 items-center gap-1.5 bg-ink px-3 text-[11px] font-medium text-paper"
            onClick={onAction}
            type="button"
          >
            <RotateCw aria-hidden className="size-3.5" strokeWidth={1.5} />
            {actionLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function joinDirectory(parent: string, name: string): string | null {
  const parsed = RemoteDirectoryPathSchema.safeParse(
    parent === '/' ? `/${name}` : `${parent}/${name}`,
  );
  return parsed.success ? parsed.data : null;
}

function compareEntries(left: RemoteFileEntry, right: RemoteFileEntry): number {
  const order = kindOrder(left.kind) - kindOrder(right.kind);
  if (order !== 0) return order;
  return left.name.localeCompare(right.name, 'en-US', { sensitivity: 'base' })
    || left.name.localeCompare(right.name, 'en-US');
}

function kindOrder(kind: RemoteFileEntry['kind']): number {
  switch (kind) {
    case 'directory':
      return 0;
    case 'file':
      return 1;
    case 'symlink':
      return 2;
    default:
      return 3;
  }
}
