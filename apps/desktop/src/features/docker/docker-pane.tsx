import type {
  CoreError,
  DockerAction,
  DockerContainer,
  DockerShell,
  Server,
} from '@opspilot/contracts';
import {
  AlertTriangle,
  Boxes,
  Play,
  RefreshCw,
  RotateCw,
  ScrollText,
  Square,
  TerminalSquare,
  X,
} from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';

import { ConfirmDialog } from '../../components/confirm-dialog';
import {
  dockerErrorMessage,
  useDockerStore,
  type DockerLogsState,
} from '../../store/docker-store';
import { useTerminalStore } from '../../store/terminal-store';

interface DockerPaneProps {
  active: boolean;
  onExecOpened(): void;
  server: Server;
}

const DEFAULT_TAIL = 500;

export function DockerPane({ active, onExecOpened, server }: DockerPaneProps) {
  const runtime = useTerminalStore((state) => state.runtimes[server.id]);
  const retryServer = useTerminalStore((state) => state.retryServer);
  const openDockerSession = useTerminalStore((state) => state.openDockerSession);
  const docker = useDockerStore((state) => state.states[server.id]);
  const loadContainers = useDockerStore((state) => state.loadContainers);
  const runDockerAction = useDockerStore((state) => state.runDockerAction);
  const openLogs = useDockerStore((state) => state.openLogs);
  const closeLogs = useDockerStore((state) => state.closeLogs);
  const clearNotice = useDockerStore((state) => state.clearNotice);
  const [confirmation, setConfirmation] = useState<{
    action: Extract<DockerAction, 'stop' | 'restart'>;
    container: DockerContainer;
  } | null>(null);
  const [shellChoice, setShellChoice] = useState<DockerContainer | null>(null);
  const [execError, setExecError] = useState<CoreError | null>(null);
  const [execBusy, setExecBusy] = useState(false);

  const connection = runtime?.status === 'ready' ? runtime.connection : null;
  const actionBusy = docker?.action ?? null;
  const notice = docker?.notice ?? null;
  const actionError = docker?.actionError ?? null;

  useEffect(() => {
    if (!active || !connection) return;
    const current = useDockerStore.getState().states[server.id];
    if (
      current?.connectionId === connection.connectionId
      && current.status !== 'idle'
    ) {
      return;
    }
    void loadContainers(server.id, connection);
  }, [active, connection, loadContainers, server.id]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => clearNotice(server.id), 4_000);
    return () => window.clearTimeout(timer);
  }, [clearNotice, notice, server.id]);

  async function executeAction(
    container: DockerContainer,
    action: DockerAction,
  ) {
    if (!connection) return;
    await runDockerAction(server.id, connection, container, action);
    const current = useDockerStore.getState().states[server.id];
    if (current?.connectionId !== connection.connectionId) {
      setConfirmation(null);
      return;
    }
    if (!current.actionError) setConfirmation(null);
  }

  async function execContainer(container: DockerContainer, shell: DockerShell) {
    setExecBusy(true);
    setExecError(null);
    try {
      const result = await openDockerSession(server.id, container.id, shell);
      if (result.kind === 'opened') {
        setShellChoice(null);
        setExecError(null);
        onExecOpened();
        return;
      }
      if (result.error.code === 'DOCKER_SHELL_UNAVAILABLE') {
        setShellChoice(container);
      }
      setExecError(result.error);
    } finally {
      setExecBusy(false);
    }
  }

  const busyLabel = actionBusy?.action === 'stop'
    ? '正在停止…'
    : '正在重启…';

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-shell">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-hairline px-3">
        <span className="flex items-center gap-1.5 font-mono text-[9px] tracking-[0.14em] text-muted">
          <Boxes aria-hidden className="size-3.5" strokeWidth={1.5} />
          DOCKER / CONTAINERS
        </span>
        {notice ? (
          <p
            aria-live="polite"
            className="min-w-0 truncate border-l-2 border-success pl-2 font-mono text-[9px] text-success"
            role="status"
          >
            {notice}
          </p>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {execBusy ? (
            <span
              className="font-mono text-[9px] tracking-[0.08em] text-accent"
              role="status"
            >
              正在打开容器终端…
            </span>
          ) : null}
          {docker?.status === 'ready' && docker.containers.length > 0 ? (
            <button
              aria-label="刷新容器列表"
              className="inline-flex h-6 items-center gap-1 border border-hairline bg-paper px-2 text-[10px] text-ink hover:border-ink disabled:opacity-40"
              disabled={actionBusy !== null}
              onClick={() => {
                if (connection) {
                  void loadContainers(server.id, connection);
                }
              }}
              type="button"
            >
              <RefreshCw aria-hidden className="size-3" strokeWidth={1.5} />
              刷新
            </button>
          ) : null}
        </div>
      </div>

      {docker?.startedAtWarning ? (
        <p
          className="border-b border-warning/40 bg-[#F4EBDD] px-3 py-1.5 text-[10px] leading-4 text-warning"
          role="status"
        >
          启动时间读取失败，列表仍可操作：{docker.startedAtWarning}
        </p>
      ) : null}

      {actionError && confirmation === null ? (
        <p
          className="border-b border-danger/30 bg-[#F4E9E5] px-3 py-1.5 text-[10px] leading-4 text-danger"
          role="alert"
        >
          {dockerErrorMessage(actionError)}
        </p>
      ) : null}

      {execError && shellChoice === null ? (
        <p
          className="border-b border-danger/30 bg-[#F4E9E5] px-3 py-1.5 text-[10px] leading-4 text-danger"
          role="alert"
        >
          {dockerErrorMessage(execError)}
        </p>
      ) : null}

      {docker?.error && docker.containers.length > 0 ? (
        <div className="flex items-center gap-2 border-b border-warning/40 bg-[#F4EBDD] px-3 py-1.5">
          <p className="min-w-0 flex-1 text-[10px] leading-4 text-warning">
            {dockerErrorMessage(docker.error)}
          </p>
          <button
            className="inline-flex h-6 shrink-0 items-center gap-1 border border-warning px-2 text-[10px] text-warning hover:bg-paper"
            onClick={() => {
              if (connection) {
                void loadContainers(server.id, connection);
              }
            }}
            type="button"
          >
            <RefreshCw aria-hidden className="size-3" strokeWidth={1.5} />
            重试刷新
          </button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {!connection ? (
          <DockerOfflineState
            onReconnect={() => void retryServer(server.id)}
            runtimeError={runtime?.error ?? null}
            runtimeStatus={runtime?.status ?? 'idle'}
          />
        ) : docker === undefined || docker.status === 'idle' ? (
          <DockerLoadingState />
        ) : docker.status === 'loading' ? (
          <DockerLoadingState />
        ) : docker.error && docker.containers.length === 0 ? (
          docker.error.code === 'SSH_CONNECTION' ? (
            <DockerOfflineState
              onReconnect={() => void retryServer(server.id)}
              runtimeError={dockerErrorMessage(docker.error)}
              runtimeStatus="error"
            />
          ) : (
            <DockerErrorState
              message={dockerErrorMessage(docker.error)}
              onRetry={() => void loadContainers(server.id, connection)}
            />
          )
        ) : docker.containers.length === 0 ? (
          <DockerEmptyState
            onRefresh={() => void loadContainers(server.id, connection)}
          />
        ) : (
          <DockerTable
            actionBusy={actionBusy}
            containers={docker.containers}
            execBusy={execBusy}
            onAction={(container, action) => {
              if (action === 'start') {
                void executeAction(container, action);
                return;
              }
              setConfirmation({ action, container });
            }}
            onExec={(container) => void execContainer(container, 'sh')}
            onLogs={(container) => {
              void openLogs(server.id, connection, container, DEFAULT_TAIL);
            }}
          />
        )}
      </div>

      {docker?.logs ? (
        <DockerLogsDialog
          logs={docker.logs}
          onClose={() => closeLogs(server.id)}
          onTailChange={(tail) => {
            const container = docker.containers.find(
              (candidate) => candidate.id === docker.logs?.containerId,
            );
            if (container && connection) {
              void openLogs(server.id, connection, container, tail);
            }
          }}
        />
      ) : null}

      {confirmation ? (
        <ConfirmDialog
          active={active}
          busy={actionBusy?.containerId === confirmation.container.id
            && actionBusy.action === confirmation.action}
          busyLabel={busyLabel}
          confirmLabel={confirmation.action === 'stop' ? '确认停止' : '确认重启'}
          description={(
            <>
              将对容器{' '}
              <strong className="font-medium text-ink">
                {containerName(confirmation.container)}
              </strong>{' '}
              （<span className="break-all font-mono text-[10px]">{confirmation.container.id}</span>）
              执行{confirmation.action === 'stop' ? '停止' : '重启'}。
              {confirmation.action === 'stop'
                ? '容器内的进程会被终止。'
                : '容器内的进程会重新启动。'}
            </>
          )}
          error={actionError ? dockerErrorMessage(actionError) : null}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            void executeAction(confirmation.container, confirmation.action);
          }}
          title={confirmation.action === 'stop' ? '停止容器？' : '重启容器？'}
        />
      ) : null}

      {shellChoice ? (
        <DockerShellDialog
          busy={execBusy}
          container={shellChoice}
          error={execError ? dockerErrorMessage(execError) : null}
          onCancel={() => {
            setShellChoice(null);
            setExecError(null);
          }}
          onChoose={(shell) => void execContainer(shellChoice, shell)}
        />
      ) : null}
    </div>
  );
}

function DockerTable({
  actionBusy,
  containers,
  execBusy,
  onAction,
  onExec,
  onLogs,
}: {
  actionBusy: { action: DockerAction; containerId: string } | null;
  containers: DockerContainer[];
  execBusy: boolean;
  onAction(container: DockerContainer, action: DockerAction): void;
  onExec(container: DockerContainer): void;
  onLogs(container: DockerContainer): void;
}) {
  return (
    <table
      aria-label="Docker 容器"
      className="w-full table-fixed border-collapse text-left text-[11px]"
    >
      <thead className="sticky top-0 z-10 bg-[#E2DED6]">
        <tr className="border-b border-hairline">
          {[
            ['名称', 'w-[20%]'],
            ['镜像', 'w-[19%]'],
            ['状态', 'w-[10%]'],
            ['端口', 'w-[17%]'],
            ['启动时间', 'w-[15%]'],
            ['操作', 'w-[19%]'],
          ].map(([label, width]) => (
            <th
              className={`${width} px-3 py-2 font-mono text-[9px] font-normal tracking-[0.12em] text-muted`}
              key={label}
              scope="col"
            >
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {containers.map((container) => {
          const running = container.state === 'running';
          const busy = actionBusy !== null;
          const name = containerName(container);
          return (
            <tr className="border-b border-hairline align-top hover:bg-paper/60" key={container.id}>
              <td className="px-3 py-2.5">
                <span className="block truncate font-medium text-ink" title={name}>
                  {name}
                </span>
                <span
                  className="mt-0.5 block truncate font-mono text-[9px] text-muted"
                  title={container.id}
                >
                  {container.id.slice(0, 12)}
                </span>
              </td>
              <td className="px-3 py-2.5">
                <span className="block break-words font-mono text-[10px] leading-4 text-ink">
                  {container.image}
                </span>
              </td>
              <td className="px-3 py-2.5">
                <span className="inline-flex items-center gap-1.5 text-ink">
                  <span
                    aria-hidden
                    className={`size-1.5 shrink-0 ${running ? 'bg-success' : 'bg-muted'}`}
                  />
                  {containerStateLabel(container.state)}
                </span>
                <span className="mt-0.5 block truncate font-mono text-[9px] text-muted" title={container.status}>
                  {container.status}
                </span>
              </td>
              <td className="px-3 py-2.5">
                {container.ports.length === 0 ? (
                  <span className="text-muted">—</span>
                ) : (
                  <span className="block space-y-0.5 font-mono text-[9px] leading-4 text-ink">
                    {container.ports.map((port) => (
                      <span className="block break-all" key={port}>{port}</span>
                    ))}
                  </span>
                )}
              </td>
              <td className="px-3 py-2.5 font-mono text-[9px] leading-4 text-muted">
                {formatStartedAt(container.startedAt)}
              </td>
              <td className="px-3 py-2.5">
                <div className="flex flex-wrap gap-1">
                  <DockerActionButton
                    label={`查看 ${name} 日志`}
                    onClick={() => onLogs(container)}
                  >
                    <ScrollText aria-hidden className="size-3" strokeWidth={1.5} />
                    日志
                  </DockerActionButton>
                  <DockerActionButton
                    disabled={!running || execBusy}
                    label={`Exec ${name}`}
                    onClick={() => onExec(container)}
                  >
                    <TerminalSquare aria-hidden className="size-3" strokeWidth={1.5} />
                    Exec
                  </DockerActionButton>
                  <DockerActionButton
                    disabled={running || busy}
                    label={`启动 ${name}`}
                    onClick={() => onAction(container, 'start')}
                  >
                    <Play aria-hidden className="size-3" strokeWidth={1.5} />
                    {actionBusy?.containerId === container.id && actionBusy.action === 'start'
                      ? '启动中'
                      : '启动'}
                  </DockerActionButton>
                  <DockerActionButton
                    disabled={!running || busy}
                    label={`停止 ${name}`}
                    onClick={() => onAction(container, 'stop')}
                  >
                    <Square aria-hidden className="size-3" strokeWidth={1.5} />
                    {actionBusy?.containerId === container.id && actionBusy.action === 'stop'
                      ? '停止中'
                      : '停止'}
                  </DockerActionButton>
                  <DockerActionButton
                    disabled={busy}
                    label={`重启 ${name}`}
                    onClick={() => onAction(container, 'restart')}
                  >
                    <RotateCw aria-hidden className="size-3" strokeWidth={1.5} />
                    {actionBusy?.containerId === container.id && actionBusy.action === 'restart'
                      ? '重启中'
                      : '重启'}
                  </DockerActionButton>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function DockerActionButton({
  children,
  disabled = false,
  label,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  onClick(): void;
}) {
  return (
    <button
      aria-label={label}
      className="inline-flex h-6 items-center gap-1 border border-hairline bg-paper px-1.5 text-[9px] text-ink hover:border-ink disabled:opacity-35"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function DockerOfflineState({
  onReconnect,
  runtimeError,
  runtimeStatus,
}: {
  onReconnect(): void;
  runtimeError: string | null;
  runtimeStatus: string;
}) {
  if (runtimeStatus === 'host-key' || runtimeStatus === 'blocked') {
    return (
      <DockerStatePanel
        description="Docker 只会在 SSH 连接确认并信任主机指纹后读取。请先在终端视图完成主机校验。"
        eyebrow="DOCKER / HOST IDENTITY"
        title="等待主机指纹确认"
      />
    );
  }
  if (runtimeStatus === 'idle' || runtimeStatus === 'connecting') {
    return (
      <DockerStatePanel
        description="Docker 容器需要可用的 SSH 连接。连接完成后会自动读取容器列表。"
        eyebrow="DOCKER / CONNECTING"
        loading
        title="正在连接服务器"
      />
    );
  }
  return (
    <DockerStatePanel
      actionLabel="重新连接"
      description={runtimeError ?? 'SSH 连接已断开，请重新连接后再管理 Docker 容器。'}
      eyebrow="DOCKER / OFFLINE"
      onAction={onReconnect}
      title="服务器离线"
    />
  );
}

function DockerLoadingState() {
  return (
    <DockerStatePanel
      description="正在通过 SSH 读取容器列表与启动时间。"
      eyebrow="DOCKER / LOADING"
      loading
      title="正在读取容器列表…"
    />
  );
}

function DockerErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry(): void;
}) {
  return (
    <DockerStatePanel
      actionLabel="重试 Docker"
      description={message}
      eyebrow="DOCKER / UNAVAILABLE"
      onAction={onRetry}
      title="无法读取 Docker 容器"
    />
  );
}

function DockerEmptyState({ onRefresh }: { onRefresh(): void }) {
  return (
    <DockerStatePanel
      actionLabel="刷新容器"
      description="Docker 已连接，但此服务器还没有容器。创建容器后可在此刷新查看。"
      eyebrow="DOCKER / EMPTY"
      onAction={onRefresh}
      title="当前没有容器"
    />
  );
}

function DockerStatePanel({
  actionLabel,
  description,
  eyebrow,
  loading = false,
  onAction,
  title,
}: {
  actionLabel?: string;
  description: string;
  eyebrow: string;
  loading?: boolean;
  onAction?(): void;
  title: string;
}) {
  return (
    <div className="grid min-h-full place-items-center px-8 py-10">
      <section className="w-full max-w-lg border-y border-hairline py-8">
        <p className="font-mono text-[9px] tracking-[0.18em] text-accent">{eyebrow}</p>
        <h3 className="mt-3 text-[22px] font-semibold tracking-[-0.01em] text-ink">
          {title}
        </h3>
        <p className="mt-3 max-w-md text-[12px] leading-6 text-muted">{description}</p>
        {loading ? (
          <div className="mt-6 h-px overflow-hidden bg-hairline" aria-hidden>
            <span className="block h-full w-1/3 animate-pulse bg-accent" />
          </div>
        ) : null}
        {actionLabel && onAction ? (
          <button
            className="mt-5 inline-flex h-8 items-center gap-1.5 bg-ink px-4 text-[11px] font-medium text-paper hover:bg-accent"
            onClick={onAction}
            type="button"
          >
            <RefreshCw aria-hidden className="size-3.5" strokeWidth={1.5} />
            {actionLabel}
          </button>
        ) : null}
      </section>
    </div>
  );
}

function DockerLogsDialog({
  logs,
  onClose,
  onTailChange,
}: {
  logs: DockerLogsState;
  onClose(): void;
  onTailChange(tail: number): void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useModalFocus(dialogRef, closeRef, onClose);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink/55 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        aria-label={`容器日志 ${logs.containerName}`}
        aria-modal="true"
        className="flex max-h-[82vh] w-[820px] flex-col border border-ink bg-screen text-screen-text"
        ref={dialogRef}
        role="dialog"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-[#3B3934] px-4 py-3">
          <ScrollText aria-hidden className="size-4 shrink-0 text-accent" strokeWidth={1.5} />
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[9px] tracking-[0.16em] text-[#8E8A80]">
              DOCKER LOGS / TAIL {logs.tail}
            </p>
            <h3 className="mt-1 truncate text-[16px] font-semibold">
              {logs.containerName}
            </h3>
          </div>
          <select
            aria-label="日志行数"
            className="h-7 shrink-0 border border-[#4A4740] bg-[#1C1A17] px-2 font-mono text-[10px] text-[#D6D1C6]"
            onChange={(event) => onTailChange(Number(event.target.value))}
            value={logs.tail}
          >
            {[100, 500, 1_000].map((tail) => (
              <option key={tail} value={tail}>
                {tail} 行
              </option>
            ))}
          </select>
          <button
            className="h-7 shrink-0 border border-[#4A4740] px-3 text-[10px] text-[#D6D1C6] hover:bg-[#2C2A26] hover:text-paper"
            onClick={onClose}
            ref={closeRef}
            type="button"
          >
            关闭日志
          </button>
        </header>

        <div
          aria-label={`${logs.containerName} 日志内容`}
          className="min-h-[280px] flex-1 overflow-auto px-4 py-3"
          role="log"
        >
          {logs.status === 'loading' ? (
            <p className="font-mono text-[11px] text-[#B9B4A8]">正在读取容器日志…</p>
          ) : null}
          {logs.status === 'error' && logs.error ? (
            <div className="border-l-2 border-danger pl-3" role="alert">
              <p className="text-[11px] leading-5 text-[#E3A79B]">
                {logs.error.code === 'CONFLICT'
                  ? '日志过大，减少行数后重试。'
                  : dockerErrorMessage(logs.error)}
              </p>
              <p className="mt-1 text-[10px] text-[#8E8A80]">
                可调整日志行数重新读取，或关闭日志返回容器列表。
              </p>
            </div>
          ) : null}
          {logs.status === 'ready' ? (
            <div className="space-y-4">
              <section>
                <p className="font-mono text-[8px] tracking-[0.16em] text-[#8E8A80]">
                  STDOUT
                </p>
                <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[10px] leading-5 text-screen-text">
                  {logs.stdout || '（无 stdout 输出）'}
                </pre>
              </section>
              <section>
                <p className="font-mono text-[8px] tracking-[0.16em] text-[#8E8A80]">
                  STDERR
                </p>
                <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[10px] leading-5 text-[#E3BE7B]">
                  {logs.stderr || '（无 stderr 输出）'}
                </pre>
              </section>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function DockerShellDialog({
  busy,
  container,
  error,
  onCancel,
  onChoose,
}: {
  busy: boolean;
  container: DockerContainer;
  error: string | null;
  onCancel(): void;
  onChoose(shell: DockerShell): void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useModalFocus(dialogRef, cancelRef, () => {
    if (!busy) onCancel();
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/45 p-6">
      <section
        aria-label="选择容器 shell"
        aria-modal="true"
        className="w-[480px] border border-ink bg-shell"
        ref={dialogRef}
        role="dialog"
      >
        <header className="flex items-start gap-3 border-b border-hairline px-5 py-4">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center border border-warning text-warning">
            <AlertTriangle aria-hidden className="size-4" strokeWidth={1.5} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[9px] tracking-[0.16em] text-warning">
              EXEC / SHELL UNAVAILABLE
            </p>
            <h2 className="mt-1 text-[18px] font-semibold tracking-[-0.01em] text-ink">
              选择可用的 shell
            </h2>
          </div>
          <button
            aria-label="关闭 shell 选择"
            className="grid size-7 place-items-center text-muted hover:bg-paper hover:text-ink disabled:opacity-40"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            <X aria-hidden className="size-4" strokeWidth={1.5} />
          </button>
        </header>
        <div className="px-5 py-4">
          <p className="text-[12px] leading-6 text-muted">
            容器内没有 sh，可选择 bash 或 ash 重试。Harbor 只接受 sh、bash、ash
            三种白名单 shell，不会把任意命令写入容器。
          </p>
          <p className="mt-3 break-all border border-hairline bg-paper px-3 py-2 font-mono text-[10px] text-muted">
            {containerName(container)} · {container.id}
          </p>
          {error ? (
            <p className="mt-3 border-l-2 border-danger pl-2 text-[11px] leading-5 text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <footer className="flex justify-end gap-2 border-t border-hairline px-5 py-3">
          <button
            className="h-8 border border-hairline px-4 text-[11px] font-medium text-ink hover:bg-paper disabled:opacity-40"
            disabled={busy}
            onClick={onCancel}
            ref={cancelRef}
            type="button"
          >
            取消
          </button>
          <button
            className="h-8 border border-ink bg-paper px-4 text-[11px] font-medium text-ink hover:bg-ink hover:text-paper disabled:opacity-40"
            disabled={busy}
            onClick={() => onChoose('ash')}
            type="button"
          >
            使用 ash
          </button>
          <button
            className="h-8 bg-ink px-4 text-[11px] font-medium text-paper hover:bg-accent disabled:opacity-40"
            disabled={busy}
            onClick={() => onChoose('bash')}
            type="button"
          >
            使用 bash
          </button>
        </footer>
      </section>
    </div>
  );
}

function containerName(container: DockerContainer): string {
  return container.names[0] ?? container.id.slice(0, 12);
}

function containerStateLabel(state: string): string {
  switch (state.toLowerCase()) {
    case 'running':
      return '运行中';
    case 'exited':
    case 'dead':
      return '已停止';
    case 'created':
      return '已创建';
    case 'paused':
      return '已暂停';
    case 'restarting':
      return '重启中';
    case 'removing':
      return '移除中';
    default:
      return state;
  }
}

function formatStartedAt(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 19)} UTC`;
}

function useModalFocus(
  dialogRef: RefObject<HTMLElement | null>,
  initialFocusRef: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    initialFocusRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute('aria-hidden'));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      if (event.shiftKey) {
        if (current === first || !dialog.contains(current)) {
          event.preventDefault();
          last.focus();
        }
      } else if (current === last || !dialog.contains(current)) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previous?.focus();
    };
  }, [dialogRef, initialFocusRef]);
}
