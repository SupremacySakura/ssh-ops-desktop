import type { Server } from '@opspilot/contracts';
import {
  ClipboardPaste,
  Copy,
  History,
  Plus,
  RotateCw,
  TerminalSquare,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  MAX_TERMINAL_SESSIONS,
  useTerminalStore,
} from '../../store/terminal-store';
import type {
  ServerRuntime,
  TerminalSessionView,
} from '../../store/terminal-store';
import { useCommandHistory } from './command-history';
import { CommandHistoryPalette } from './command-history-palette';
import { XtermViewport } from './xterm-viewport';
import type { TerminalActions } from './xterm-viewport';

interface TerminalPaneProps {
  server: Server;
  workspaceActive: boolean;
}

const idleRuntime: ServerRuntime = {
  serverId: '',
  connection: null,
  status: 'idle',
  error: null,
  hostKeyPrompt: null,
  lastConnectionSequence: 0,
  sessions: [],
  activeSessionId: null,
  openingSessions: 0,
  nextSessionNumber: 1,
};

export function TerminalPane({ server, workspaceActive }: TerminalPaneProps) {
  const history = useCommandHistory();
  const runtime = useTerminalStore((state) => state.runtimes[server.id]) ?? idleRuntime;
  const eventBridgeStatus = useTerminalStore((state) => state.eventBridgeStatus);
  const eventBridgeError = useTerminalStore((state) => state.eventBridgeError);
  const openSession = useTerminalStore((state) => state.openSession);
  const closeSession = useTerminalStore((state) => state.closeSession);
  const reconnectSession = useTerminalStore((state) => state.reconnectSession);
  const activateSession = useTerminalStore((state) => state.activateSession);
  const retryServer = useTerminalStore((state) => state.retryServer);
  const resizeSession = useTerminalStore((state) => state.resizeSession);
  const writeSession = useTerminalStore((state) => state.writeSession);
  const actionsRef = useRef(new Map<string, TerminalActions>());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const activeSession = runtime.sessions.find(
    (session) => session.id === runtime.activeSessionId,
  ) ?? runtime.sessions[0];
  const sessionLimitReached = (
    runtime.sessions.length + runtime.openingSessions
    >= MAX_TERMINAL_SESSIONS
  );
  const canOpen = runtime.status === 'ready' && !sessionLimitReached;

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 1_800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const registerActions = useCallback((
    sessionId: string,
    actions: TerminalActions | null,
  ) => {
    if (actions) {
      actionsRef.current.set(sessionId, actions);
    } else {
      actionsRef.current.delete(sessionId);
    }
  }, []);

  const recordCommand = useCallback((command: string) => {
    void history.add(server.id, command).catch(() => {
      // History is a convenience; a storage failure must not block the shell.
    });
  }, [history, server.id]);

  async function copySelection() {
    if (!activeSession) return;
    const copied = await actionsRef.current.get(activeSession.id)?.copy();
    setNotice(copied ? '已复制选中内容' : '先选中要复制的终端文本');
  }

  async function pasteClipboard() {
    if (!activeSession) return;
    const pasted = await actionsRef.current.get(activeSession.id)?.paste();
    setNotice(pasted ? '已粘贴' : '无法读取剪贴板');
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-stretch border-b border-hairline bg-[#E2DED6]">
        <div
          aria-label="终端会话"
          className="flex min-w-0 flex-1 items-stretch overflow-x-auto"
          role="tablist"
        >
          {runtime.sessions.map((session) => {
            const selected = session.id === activeSession?.id;
            return (
              <div
                className={`group flex min-w-[128px] max-w-[220px] shrink-0 items-stretch border-r border-hairline ${
                  selected ? 'bg-ink text-paper' : 'bg-shell text-ink hover:bg-paper'
                }`}
                key={session.id}
              >
                <button
                  aria-label={`切换到 ${session.title}`}
                  aria-selected={selected}
                  className="flex min-w-0 flex-1 items-center gap-2 px-3 text-left text-[11px]"
                  onClick={() => activateSession(server.id, session.id)}
                  role="tab"
                  type="button"
                >
                  <TerminalSquare
                    aria-hidden
                    className={`size-3 shrink-0 ${selected ? 'text-accent' : 'text-muted'}`}
                    strokeWidth={1.5}
                  />
                  <span className="truncate">{session.title}</span>
                  {session.gap ? (
                    <span
                      className={`shrink-0 font-mono text-[8px] tracking-[0.08em] ${
                        selected ? 'text-accent' : 'text-warning'
                      }`}
                    >
                      缺段
                    </span>
                  ) : null}
                  {session.status === 'closed' ? (
                    <span
                      className={`shrink-0 size-1.5 ${
                        selected ? 'bg-accent' : 'bg-danger'
                      }`}
                      aria-label="已断开"
                    />
                  ) : null}
                </button>
                <button
                  aria-label={`关闭会话 ${session.title}`}
                  className={`grid w-7 shrink-0 place-items-center ${
                    selected
                      ? 'text-[#B9B4A8] hover:bg-[#302E29] hover:text-paper'
                      : 'text-muted hover:bg-shell hover:text-ink'
                  }`}
                  onClick={() => void closeSession(server.id, session.id)}
                  type="button"
                >
                  <X aria-hidden className="size-3" strokeWidth={1.5} />
                </button>
              </div>
            );
          })}
        </div>
        <button
          aria-label="新增终端会话"
          className="grid w-9 shrink-0 place-items-center border-l border-hairline text-muted hover:bg-paper hover:text-ink disabled:opacity-40"
          disabled={!canOpen}
          onClick={() => void openSession(server.id)}
          title={sessionLimitReached
            ? `每个服务器最多 ${MAX_TERMINAL_SESSIONS} 个终端会话`
            : '新增终端会话'}
          type="button"
        >
          <Plus aria-hidden className="size-3.5" strokeWidth={1.5} />
        </button>
        <span
          aria-label="终端会话数量"
          className="flex shrink-0 items-center border-l border-hairline px-2.5 font-mono text-[9px] tracking-[0.08em] text-muted"
        >
          {runtime.sessions.length}/{MAX_TERMINAL_SESSIONS}
        </span>
      </div>

      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[#2C2A26] bg-[#1C1A17] px-2 text-[#B9B4A8]">
        <span className="mr-auto flex items-center gap-2 px-1 font-mono text-[9px] tracking-[0.12em]">
          <span
            aria-hidden
            className={`size-1.5 ${
              runtime.status === 'ready' ? 'bg-success' : 'bg-warning'
            }`}
          />
          {connectionStatusLabel(runtime.status)}
        </span>
        <button
          aria-label="复制终端选中内容"
          className="inline-flex h-6 items-center gap-1.5 px-2 text-[10px] hover:bg-[#2C2A26] hover:text-paper disabled:opacity-30"
          disabled={!activeSession}
          onClick={() => void copySelection()}
          type="button"
        >
          <Copy aria-hidden className="size-3" strokeWidth={1.5} />
          复制
        </button>
        <button
          aria-label="粘贴到终端"
          className="inline-flex h-6 items-center gap-1.5 px-2 text-[10px] hover:bg-[#2C2A26] hover:text-paper disabled:opacity-30"
          disabled={!activeSession || activeSession.status !== 'open'}
          onClick={() => void pasteClipboard()}
          type="button"
        >
          <ClipboardPaste aria-hidden className="size-3" strokeWidth={1.5} />
          粘贴
        </button>
        <button
          aria-label="搜索本地命令历史"
          className="inline-flex h-6 items-center gap-1.5 px-2 text-[10px] hover:bg-[#2C2A26] hover:text-paper disabled:opacity-30"
          disabled={!activeSession}
          onClick={() => setHistoryOpen(true)}
          type="button"
        >
          <History aria-hidden className="size-3" strokeWidth={1.5} />
          历史
          <kbd className="font-mono text-[8px] text-[#8E8A80]">CTRL+R</kbd>
        </button>
      </div>

      {notice ? (
        <p
          aria-live="polite"
          className="border-b border-[#3B3934] bg-[#2C2A26] px-3 py-1.5 font-mono text-[9px] text-[#D6D1C6]"
        >
          {notice}
        </p>
      ) : null}

      {runtime.error && runtime.status !== 'host-key' ? (
        <div
          className="flex shrink-0 items-start gap-3 border-b border-danger/40 bg-[#F4E9E5] px-3 py-2"
          role="alert"
        >
          <p className="min-w-0 flex-1 text-[11px] leading-5 text-danger">{runtime.error}</p>
          {runtime.status !== 'blocked' ? (
            <button
              className="inline-flex h-7 shrink-0 items-center gap-1.5 border border-danger px-2 text-[10px] font-medium text-danger hover:bg-paper"
              onClick={() => void retryServer(server.id)}
              type="button"
            >
              <RotateCw aria-hidden className="size-3" strokeWidth={1.5} />
              重试
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden bg-screen">
        {runtime.sessions.map((session) => (
          <TerminalSessionPanel
            active={workspaceActive && session.id === activeSession?.id}
            key={session.id}
            onCommand={recordCommand}
            onInput={(bytes) => void writeSession(session.id, bytes)}
            onOpenHistory={() => setHistoryOpen(true)}
            onRegisterActions={registerActions}
            onResize={(columns, rows) => void resizeSession(session.id, columns, rows)}
            onReconnect={() => void reconnectSession(server.id, session.id)}
            onClose={() => void closeSession(server.id, session.id)}
            session={session}
            serverName={server.name}
          />
        ))}

        {runtime.sessions.length === 0 ? (
          <TerminalEmptyState
            eventBridgeError={eventBridgeError}
            eventBridgeStatus={eventBridgeStatus}
            runtime={runtime}
            onRetry={() => void retryServer(server.id)}
          />
        ) : null}

        <CommandHistoryPalette
          onClose={() => {
            setHistoryOpen(false);
            if (activeSession) actionsRef.current.get(activeSession.id)?.focus();
          }}
          onSelect={(command) => {
            if (activeSession) actionsRef.current.get(activeSession.id)?.insertCommand(command);
          }}
          open={historyOpen}
          serverId={server.id}
          serverName={server.name}
        />
      </div>
    </div>
  );
}

interface TerminalSessionPanelProps {
  active: boolean;
  onClose(): void;
  onCommand(command: string): void;
  onInput(bytes: Uint8Array): void;
  onOpenHistory(): void;
  onReconnect(): void;
  onRegisterActions(sessionId: string, actions: TerminalActions | null): void;
  onResize(columns: number, rows: number): void;
  serverName: string;
  session: TerminalSessionView;
}

function TerminalSessionPanel({
  active,
  onClose,
  onCommand,
  onInput,
  onOpenHistory,
  onReconnect,
  onRegisterActions,
  onResize,
  serverName,
  session,
}: TerminalSessionPanelProps) {
  return (
    <div
      aria-hidden={!active}
      className={`absolute inset-0 ${
        active ? 'visible' : 'invisible pointer-events-none'
      }`}
    >
      <XtermViewport
        active={active}
        onCommand={onCommand}
        onInput={onInput}
        onOpenHistory={onOpenHistory}
        onRegisterActions={onRegisterActions}
        onResize={onResize}
        session={session}
      />

      {session.gap ? (
        <div className="pointer-events-none absolute right-3 top-2 z-10 border border-warning/60 bg-[#2C2418] px-2 py-1 font-mono text-[9px] tracking-[0.06em] text-[#E3BE7B]">
          输出曾中断 · 后续数据仍按序保留
        </div>
      ) : null}

      {session.status === 'closed' ? (
        <div className="absolute inset-0 z-20 grid place-items-center bg-screen/80 p-6">
          <section className="w-[420px] border border-[#3B3934] bg-[#1C1A17] px-5 py-5 text-screen-text">
            <p className="font-mono text-[9px] tracking-[0.16em] text-accent">
              SESSION INTERRUPTED
            </p>
            <h3 className="mt-2 text-[18px] font-semibold">
              {closedSessionTitle(session)}
            </h3>
            <p className="mt-2 text-[11px] leading-5 text-[#B9B4A8]">
              {serverName} 的这条会话通道已关闭。已有输出仍保留在本页，不会自动重放输入。
            </p>
            <div className="mt-5 flex items-center gap-2">
              <button
                className="inline-flex h-8 items-center gap-1.5 bg-accent px-3 text-[11px] font-medium text-paper"
                onClick={onReconnect}
                type="button"
              >
                <RotateCw aria-hidden className="size-3.5" strokeWidth={1.5} />
                重连会话
              </button>
              <button
                className="h-8 border border-[#4A4740] px-3 text-[11px] text-[#D6D1C6] hover:bg-[#2C2A26]"
                onClick={onClose}
                type="button"
              >
                关闭标签
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function TerminalEmptyState({
  eventBridgeError,
  eventBridgeStatus,
  onRetry,
  runtime,
}: {
  eventBridgeError: string | null;
  eventBridgeStatus: 'idle' | 'loading' | 'ready' | 'error';
  onRetry(): void;
  runtime: ServerRuntime;
}) {
  const waitingForHostKey = runtime.status === 'host-key';
  const failed = runtime.status === 'error'
    || runtime.status === 'blocked'
    || runtime.status === 'closed';
  const loading = runtime.status === 'idle'
    || runtime.status === 'connecting'
    || eventBridgeStatus === 'loading'
    || runtime.openingSessions > 0;
  return (
    <div className="grid h-full place-items-center px-8">
      <div className="w-full max-w-lg border-y border-[#2C2A26] py-8">
        <p className="font-mono text-[9px] tracking-[0.18em] text-[#8E8A80]">
          SHELL CHANNEL / {connectionStatusLabel(runtime.status).toUpperCase()}
        </p>
        <p className="mt-3 font-mono text-[13px] text-screen-text">
          {eventBridgeStatus === 'error'
            ? '终端事件通道不可用'
            : waitingForHostKey
              ? '等待你核对并信任服务器主机指纹'
              : failed
                ? 'SSH 会话尚未建立'
                : loading
                  ? '正在建立 SSH 连接与 PTY…'
                  : '终端通道已就绪'}
        </p>
        <p className="mt-2 max-w-md text-[11px] leading-5 text-[#B9B4A8]">
          {eventBridgeError
            ?? runtime.error
            ?? (waitingForHostKey
              ? '确认指纹后 Harbor 才会继续认证。变化过的指纹不会被静默信任。'
              : '连接成功后会自动打开第一个终端会话。')}
        </p>
        {failed && runtime.status !== 'blocked' ? (
          <button
            className="mt-5 inline-flex h-8 items-center gap-1.5 bg-accent px-3 text-[11px] font-medium text-paper"
            onClick={onRetry}
            type="button"
          >
            <RotateCw aria-hidden className="size-3.5" strokeWidth={1.5} />
            重试连接
          </button>
        ) : null}
        {loading ? (
          <div className="mt-6 h-px overflow-hidden bg-[#2C2A26]" aria-hidden>
            <span className="block h-full w-1/3 animate-pulse bg-accent" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function connectionStatusLabel(status: ServerRuntime['status']): string {
  switch (status) {
    case 'idle':
      return '待连接';
    case 'connecting':
      return '连接中';
    case 'host-key':
      return '待验证主机';
    case 'ready':
      return '连接正常';
    case 'blocked':
      return '连接已阻断';
    case 'error':
      return '连接失败';
    case 'closed':
      return '连接已关闭';
  }
}

function closedSessionTitle(session: TerminalSessionView): string {
  switch (session.closeReason) {
    case 'remoteExit':
      return session.exitStatus === undefined
        ? '远端会话已结束'
        : `远端会话已结束 · 退出码 ${session.exitStatus}`;
    case 'disconnected':
      return 'SSH 连接已断开';
    case 'connectionClosed':
      return 'SSH 连接已关闭';
    case 'closed':
      return '终端会话已关闭';
    default:
      return '终端会话已结束';
  }
}
