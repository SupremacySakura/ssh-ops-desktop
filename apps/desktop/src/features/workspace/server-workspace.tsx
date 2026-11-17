import type {
  HostKeyChangedPrompt,
  HostKeyPrompt,
  Server,
} from '@opspilot/contracts';
import { RemoteDirectoryPathSchema } from '@opspilot/contracts';
import {
  AlertTriangle,
  Pencil,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { ConfirmDialog } from '../../components/confirm-dialog';
import { formatLastConnectedAt, useHarborStore } from '../../store/harbor-store';
import {
  connectionErrorMessage,
  useTerminalStore,
} from '../../store/terminal-store';
import { FileBrowser } from '../files/file-browser';
import type { FileJumpRequest } from '../files/file-browser';
import {
  MonitorPanel,
  MonitorTopbarGauges,
} from '../monitor/monitor-panel';
import { useMonitorSampling } from '../monitor/use-monitor-sampling';
import { DockerPane } from '../docker/docker-pane';
import { TerminalPane } from '../terminal/terminal-pane';

interface ServerWorkspaceProps {
  active: boolean;
  server: Server;
}

type WorkspaceTab = 'terminal' | 'files' | 'monitor' | 'docker';

export function ServerWorkspace({ active, server }: ServerWorkspaceProps) {
  const canonicalServer = useHarborStore((state) => (
    state.servers.find((candidate) => candidate.id === server.id) ?? server
  ));
  const groups = useHarborStore((state) => state.groups);
  const catalogBusy = useHarborStore((state) => state.catalogBusy);
  const catalogError = useHarborStore((state) => state.catalogError);
  const openEditServer = useHarborStore((state) => state.openEditServer);
  const deleteServer = useHarborStore((state) => state.deleteServer);
  const runtime = useTerminalStore((state) => state.runtimes[server.id]);
  const eventBridgeStatus = useTerminalStore((state) => state.eventBridgeStatus);
  const ensureConnected = useTerminalStore((state) => state.ensureConnected);
  const retryServer = useTerminalStore((state) => state.retryServer);
  const trustHostKey = useTerminalStore((state) => state.trustHostKey);
  const dismissHostKey = useTerminalStore((state) => state.dismissHostKey);
  const core = useTerminalStore((state) => state.core);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [trustChecked, setTrustChecked] = useState(false);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('terminal');
  const [jumpRequest, setJumpRequest] = useState<FileJumpRequest | null>(null);
  const jumpSequence = useRef(0);
  const trustCheckboxId = useId();
  const group = canonicalServer.groupId
    ? groups.find((candidate) => candidate.id === canonicalServer.groupId)
    : null;
  const connectionStatus = runtime?.status ?? 'idle';
  const prompt = runtime?.hostKeyPrompt ?? null;
  const changedPrompt = runtime?.hostKeyChangedPrompt ?? null;
  const credentialPending = canonicalServer.secretRef === null;
  const fileConnectionStatus = connectionStatus === 'ready' && runtime?.connection
    ? 'ready'
    : connectionStatus === 'idle' || connectionStatus === 'connecting'
      ? 'connecting'
      : 'closed';

  function jumpToFiles(cwd: string | null) {
    const parsed = cwd === null
      ? null
      : RemoteDirectoryPathSchema.safeParse(cwd);
    jumpSequence.current += 1;
    setJumpRequest({
      nonce: jumpSequence.current,
      path: parsed?.success ? parsed.data : '/',
      notice: parsed?.success ? undefined : '无法确定终端当前目录，已打开根目录',
    });
    setActiveTab('files');
  }

  useMonitorSampling({
    active: active && !credentialPending,
    connection: runtime?.connection,
    serverId: canonicalServer.id,
    status: connectionStatus,
  });

  useEffect(() => {
    if (eventBridgeStatus !== 'ready') return;
    void ensureConnected(canonicalServer);
  }, [
    canonicalServer,
    canonicalServer.authType,
    canonicalServer.host,
    canonicalServer.id,
    canonicalServer.port,
    canonicalServer.secretRef,
    canonicalServer.user,
    credentialPending,
    ensureConnected,
    eventBridgeStatus,
  ]);

  useEffect(() => {
    const verificationId = prompt?.verificationId ?? changedPrompt?.verificationId;
    if (verificationId) setTrustChecked(false);
  }, [changedPrompt?.verificationId, prompt?.verificationId]);

  return (
    <>
      <main className="flex h-dvh min-w-0 flex-1 overflow-hidden">
        <div className="hidden w-[30px] shrink-0 items-center justify-center border-r border-hairline bg-[#E2DED6] xl:flex">
          <span className="font-mono text-[10px] tracking-[0.18em] text-muted [writing-mode:vertical-rl]">
            {canonicalServer.name.toLocaleUpperCase('en-US')} · {statusLabel(connectionStatus, credentialPending)}
          </span>
        </div>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex h-24 shrink-0 items-center justify-between border-b border-hairline px-6">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={`size-1.5 ${
                    connectionStatus === 'ready' ? 'bg-success' : 'bg-accent'
                  }`}
                />
                <p className="font-mono text-[10px] tracking-[0.14em] text-muted">
                  {group?.name ?? '未分组'} / {statusLabel(connectionStatus, credentialPending)}
                </p>
              </div>
              <h2 className="mt-1.5 truncate text-[22px] font-semibold leading-7 tracking-[-0.01em] text-ink">
                {canonicalServer.name}
              </h2>
              <p className="mt-1 font-mono text-[10px] text-muted">
                {canonicalServer.user}@{canonicalServer.host}:{canonicalServer.port}
                {' · '}
                {canonicalServer.authType === 'key' ? '私钥认证' : '密码认证'}
                {' · '}
                {formatLastConnectedAt(canonicalServer.lastConnectedAt)}
              </p>
            </div>

            <div className="ml-5 flex shrink-0 items-center gap-4">
              <MonitorTopbarGauges
                connectionId={runtime?.connection?.connectionId ?? null}
                serverId={canonicalServer.id}
              />
              <div className="flex items-center gap-1.5">
                <button
                  aria-label="编辑服务器"
                  className="inline-flex h-8 items-center gap-1.5 border border-hairline bg-paper px-2.5 text-[11px] font-medium text-ink hover:border-ink disabled:opacity-40"
                  disabled={catalogBusy}
                  onClick={() => openEditServer(canonicalServer.id)}
                  type="button"
                >
                  <Pencil aria-hidden className="size-3.5" strokeWidth={1.5} />
                  编辑
                </button>
                <button
                  aria-label="删除服务器"
                  className="inline-flex h-8 items-center gap-1.5 border border-hairline bg-transparent px-2.5 text-[11px] font-medium text-danger hover:border-danger disabled:opacity-40"
                  disabled={catalogBusy}
                  onClick={() => {
                    setDeleteError(null);
                    setConfirmingDelete(true);
                  }}
                  type="button"
                >
                  <Trash2 aria-hidden className="size-3.5" strokeWidth={1.5} />
                  删除
                </button>
              </div>
            </div>
          </header>

          <nav aria-label="服务器工作区视图" className="flex h-8 shrink-0 items-stretch border-b border-hairline bg-shell px-6">
            {[
              { key: 'terminal' as const, label: '终端', hint: 'SSH 终端' },
              { key: 'files' as const, label: '文件', hint: 'SFTP 浏览与在线编辑' },
              { key: 'monitor' as const, label: '监控', hint: '系统监控' },
              { key: 'docker' as const, label: 'Docker', hint: 'Docker 容器' },
            ].map((tab) => (
              <button
                aria-current={activeTab === tab.key ? 'page' : undefined}
                className={`border-x border-transparent px-4 text-[11px] tracking-[0.06em] ${
                  activeTab === tab.key
                    ? 'bg-ink text-paper'
                    : tab.key
                      ? 'text-muted hover:bg-paper hover:text-ink'
                      : 'text-muted opacity-45'
                }`}
                disabled={tab.key === null}
                key={tab.label}
                onClick={() => {
                  if (tab.key) setActiveTab(tab.key);
                }}
                title={tab.hint}
                type="button"
              >
                {tab.label}
              </button>
            ))}
          </nav>

          {credentialPending ? (
            <PendingCredentialPanel
              onEdit={() => openEditServer(canonicalServer.id)}
              server={canonicalServer}
            />
          ) : (
            <>
              <div
                className={
                  activeTab === 'terminal'
                    ? 'flex min-h-0 flex-1 flex-col'
                    : 'hidden'
                }
              >
                <TerminalPane
                  onJumpToFiles={jumpToFiles}
                  server={canonicalServer}
                  workspaceActive={active && activeTab === 'terminal'}
                />
              </div>
              <div
                className={
                  activeTab === 'files'
                    ? 'flex min-h-0 flex-1 flex-col'
                    : 'hidden'
                }
              >
                {core ? (
                  <FileBrowser
                    active={active && activeTab === 'files'}
                    connection={runtime?.connection ?? null}
                    connectionStatus={fileConnectionStatus}
                    core={core}
                    jumpRequest={jumpRequest}
                    onReconnect={() => void retryServer(canonicalServer.id)}
                  />
                ) : (
                  <div className="grid min-h-0 flex-1 place-items-center bg-paper px-8">
                    <p className="font-mono text-[10px] text-muted">
                      正在连接 Core，文件视图暂不可用。
                    </p>
                  </div>
                )}
              </div>
              <div className={activeTab === 'docker' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
                <DockerPane
                  active={active && activeTab === 'docker'}
                  onExecOpened={() => setActiveTab('terminal')}
                  server={canonicalServer}
                />
              </div>
              {activeTab === 'monitor' ? (
                <MonitorPanel
                  connectionId={runtime?.connection?.connectionId ?? null}
                  connectionStatus={connectionStatus}
                  serverId={canonicalServer.id}
                />
              ) : null}
            </>
          )}
        </section>
      </main>

      {prompt || changedPrompt ? (
        <HostKeyDialog
          checked={trustChecked}
          checkboxId={trustCheckboxId}
          onCancel={() => dismissHostKey(server.id)}
          onCheckedChange={setTrustChecked}
          onTrust={() => void trustHostKey(server.id)}
          prompt={prompt ?? (changedPrompt as HostKeyChangedPrompt)}
          server={canonicalServer}
        />
      ) : null}

      {confirmingDelete ? (
        <ConfirmDialog
          active={active}
          busy={catalogBusy || deleting}
          busyLabel="正在删除…"
          confirmLabel="确认删除"
          description={
            <>
              将从 Harbor 删除{' '}
              <strong className="font-medium text-ink">{canonicalServer.name}</strong>
              （{canonicalServer.user}@{canonicalServer.host}:{canonicalServer.port}）。
              当前 SSH 连接、终端会话与系统凭据库中的对应凭据也会一并关闭和清理，此操作无法撤销。
            </>
          }
          error={deleteError ?? catalogError}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setDeleteError(null);
            setDeleting(true);
            void useTerminalStore.getState()
              .disposeServer(canonicalServer.id)
              .then(() => deleteServer(canonicalServer.id))
              .then((deleted) => {
                if (deleted) setConfirmingDelete(false);
              })
              .catch((error: unknown) => {
                setDeleteError(connectionErrorMessage(error));
              })
              .finally(() => setDeleting(false));
          }}
          title="删除服务器？"
        />
      ) : null}
    </>
  );
}

function HostKeyDialog({
  checked,
  checkboxId,
  onCancel,
  onCheckedChange,
  onTrust,
  prompt,
  server,
}: {
  checked: boolean;
  checkboxId: string;
  onCancel(): void;
  onCheckedChange(checked: boolean): void;
  onTrust(): void;
  prompt: HostKeyPrompt | HostKeyChangedPrompt;
  server: Server;
}) {
  const changed = 'expectedSha256' in prompt;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/45 p-6">
      <section
        aria-labelledby="host-key-title"
        aria-modal="true"
        className="w-[560px] border border-ink bg-shell"
        role="dialog"
      >
        <header className="flex items-start gap-3 border-b border-hairline px-5 py-4">
          <span className="grid size-9 shrink-0 place-items-center border border-accent text-accent">
            <ShieldCheck aria-hidden className="size-4" strokeWidth={1.5} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[9px] tracking-[0.16em] text-accent">
              HOST IDENTITY / {changed ? 'CHANGED' : 'FIRST CONTACT'}
            </p>
            <h2 className="mt-1 text-[20px] font-semibold tracking-[-0.01em] text-ink" id="host-key-title">
              {changed ? '主机指纹已变化，重新核对' : '首次连接，核对主机指纹'}
            </h2>
          </div>
          <button
            aria-label="取消主机指纹确认"
            className="grid size-7 place-items-center text-muted hover:bg-paper hover:text-ink"
            onClick={onCancel}
            type="button"
          >
            <X aria-hidden className="size-4" strokeWidth={1.5} />
          </button>
        </header>

        <div className="px-5 py-4">
          <div className="border border-hairline bg-paper px-3.5 py-3 font-mono text-[11px] text-ink">
            <p className="text-[9px] tracking-[0.14em] text-muted">SSH ENDPOINT</p>
            <p className="mt-1">
              {server.user}@{server.host}:{server.port}
            </p>
          </div>
          <dl className="mt-3 grid grid-cols-[92px_1fr] gap-x-3 gap-y-2 border-y border-hairline py-3 font-mono text-[10px]">
            {changed ? (
              <>
                <dt className="text-muted">已信任</dt>
                <dd className="break-all text-muted line-through">
                  {prompt.expectedSha256}
                </dd>
                <dt className="text-muted">当前</dt>
                <dd className="break-all font-semibold text-danger">
                  {prompt.actualSha256}
                </dd>
              </>
            ) : (
              <>
                <dt className="text-muted">算法</dt>
                <dd className="truncate text-ink">{prompt.algorithm}</dd>
                <dt className="text-muted">SHA-256</dt>
                <dd className="break-all text-ink">{prompt.sha256}</dd>
              </>
            )}
            <dt className="text-muted">确认期限</dt>
            <dd className="text-ink">{formatPromptExpiry(prompt.expiresAt)}</dd>
          </dl>
          <div className="mt-3 flex gap-2 border-l-2 border-warning bg-paper px-3 py-2">
            <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" strokeWidth={1.5} />
            <p className="text-[10px] leading-4 text-muted">
              {changed
                ? '已记录的指纹与服务器当前身份不一致，连接保持阻断。只有确认服务器确实更换过密钥后，才可显式替换信任。'
                : '未知指纹不会自动信任。请通过云控制台、服务器本地终端或管理员提供的独立渠道核对指纹。'}
            </p>
          </div>
          <label
            className="mt-4 flex cursor-pointer items-start gap-2 border border-hairline bg-paper px-3 py-2.5 text-[11px] leading-5 text-ink"
            htmlFor={checkboxId}
          >
            <input
              checked={checked}
              className="mt-1 accent-accent"
              id={checkboxId}
              onChange={(event) => onCheckedChange(event.target.checked)}
              type="checkbox"
            />
            {changed
              ? '我已确认服务器密钥确实发生变更，并核对了当前 SHA-256 指纹。'
              : '我已通过独立渠道核对上述 SHA-256 主机指纹。'}
          </label>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-hairline px-5 py-3">
          <button
            className="h-8 border border-hairline px-4 text-[11px] font-medium text-ink hover:bg-paper"
            onClick={onCancel}
            type="button"
          >
            暂不连接
          </button>
          <button
            className="h-8 bg-ink px-4 text-[11px] font-medium text-paper disabled:opacity-40"
            disabled={!checked}
            onClick={onTrust}
            type="button"
          >
            {changed ? '确认变化并连接' : '信任并以 SSH 连接'}
          </button>
        </footer>
      </section>
    </div>
  );
}

function statusLabel(status: string, credentialPending = false): string {
  if (credentialPending) return '凭据待配置';
  switch (status) {
    case 'ready':
      return '连接正常';
    case 'connecting':
      return '连接中';
    case 'host-key':
      return '待验证指纹';
    case 'blocked':
      return '已阻断';
    case 'error':
      return '连接失败';
    case 'closed':
      return '已断开';
    default:
      return '待连接';
  }
}

function PendingCredentialPanel({
  onEdit,
  server,
}: {
  onEdit(): void;
  server: Server;
}) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center bg-shell px-8 py-10">
      <section className="w-full max-w-lg border-y border-hairline py-8">
        <p className="font-mono text-[9px] tracking-[0.18em] text-accent">
          AUTHENTICATION / PENDING
        </p>
        <h3 className="mt-3 text-[22px] font-semibold tracking-[-0.01em] text-ink">
          认证方式待配置
        </h3>
        <p className="mt-3 max-w-md text-[12px] leading-6 text-muted">
          {server.user}@{server.host}:{server.port} 尚未配置密码或私钥。
          Harbor 不会伪造占位凭据，也不会在凭据缺失时尝试连接。
        </p>
        <div className="mt-5 border border-hairline bg-paper px-3.5 py-3 font-mono text-[10px] leading-5 text-muted">
          补充凭据后，Harbor 只会把密码或私钥写入系统凭据库，
          服务器记录中仍只保存不可逆的凭据引用。
        </div>
        <button
          className="mt-5 inline-flex h-8 items-center gap-1.5 bg-ink px-4 text-[11px] font-medium text-paper hover:bg-accent"
          onClick={onEdit}
          type="button"
        >
          编辑并补充凭据
        </button>
      </section>
    </div>
  );
}

function formatPromptExpiry(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
