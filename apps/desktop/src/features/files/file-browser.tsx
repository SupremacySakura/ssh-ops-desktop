import type {
  ConnectionHandle,
  RemoteFileEntry,
  RemoteFileWriteResult,
  RemoteRenameResult,
  RemoteTextFile,
  RemoteUploadFile,
  RemoteUploadOutcome,
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
  Pencil,
  FileQuestion,
  FileText,
  Folder,
  Link2,
  Plus,
  RefreshCw,
  RotateCw,
  ServerOff,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  Suspense,
  lazy,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import type { ChangeEvent, ReactNode } from 'react';

import type { CoreClient } from '../../api/core';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { useDialogFocusTrap } from '../../components/use-dialog-focus-trap';
import {
  breadcrumbItems,
  downloadBlocked,
  downloadName,
  downloadNeedsConfirmation,
  formatFileModifiedAt,
  formatFileSize,
  formatPermissions,
  joinRemoteResource,
  remoteFileErrorMessage,
  uploadBatchBlocked,
  uploadBatchNeedsConfirmation,
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

interface OperationNotice {
  id: number;
  kind: 'error' | 'info' | 'warning';
  text: string;
  residual: string[];
  refreshDirectory?: string;
  cleanup?: {
    entry: RemoteFileEntry;
    serverId: string;
    warning: string;
  };
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
  const [uploadFiles, setUploadFiles] = useState<File[] | null>(null);
  const [uploadDirectory, setUploadDirectory] = useState<string | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadErrorRetryable, setUploadErrorRetryable] = useState(false);
  const [uploadOutcome, setUploadOutcome] = useState<RemoteUploadOutcome | null>(null);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirDirectory, setMkdirDirectory] = useState<string | null>(null);
  const [mkdirName, setMkdirName] = useState('');
  const [mkdirBusy, setMkdirBusy] = useState(false);
  const [mkdirError, setMkdirError] = useState<string | null>(null);
  const [renameEntry, setRenameEntry] = useState<RemoteFileEntry | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameOutcome, setRenameOutcome] = useState<RemoteRenameResult | null>(null);
  const [deleteEntry, setDeleteEntry] = useState<RemoteFileEntry | null>(null);
  const [deleteWarning, setDeleteWarning] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteNoticeId, setDeleteNoticeId] = useState<number | null>(null);
  const [operationNotices, setOperationNotices] = useState<OperationNotice[]>([]);
  const [pendingNoticeRefresh, setPendingNoticeRefresh] = useState<{
    id: number;
    directory: string;
  } | null>(null);
  const noticeSequence = useRef(0);
  const uploadResidueNoticeId = useRef<number | null>(null);
  const loadedKey = useRef<string | null>(null);
  const appliedJumpNonce = useRef<number | null>(null);
  const treeLoaded = useRef<Set<string>>(new Set());
  const treeRequests = useRef<Set<string>>(new Set());
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const connectionId = connection?.connectionId ?? null;
  const serverId = connection?.serverId ?? null;
  const connectionIdRef = useRef(connectionId);
  connectionIdRef.current = connectionId;
  const serverIdRef = useRef(serverId);
  const canWrite = connectionStatus === 'ready' && connection !== null;

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
    treeLoaded.current.clear();
    treeRequests.current.clear();
  }, [connection, connectionId]);

  useEffect(() => {
    const previous = serverIdRef.current;
    serverIdRef.current = serverId;
    if (serverId === null || previous === null || previous === serverId) return;
    setUploadFiles(null);
    setUploadDirectory(null);
    setUploadError(null);
    setUploadErrorRetryable(false);
    setUploadOutcome(null);
    setMkdirOpen(false);
    setMkdirDirectory(null);
    setMkdirError(null);
    setRenameEntry(null);
    setRenameError(null);
    setRenameOutcome(null);
    setDeleteEntry(null);
    setDeleteWarning(null);
    setDeleteError(null);
    setDeleteNoticeId(null);
  }, [serverId]);

  useEffect(() => {
    if (!active || connectionStatus !== 'ready' || !connection) return;
    if (jumpRequest && appliedJumpNonce.current !== jumpRequest.nonce) return;
    const requestKey = `${connection.connectionId}\0${path}\0${retryToken}`;
    if (loadedKey.current === requestKey) return;
    let cancelled = false;
    setListState('loading');
    setListError(null);
    setEntries([]);
    const ancestors = breadcrumbItems(path)
      .slice(0, -1)
      .map((item) => item.path)
      .filter((directory) => !treeLoaded.current.has(directory));
    const directories = [...ancestors, path];
    void Promise.all(directories.map(async (directory) => (
      [directory, await core.listFiles(connection, directory)] as const
    )))
      .then((results) => {
        if (cancelled || connectionIdRef.current !== connection.connectionId) return;
        for (const [directory] of results) treeLoaded.current.add(directory);
        setTreeChildren((current) => {
          const next = { ...current };
          for (const [directory, result] of results) {
            next[directory] = result.filter((entry) => entry.kind === 'directory');
          }
          return next;
        });
        const currentEntries = results.find(([directory]) => directory === path)?.[1] ?? [];
        loadedKey.current = requestKey;
        setEntries(currentEntries);
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

  async function loadTreeDirectory(directory: string) {
    if (
      !connection
      || connectionStatus !== 'ready'
      || treeLoaded.current.has(directory)
      || treeRequests.current.has(directory)
    ) {
      return;
    }
    const requestedConnectionId = connection.connectionId;
    treeRequests.current.add(directory);
    try {
      const result = await core.listFiles(connection, directory);
      if (connectionIdRef.current !== requestedConnectionId) return;
      treeLoaded.current.add(directory);
      setTreeChildren((current) => ({
        ...current,
        [directory]: result.filter((entry) => entry.kind === 'directory'),
      }));
    } catch (error) {
      if (connectionIdRef.current === requestedConnectionId) {
        setFileNotice({
          kind: 'error',
          text: `目录树读取 ${directory} 失败：${remoteFileErrorMessage(error)}`,
        });
      }
    } finally {
      treeRequests.current.delete(directory);
    }
  }

  function toggleExpanded(directory: string) {
    const nextExpanded = !expanded.has(directory);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(directory)) {
        next.delete(directory);
      } else {
        next.add(directory);
      }
      return next;
    });
    if (nextExpanded) void loadTreeDirectory(directory);
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
    const requestedConnectionId = connection.connectionId;
    try {
      const document = await core.readFile(connection, remotePath.data);
      if (connectionIdRef.current !== requestedConnectionId) return;
      setEditorConnection(connection);
      setEditorDocument(document);
    } catch (error) {
      if (connectionIdRef.current === requestedConnectionId) {
        setFileNotice({ kind: 'error', text: remoteFileErrorMessage(error) });
      }
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
    const requestedConnectionId = connection.connectionId;
    try {
      const result = await core.downloadFile(connection, remotePath.data);
      if (connectionIdRef.current !== requestedConnectionId) return;
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
      if (connectionIdRef.current === requestedConnectionId) {
        setFileNotice({ kind: 'error', text: remoteFileErrorMessage(error) });
      }
    } finally {
      setDownloadingPath(null);
    }
  }

  function retry() {
    loadedKey.current = null;
    setRetryToken((token) => token + 1);
  }

  function refreshAfterMutation(
    directory = path,
    selected: string | null = null,
  ) {
    const parsed = RemoteDirectoryPathSchema.safeParse(directory);
    if (parsed.success) {
      setPath(parsed.data);
      setListState('loading');
    }
    setSelectedPath(selected);
    loadedKey.current = null;
    treeLoaded.current.clear();
    treeRequests.current.clear();
    setRetryToken((token) => token + 1);
  }

  function pushOperationNotice(notice: Omit<OperationNotice, 'id'>) {
    noticeSequence.current += 1;
    setOperationNotices((current) => [
      ...current,
      { ...notice, id: noticeSequence.current },
    ]);
    return noticeSequence.current;
  }

  useEffect(() => {
    if (!pendingNoticeRefresh) return;
    if (listState === 'error') {
      setPendingNoticeRefresh(null);
      return;
    }
    if (listState === 'ready' && path === pendingNoticeRefresh.directory) {
      setOperationNotices((current) => (
        current.filter((notice) => notice.id !== pendingNoticeRefresh.id)
      ));
      setPendingNoticeRefresh(null);
    }
  }, [listState, path, pendingNoticeRefresh]);

  function selectUploadFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (selected.length === 0) return;
    if (uploadBatchBlocked(selected.map((file) => file.size))) {
      setFileNotice({
        kind: 'error',
        text: '上传批次超过限制：单文件最多 16 MiB，整批最多 16 MiB 且不超过 32 个文件。',
      });
      return;
    }
    const invalidName = selected.find((file) => (
      joinRemoteResource(path, file.name) === null
    ));
    if (invalidName) {
      setFileNotice({
        kind: 'error',
        text: `文件名 ${invalidName.name} 不是安全的 basename，未开始上传。`,
      });
      return;
    }
    const names = new Set<string>();
    const duplicate = selected.find((file) => {
      if (names.has(file.name)) return true;
      names.add(file.name);
      return false;
    });
    if (duplicate) {
      setFileNotice({
        kind: 'error',
        text: `上传批次包含重复文件名 ${duplicate.name}，未开始上传。`,
      });
      return;
    }
    const directory = path;
    setUploadFiles(selected);
    setUploadDirectory(directory);
    setUploadBusy(false);
    setUploadError(null);
    setUploadErrorRetryable(false);
    setUploadOutcome(null);
    uploadResidueNoticeId.current = null;
  }

  function closeUploadDialog() {
    if (uploadBusy) return;
    setUploadFiles(null);
    setUploadDirectory(null);
    setUploadError(null);
    setUploadErrorRetryable(false);
    setUploadOutcome(null);
  }

  async function submitUpload() {
    const selectedFiles = uploadFiles;
    const directory = uploadDirectory;
    if (!connection || !selectedFiles || !directory || uploadBusy) return;
    const parsedDirectory = RemoteDirectoryPathSchema.safeParse(directory);
    if (!parsedDirectory.success) {
      setUploadError('上传目标目录无效，请重新选择文件。');
      return;
    }
    const requestedConnectionId = connection.connectionId;
    const count = selectedFiles.length;
    setUploadBusy(true);
    setUploadError(null);
    setUploadErrorRetryable(false);
    setUploadOutcome(null);
    try {
      const payload: RemoteUploadFile[] = [];
      for (const file of selectedFiles) {
        payload.push({
          name: file.name,
          bytes: await readFileBytes(file),
        });
        if (connectionIdRef.current !== requestedConnectionId) {
          setUploadError('连接已变化，上传尚未开始；请确认目标目录后重试。');
          setUploadErrorRetryable(true);
          return;
        }
      }
      const outcome = await core.uploadFiles(
        connection,
        parsedDirectory.data,
        payload,
      );
      const stale = connectionIdRef.current !== requestedConnectionId;
      if (outcome.status === 'succeeded') {
        setUploadFiles(null);
        setUploadDirectory(null);
        if (stale) {
          pushOperationNotice({
            kind: outcome.residual.length > 0 ? 'warning' : 'info',
            text: [
              `上一连接已完成 ${count} 个文件的上传到 ${directory}。`,
              outcome.warning,
              outcome.residual.length > 0
                ? '临时文件或提交残留仍可能存在，请手动核对。'
                : null,
            ].filter(Boolean).join(' '),
            residual: outcome.residual,
            refreshDirectory: directory,
          });
        } else {
          refreshAfterMutation(directory);
          setFileNotice({
            kind: 'info',
            text: [
              `已上传 ${count} 个文件到 ${directory}。`,
              outcome.warning,
              outcome.residual.length > 0
                ? `残留临时路径：${outcome.residual.join('、')}`
                : null,
            ].filter(Boolean).join(' '),
          });
        }
        return;
      }
      setUploadOutcome(outcome);
      const reason = outcome.error
        ? remoteFileErrorMessage(outcome.error)
        : '上传失败';
      if (outcome.status === 'failed_with_residue') {
        setUploadErrorRetryable(false);
        setUploadError(
          `${reason}；${outcome.warning ?? '部分文件未回滚，请刷新目录核对。'}`
            + (stale ? ' 连接已变化，重连后可刷新目录。' : ''),
        );
        uploadResidueNoticeId.current = pushOperationNotice({
          kind: 'error',
          text: [
            stale
              ? `上一连接上传失败，回滚未完全完成：${reason}`
              : `上传失败，回滚未完全完成：${reason}`,
            outcome.warning,
          ].filter(Boolean).join(' '),
          residual: outcome.residual,
          refreshDirectory: directory,
        });
      } else {
        const retryable = outcome.error?.retryable === true;
        setUploadErrorRetryable(retryable);
        setUploadError(
          `${reason}；本次已提交文件已回滚。`
            + (retryable
              ? '可重试。'
              : '该错误不可重试，请关闭后检查目标。')
            + (outcome.warning ? ` ${outcome.warning}` : '')
            + (stale
              ? retryable
                ? ' 连接已变化，重连后可重试。'
                : ' 连接已变化，请重连后刷新核对。'
              : ''),
        );
        if (stale) {
          pushOperationNotice({
            kind: retryable ? 'warning' : 'error',
            text: [
              `上一连接上传失败，已回滚：${reason}`,
              outcome.warning,
            ].filter(Boolean).join(' '),
            residual: [],
            refreshDirectory: directory,
          });
        }
      }
    } catch (error) {
      const stale = connectionIdRef.current !== requestedConnectionId;
      const retryable = isRetryableError(error);
      setUploadErrorRetryable(retryable);
      setUploadError(
        remoteFileErrorMessage(error)
          + (stale
            ? retryable
              ? '；连接已变化，重连后可重试。'
              : '；连接已变化，请重连后刷新核对。'
            : ''),
      );
      if (stale) {
        pushOperationNotice({
          kind: 'error',
          text: `上一连接上传失败：${remoteFileErrorMessage(error)}`,
          residual: [],
          refreshDirectory: directory,
        });
      }
    } finally {
      setUploadBusy(false);
    }
  }

  function openMkdirDialog() {
    setMkdirDirectory(path);
    setMkdirName('');
    setMkdirError(null);
    setMkdirOpen(true);
  }

  function closeMkdirDialog() {
    if (mkdirBusy) return;
    setMkdirOpen(false);
    setMkdirDirectory(null);
    setMkdirError(null);
  }

  async function submitMkdir() {
    const directory = mkdirDirectory;
    if (!connection || !directory || mkdirBusy) return;
    const target = joinRemoteResource(directory, mkdirName);
    if (!target) {
      setMkdirError('文件夹名称必须是安全的 basename，不能包含 / 或控制字符。');
      return;
    }
    const requestedConnectionId = connection.connectionId;
    setMkdirBusy(true);
    setMkdirError(null);
    try {
      const result = await core.createDirectory(connection, target);
      setMkdirOpen(false);
      setMkdirDirectory(null);
      setMkdirName('');
      if (connectionIdRef.current !== requestedConnectionId) {
        pushOperationNotice({
          kind: 'info',
          text: [
            `上一连接已创建 ${result.path}。`,
            result.warning,
          ].filter(Boolean).join(' '),
          residual: [],
          refreshDirectory: directory,
        });
      } else {
        refreshAfterMutation(directory);
        setFileNotice({
          kind: 'info',
          text: result.warning
            ? `已创建 ${result.path}。${result.warning}`
            : `已创建 ${result.path}`,
        });
      }
    } catch (error) {
      const stale = connectionIdRef.current !== requestedConnectionId;
      const retryable = isRetryableError(error);
      setMkdirError(
        remoteFileErrorMessage(error)
          + (stale
            ? retryable
              ? '；连接已变化，重连后可重试。'
              : '；连接已变化，请重连后刷新核对。'
            : ''),
      );
      if (stale) {
        pushOperationNotice({
          kind: 'error',
          text: `上一连接新建目录失败：${remoteFileErrorMessage(error)}`,
          residual: [],
          refreshDirectory: directory,
        });
      }
    } finally {
      setMkdirBusy(false);
    }
  }

  function openRenameDialog(entry: RemoteFileEntry) {
    setRenameEntry(entry);
    setRenameName(entry.name);
    setRenameError(null);
    setRenameOutcome(null);
  }

  function closeRenameDialog() {
    if (renameBusy) return;
    setRenameEntry(null);
    setRenameError(null);
    setRenameOutcome(null);
  }

  async function submitRename() {
    const entry = renameEntry;
    if (!connection || !entry || renameBusy) return;
    if (entry.kind === 'directory') {
      setRenameError(
        '当前 SFTP 服务器没有经过验证的原子 no-replace 目录重命名原语，已拒绝操作。',
      );
      return;
    }
    const parent = entry.path.includes('/')
      ? entry.path.slice(0, entry.path.lastIndexOf('/')) || '/'
      : '/';
    const target = joinRemoteResource(parent, renameName);
    if (!target) {
      setRenameError('新名称必须是安全的 basename，不能包含 / 或控制字符。');
      return;
    }
    if (target === entry.path) {
      setRenameError('新名称必须与原名称不同。');
      return;
    }
    const requestedConnectionId = connection.connectionId;
    setRenameBusy(true);
    setRenameError(null);
    setRenameOutcome(null);
    try {
      const result = await core.renameFile(connection, entry.path, target);
      const stale = connectionIdRef.current !== requestedConnectionId;
      if (result.status === 'partial') {
        setRenameOutcome(result);
        setRenameError(
          result.warning
          ?? '目标文件已创建，但源文件可能仍然存在；请确认后重试清理源文件。',
        );
        if (!result.targetCreated) {
          pushOperationNotice({
            kind: 'warning',
            text: [
              `${stale ? '上一连接' : ''}重命名 ${result.sourcePath} 的结果不确定：`,
              result.warning,
              '未提供删除源文件操作，请刷新目录核对后再处理。',
            ].filter(Boolean).join(' '),
            residual: [result.sourcePath],
            refreshDirectory: parent,
          });
        } else {
          pushOperationNotice({
            kind: 'warning',
            text: [
              `${stale ? '上一连接' : ''}已将 ${result.sourcePath} 重命名为 ${result.targetPath}，但源文件可能仍然存在。`,
              result.warning,
              stale
                ? '重连后可刷新目录并清理源文件。'
                : '请刷新目录核对，并在重命名对话框中确认后清理源文件。',
            ].filter(Boolean).join(' '),
            residual: [result.sourcePath],
            refreshDirectory: parent,
            cleanup: {
              entry,
              serverId: connection.serverId,
              warning: result.warning ?? '目标文件已创建，但源文件删除失败。',
            },
          });
        }
        if (result.targetCreated && !stale) {
          refreshAfterMutation(parent);
        }
        return;
      }
      setRenameEntry(null);
      setRenameError(null);
      setRenameOutcome(null);
      if (stale) {
        pushOperationNotice({
          kind: 'info',
          text: [
            `上一连接已将 ${result.sourcePath} 重命名为 ${result.targetPath}。`,
            result.warning,
          ].filter(Boolean).join(' '),
          residual: [],
          refreshDirectory: parent,
        });
      } else {
        refreshAfterMutation(parent, result.targetPath);
        setFileNotice({
          kind: 'info',
          text: result.warning
            ? `已将 ${result.sourcePath} 重命名为 ${result.targetPath}。${result.warning}`
            : `已将 ${result.sourcePath} 重命名为 ${result.targetPath}`,
        });
      }
    } catch (error) {
      const stale = connectionIdRef.current !== requestedConnectionId;
      const retryable = isRetryableError(error);
      setRenameError(
        remoteFileErrorMessage(error)
          + (stale
            ? retryable
              ? '；连接已变化，重连后可重试。'
              : '；连接已变化，请重连后刷新核对。'
            : ''),
      );
      if (stale) {
        pushOperationNotice({
          kind: 'error',
          text: `上一连接重命名失败：${remoteFileErrorMessage(error)}`,
          residual: [],
          refreshDirectory: parent,
        });
      }
    } finally {
      setRenameBusy(false);
    }
  }

  function startRenameCleanup() {
    if (!renameEntry || !renameOutcome?.targetCreated) return;
    setDeleteEntry(renameEntry);
    setDeleteWarning(renameOutcome.warning ?? null);
    setDeleteError(null);
    setRenameEntry(null);
    setRenameError(null);
    setRenameOutcome(null);
  }

  function requestDelete(entry: RemoteFileEntry) {
    setDeleteEntry(entry);
    setDeleteWarning(null);
    setDeleteError(null);
  }

  function closeDeleteDialog() {
    if (deleteBusy) return;
    setDeleteEntry(null);
    setDeleteWarning(null);
    setDeleteError(null);
    setDeleteNoticeId(null);
  }

  async function submitDelete() {
    const entry = deleteEntry;
    if (!connection || !entry || deleteBusy) return;
    const requestedConnectionId = connection.connectionId;
    const parent = entry.path.includes('/')
      ? entry.path.slice(0, entry.path.lastIndexOf('/')) || '/'
      : '/';
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const result = await core.deleteFile(connection, entry.path);
      setDeleteEntry(null);
      setDeleteWarning(null);
      if (deleteNoticeId !== null) {
        dismissOperationNotice(deleteNoticeId);
        setDeleteNoticeId(null);
      }
      if (connectionIdRef.current !== requestedConnectionId) {
        pushOperationNotice({
          kind: 'info',
          text: [
            `上一连接已删除 ${result.path}。`,
            result.warning,
          ].filter(Boolean).join(' '),
          residual: [],
          refreshDirectory: parent,
        });
      } else {
        refreshAfterMutation(parent);
        setFileNotice({
          kind: 'info',
          text: result.warning
            ? `已删除 ${result.path}。${result.warning}`
            : `已删除 ${result.path}`,
        });
      }
    } catch (error) {
      const stale = connectionIdRef.current !== requestedConnectionId;
      const retryable = isRetryableError(error);
      setDeleteError(
        remoteFileErrorMessage(error)
          + (stale
            ? retryable
              ? '；连接已变化，重连后可重试。'
              : '；连接已变化，请重连后刷新核对。'
            : ''),
      );
      if (stale) {
        pushOperationNotice({
          kind: 'error',
          text: `上一连接删除失败：${remoteFileErrorMessage(error)}`,
          residual: [],
          refreshDirectory: parent,
        });
      }
    } finally {
      setDeleteBusy(false);
    }
  }

  function dismissOperationNotice(id: number) {
    setOperationNotices((current) => current.filter((notice) => notice.id !== id));
  }

  function refreshOperationNotice(id: number) {
    const notice = operationNotices.find((candidate) => candidate.id === id);
    if (!notice?.refreshDirectory || !canWrite) return;
    setPendingNoticeRefresh({ id, directory: notice.refreshDirectory });
    refreshAfterMutation(notice.refreshDirectory);
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
  const modalOpen = Boolean(
    uploadFiles || mkdirOpen || renameEntry || deleteEntry || editorDocument,
  );
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
        active={active}
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
  const uploadSizes = uploadFiles?.map((file) => file.size) ?? [];
  const uploadTotal = uploadSizes.reduce((total, size) => total + size, 0);
  const uploadWarning = uploadFiles !== null
    && uploadBatchNeedsConfirmation(uploadSizes);
  const uploadTarget = uploadDirectory ?? path;
  const uploadFailureRetryable = uploadOutcome?.status === 'failed_rolled_back'
    ? uploadOutcome.error?.retryable === true
    : uploadError !== null
      ? uploadErrorRetryable
      : null;
  const operationBanners = operationNotices.length > 0
    ? operationNotices.map((notice) => (
      <OperationNoticeBanner
        canRefresh={canWrite}
        key={notice.id}
        notice={notice}
        onCleanup={notice.cleanup && connection?.serverId === notice.cleanup.serverId ? () => {
          setDeleteEntry(notice.cleanup!.entry);
          setDeleteWarning(notice.cleanup!.warning);
          setDeleteError(null);
          setDeleteNoticeId(notice.id);
        } : undefined}
        onDismiss={() => dismissOperationNotice(notice.id)}
        onRefresh={() => refreshOperationNotice(notice.id)}
      />
    ))
    : null;
  const actionDialogs = (
    <>
      {uploadFiles ? (
        <FileDialog
          active={active}
          busy={uploadBusy}
          footer={(
            <>
              <button
                className="h-8 border border-hairline px-4 text-[11px] font-medium text-ink hover:bg-paper disabled:opacity-40"
                disabled={uploadBusy}
                onClick={closeUploadDialog}
                type="button"
              >
                取消
              </button>
              {uploadOutcome?.status === 'failed_with_residue' ? (
                <button
                  className="h-8 bg-ink px-4 text-[11px] font-medium text-paper disabled:opacity-40"
                  disabled={!canWrite}
                  onClick={() => {
                    if (uploadResidueNoticeId.current !== null) {
                      setPendingNoticeRefresh({
                        id: uploadResidueNoticeId.current,
                        directory: uploadTarget,
                      });
                    }
                    refreshAfterMutation(uploadTarget);
                    setUploadFiles(null);
                    setUploadDirectory(null);
                    setUploadError(null);
                    setUploadErrorRetryable(false);
                    setUploadOutcome(null);
                  }}
                  type="button"
                >
                  {canWrite ? '刷新目录' : '重连后刷新'}
                </button>
              ) : uploadFailureRetryable === false ? (
                <button
                  className="h-8 bg-ink px-4 text-[11px] font-medium text-paper"
                  onClick={closeUploadDialog}
                  type="button"
                >
                  关闭
                </button>
              ) : (
                <button
                  className="h-8 bg-ink px-4 text-[11px] font-medium text-paper disabled:opacity-40"
                  disabled={uploadBusy || !canWrite}
                  onClick={() => void submitUpload()}
                  type="button"
                >
                  {uploadBusy
                    ? '上传中…'
                    : !canWrite
                      ? uploadFailureRetryable === null
                        ? '重连后上传'
                        : '重连后可重试'
                      : uploadFailureRetryable !== null
                      ? '重试上传'
                      : '确认上传'}
                </button>
              )}
            </>
          )}
          onCancel={closeUploadDialog}
          title={`上传文件到 ${uploadTarget}`}
        >
          <ul
            aria-label="待上传文件"
            className="m-0 max-h-44 list-none overflow-auto border-y border-hairline p-0"
          >
            {uploadFiles.map((file) => (
              <li
                className="flex h-8 items-center justify-between gap-4 border-b border-hairline/70 px-2 font-mono text-[10px] last:border-b-0"
                key={`${file.name}-${file.lastModified}-${file.size}`}
              >
                <span className="truncate text-ink">{file.name}</span>
                <span className="shrink-0 text-muted">{formatFileSize(file.size)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 font-mono text-[10px] text-muted">
            {uploadFiles.length} 个文件 · {formatFileSize(uploadTotal)}
          </p>
          {uploadWarning ? (
            <p className="mt-3 border-l-2 border-warning pl-2 text-[10px] leading-5 text-warning">
              单文件或批次总计超过 4 MiB。上传会占用较多内存与 IPC，请确认网络稳定后再继续。
            </p>
          ) : null}
          <p className="mt-3 text-[10px] leading-5 text-muted">
            上传使用同目录临时文件与 hardlink 原子提交，目标已存在时不会覆盖。
          </p>
          {uploadOutcome?.residual.length ? (
            <div className="mt-3 border-l-2 border-danger pl-2">
              <p className="text-[10px] font-medium text-danger">残留路径</p>
              <ul className="m-0 mt-1 list-none p-0 font-mono text-[10px] text-ink">
                {uploadOutcome.residual.map((residual) => (
                  <li className="break-all" key={residual}>{residual}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {uploadError ? (
            <p className="mt-3 text-[11px] leading-5 text-danger" role="alert">
              {uploadError}
            </p>
          ) : null}
        </FileDialog>
      ) : null}

      {mkdirOpen ? (
        <FileDialog
          active={active}
          busy={mkdirBusy}
          footer={(
            <>
              <button
                className="h-8 border border-hairline px-4 text-[11px] font-medium text-ink hover:bg-paper disabled:opacity-40"
                disabled={mkdirBusy}
                onClick={closeMkdirDialog}
                type="button"
              >
                取消
              </button>
              <button
                className="h-8 bg-ink px-4 text-[11px] font-medium text-paper disabled:opacity-40"
                disabled={mkdirBusy || !canWrite}
                onClick={() => void submitMkdir()}
                type="button"
              >
                {mkdirBusy
                  ? '创建中…'
                  : !canWrite
                    ? '重连后创建'
                    : '创建文件夹'}
              </button>
            </>
          )}
          onCancel={closeMkdirDialog}
          title="新建文件夹"
        >
          <label
            className="block font-mono text-[9px] tracking-[0.12em] text-muted"
            htmlFor="harbor-mkdir-name"
          >
            文件夹名称
          </label>
          <input
            autoFocus
            className="mt-2 h-8 w-full border border-hairline bg-paper px-2 font-mono text-[11px] text-ink outline-none focus:border-accent"
            id="harbor-mkdir-name"
            onChange={(event) => setMkdirName(event.currentTarget.value)}
            value={mkdirName}
          />
          <p className="mt-2 text-[10px] leading-5 text-muted">
            将在 {mkdirDirectory ?? path} 下创建单层目录；不会自动创建缺失的父目录。
          </p>
          {mkdirError ? (
            <p className="mt-3 text-[11px] leading-5 text-danger" role="alert">
              {mkdirError}
            </p>
          ) : null}
        </FileDialog>
      ) : null}

      {renameEntry ? (
        <FileDialog
          active={active}
          busy={renameBusy}
          footer={renameOutcome?.status === 'partial' ? (
            <>
              <button
                className="h-8 border border-hairline px-4 text-[11px] font-medium text-ink hover:bg-paper"
                onClick={closeRenameDialog}
                type="button"
              >
                关闭
              </button>
              {renameOutcome.targetCreated ? (
                <button
                  className="h-8 bg-danger px-4 text-[11px] font-medium text-paper disabled:opacity-40"
                  disabled={!canWrite}
                  onClick={startRenameCleanup}
                  type="button"
                >
                  {canWrite ? '删除源文件…' : '重连后清理'}
                </button>
              ) : (
                <button
                  className="h-8 bg-ink px-4 text-[11px] font-medium text-paper disabled:opacity-40"
                  disabled={!canWrite}
                  onClick={() => {
                    const sourcePath = renameOutcome.sourcePath;
                    const parent = sourcePath.includes('/')
                      ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) || '/'
                      : '/';
                    refreshAfterMutation(parent);
                    closeRenameDialog();
                  }}
                  type="button"
                >
                  {canWrite ? '刷新目录核对' : '重连后刷新'}
                </button>
              )}
            </>
          ) : (
            <>
              <button
                className="h-8 border border-hairline px-4 text-[11px] font-medium text-ink hover:bg-paper disabled:opacity-40"
                disabled={renameBusy}
                onClick={closeRenameDialog}
                type="button"
              >
                取消
              </button>
              <button
                className="h-8 bg-ink px-4 text-[11px] font-medium text-paper disabled:opacity-40"
                disabled={
                  renameBusy
                  || renameEntry.kind === 'directory'
                  || !canWrite
                }
                onClick={() => void submitRename()}
                type="button"
              >
                {renameBusy
                  ? '重命名中…'
                  : !canWrite
                    ? '重连后重命名'
                    : '确认重命名'}
              </button>
            </>
          )}
          onCancel={closeRenameDialog}
          title={`重命名 ${renameEntry.name}`}
        >
          <p className="mb-3 break-all font-mono text-[10px] text-muted">
            {renameEntry.path}
          </p>
          <label
            className="block font-mono text-[9px] tracking-[0.12em] text-muted"
            htmlFor="harbor-rename-name"
          >
            新名称
          </label>
          <input
            autoFocus
            className="mt-2 h-8 w-full border border-hairline bg-paper px-2 font-mono text-[11px] text-ink outline-none focus:border-accent"
            id="harbor-rename-name"
            onChange={(event) => setRenameName(event.currentTarget.value)}
            value={renameName}
          />
          {renameEntry.kind === 'directory' ? (
            <p className="mt-3 border-l-2 border-warning pl-2 text-[10px] leading-5 text-warning">
              目录重命名当前 fail closed：没有经过验证的原子 no-replace 原语，不会退化为
              check-then-act。
            </p>
          ) : null}
          {renameOutcome?.status === 'partial' ? (
            <div className="mt-3 border-y border-hairline py-2">
              <p className="font-mono text-[9px] tracking-[0.12em] text-muted">
                {renameOutcome.targetCreated ? '已创建目标' : '目标状态未确认'}
              </p>
              <p className="mt-1 break-all font-mono text-[10px] text-ink">
                {renameOutcome.targetPath}
              </p>
              {!renameOutcome.targetCreated ? (
                <p className="mt-2 text-[10px] leading-5 text-warning">
                  无法确认目标是否由本次操作创建，已禁用源文件删除。请刷新目录核对。
                </p>
              ) : null}
            </div>
          ) : null}
          {renameError ? (
            <p className="mt-3 text-[11px] leading-5 text-danger" role="alert">
              {renameError}
            </p>
          ) : null}
        </FileDialog>
      ) : null}

      {deleteEntry ? (
        <ConfirmDialog
          active={active}
          busy={deleteBusy}
          busyLabel="正在删除…"
          confirmLabel="确认删除"
          confirmDisabled={!canWrite}
          description={(
            <>
              将删除{' '}
              <strong className="break-all font-medium text-ink">{deleteEntry.path}</strong>
              {deleteEntry.kind === 'directory'
                ? '。Harbor 只删除空目录，不会递归删除其中的内容。'
                : deleteEntry.kind === 'symlink'
                  ? '。只会删除符号链接本身，不会跟随或删除目标。'
                  : '。此操作无法撤销。'}
              {deleteWarning ? (
                <>
                  <br />
                  <span className="mt-2 block text-[10px] leading-5 text-warning">
                    本次清理来源：{deleteWarning}
                  </span>
                </>
              ) : null}
            </>
          )}
          error={deleteError ?? (!canWrite ? '连接已断开，重连后可重试删除。' : null)}
          onCancel={closeDeleteDialog}
          onConfirm={() => void submitDelete()}
          title={deleteEntry.kind === 'directory' ? '删除目录' : '删除文件'}
        />
      ) : null}
    </>
  );

  if (offline) {
    return (
      <>
        <div
          className="flex min-h-0 flex-1 flex-col"
          inert={modalOpen}
        >
          {operationBanners}
          <FileStatePanel
            actionLabel="重新连接服务器"
            description="文件浏览需要一条可用的 SFTP 通道。连接恢复后会从根目录重新读取；编辑器中的草稿不会被关闭。"
            icon={<ServerOff aria-hidden className="size-5" strokeWidth={1.5} />}
            onAction={onReconnect}
            title="服务器连接已断开"
          />
        </div>
        {editorModal}
        {actionDialogs}
      </>
    );
  }

  if (connecting) {
    return (
      <>
        <div
          className="flex min-h-0 flex-1 flex-col"
          inert={modalOpen}
        >
          {operationBanners}
          <FileStatePanel
            description="SSH 连接建立后，文件视图才会按需打开 SFTP 会话。"
            eyebrow="FILE VIEW / CONNECTING"
            icon={<RefreshCw aria-hidden className="size-5 animate-pulse" strokeWidth={1.5} />}
            title="正在建立 SSH 连接"
          />
        </div>
        {editorModal}
        {actionDialogs}
      </>
    );
  }

  return (
    <>
      <div
        className="flex min-h-0 flex-1 flex-col"
        inert={modalOpen}
      >
      {operationBanners}
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
          <input
            aria-label="选择上传文件"
            className="sr-only"
            multiple
            onChange={selectUploadFiles}
            ref={uploadInputRef}
            tabIndex={-1}
            type="file"
          />
          <button
            className="inline-flex h-7 shrink-0 items-center gap-1.5 border border-hairline bg-paper px-2 text-[10px] font-medium text-ink hover:border-ink disabled:opacity-40"
            disabled={listState !== 'ready'}
            onClick={() => uploadInputRef.current?.click()}
            type="button"
          >
            <Upload aria-hidden className="size-3.5" strokeWidth={1.5} />
            上传
          </button>
          <button
            className="inline-flex h-7 shrink-0 items-center gap-1.5 border border-hairline bg-paper px-2 text-[10px] font-medium text-ink hover:border-ink disabled:opacity-40"
            disabled={listState !== 'ready'}
            onClick={openMkdirDialog}
            type="button"
          >
            <Plus aria-hidden className="size-3.5" strokeWidth={1.5} />
            新建文件夹
          </button>
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
                  onClick={openMkdirDialog}
                  type="button"
                >
                  新建文件夹
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
                  <th className="w-[40%] px-3 font-normal">名称</th>
                  <th className="w-[12%] px-2 text-right font-normal">大小</th>
                  <th className="w-[20%] px-2 font-normal">修改时间</th>
                  <th className="w-[10%] px-2 font-normal">权限</th>
                  <th className="w-[18%] px-2 text-right font-normal">操作</th>
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
                        <span className="inline-flex items-center justify-end gap-0.5">
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
                          {entry.kind === 'file' || entry.kind === 'directory' ? (
                            <button
                              aria-label={`重命名 ${entry.name}`}
                              className="grid size-7 place-items-center text-muted hover:bg-paper hover:text-ink"
                              onClick={() => openRenameDialog(entry)}
                              title="重命名"
                              type="button"
                            >
                              <Pencil aria-hidden className="size-3.5" strokeWidth={1.5} />
                            </button>
                          ) : null}
                          <button
                            aria-label={`删除 ${entry.name}`}
                            className="grid size-7 place-items-center text-muted hover:bg-paper hover:text-danger"
                            onClick={() => requestDelete(entry)}
                            title="删除"
                            type="button"
                          >
                            <Trash2 aria-hidden className="size-3.5" strokeWidth={1.5} />
                          </button>
                        </span>
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
      </div>
      {editorModal}
      {actionDialogs}
    </>
  );
}

function OperationNoticeBanner({
  canRefresh,
  notice,
  onCleanup,
  onDismiss,
  onRefresh,
}: {
  canRefresh: boolean;
  notice: OperationNotice;
  onCleanup?(): void;
  onDismiss(): void;
  onRefresh(): void;
}) {
  const tone = notice.kind === 'error'
    ? 'border-danger/40 bg-[#F4E9E5] text-danger'
    : notice.kind === 'warning'
      ? 'border-warning/40 bg-[#F4EDE0] text-warning'
      : 'border-success/30 bg-[#EDF2EC] text-success';
  return (
    <section
      className={`shrink-0 border-b px-4 py-2 ${tone}`}
      role={notice.kind === 'info' ? 'status' : 'alert'}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[9px] tracking-[0.14em]">
            PREVIOUS CONNECTION / WRITE RESULT
          </p>
          <p className="mt-1 text-[10px] leading-5">{notice.text}</p>
          {notice.residual.length > 0 ? (
            <ul className="m-0 mt-1 list-none p-0 font-mono text-[10px] leading-5 text-ink">
              {notice.residual.map((path) => (
                <li className="break-all" key={path}>{path}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onCleanup ? (
            <button
              className="h-7 border border-current px-2 text-[10px] font-medium hover:bg-paper disabled:opacity-40"
              disabled={!canRefresh}
              onClick={onCleanup}
              type="button"
            >
              {canRefresh ? '清理源文件…' : '重连后清理'}
            </button>
          ) : null}
          {notice.refreshDirectory ? (
            <button
              className="h-7 border border-current px-2 text-[10px] font-medium hover:bg-paper disabled:opacity-40"
              disabled={!canRefresh}
              onClick={onRefresh}
              type="button"
            >
              {canRefresh ? '刷新目录' : '重连后刷新'}
            </button>
          ) : null}
          <button
            className="h-7 border border-current px-2 text-[10px] font-medium hover:bg-paper"
            onClick={onDismiss}
            type="button"
          >
            关闭
          </button>
        </div>
      </div>
    </section>
  );
}

function FileDialog({
  active,
  busy,
  children,
  footer,
  onCancel,
  title,
}: {
  active: boolean;
  busy: boolean;
  children: ReactNode;
  footer: ReactNode;
  onCancel(): void;
  title: string;
}) {
  const titleId = useId();
  const sectionRef = useRef<HTMLElement>(null);

  useDialogFocusTrap(sectionRef, {
    active,
    canEscape: !busy,
    onEscape: onCancel,
  });

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy && active) onCancel();
      }}
    >
      <section
        aria-busy={busy}
        aria-labelledby={titleId}
        aria-modal="true"
        className="w-[460px] border border-ink bg-shell outline-none"
        ref={sectionRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="flex items-start gap-3 border-b border-hairline px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[9px] tracking-[0.16em] text-muted">
              FILE OPERATION
            </p>
            <h2
              className="mt-1 break-all text-[18px] font-semibold tracking-[-0.01em] text-ink"
              id={titleId}
            >
              {title}
            </h2>
          </div>
          <button
            aria-label="关闭对话框"
            className="grid size-7 shrink-0 place-items-center text-muted hover:bg-paper hover:text-ink disabled:opacity-40"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            <X aria-hidden className="size-4" strokeWidth={1.5} />
          </button>
        </header>
        <div className="px-5 py-4">{children}</div>
        <footer className="flex justify-end gap-2 border-t border-hairline px-5 py-3">
          {footer}
        </footer>
      </section>
    </div>
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
        {children.length > 0 || treeChildren[directory] === undefined ? (
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
  eyebrow = 'FILE VIEW / OFFLINE',
  icon,
  onAction,
  title,
}: {
  actionLabel?: string;
  description: string;
  eyebrow?: string;
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
          {eyebrow}
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

function isRetryableError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'retryable' in error
    && error.retryable === true;
}

async function readFileBytes(file: File): Promise<number[]> {
  if (typeof file.arrayBuffer === 'function') {
    return Array.from(new Uint8Array(await file.arrayBuffer()));
  }
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('无法读取本地文件'));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error('无法读取本地文件'));
      }
    };
    reader.readAsArrayBuffer(file);
  });
  return Array.from(new Uint8Array(buffer));
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
