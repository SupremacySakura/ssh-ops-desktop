import {
  CoreErrorSchema,
  type ConnectOutcome,
  type ConnectionHandle,
  type ConnectionStateEvent,
  type HostKeyPrompt,
  type TerminalCloseReason,
  type TerminalClosedEvent,
  type TerminalDataEvent,
  type TerminalGapEvent,
  type TerminalSession,
} from '@opspilot/contracts';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { create } from 'zustand';

import type { CoreClient } from '../api/core';
import { useHarborStore } from './harbor-store';

export const MAX_TERMINAL_SESSIONS = 8;
const DEFAULT_COLUMNS = 100;
const DEFAULT_ROWS = 30;
const MAX_PENDING_TERMINAL_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_TERMINAL_EVENTS = 512;
const MAX_TERMINAL_OUTPUT_BYTES = 4 * 1024 * 1024;

export type ServerConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'host-key'
  | 'ready'
  | 'blocked'
  | 'error'
  | 'closed';

export interface TerminalSessionView {
  id: string;
  title: string;
  connection: ConnectionHandle;
  status: 'open' | 'closed';
  lastSequence: number;
  gap: boolean;
  closeReason?: TerminalCloseReason;
  exitStatus?: number;
}

export interface ServerRuntime {
  serverId: string;
  connection: ConnectionHandle | null;
  status: ServerConnectionStatus;
  error: string | null;
  hostKeyPrompt: HostKeyPrompt | null;
  lastConnectionSequence: number;
  sessions: TerminalSessionView[];
  activeSessionId: string | null;
  openingSessions: number;
  nextSessionNumber: number;
}

interface TerminalStore {
  core: CoreClient | null;
  eventBridgeStatus: 'idle' | 'loading' | 'ready' | 'error';
  eventBridgeError: string | null;
  runtimes: Record<string, ServerRuntime>;
  setCore: (core: CoreClient | null) => void;
  setEventBridgeStatus: (
    status: TerminalStore['eventBridgeStatus'],
    error?: string | null,
  ) => void;
  acceptConnectionState: (event: ConnectionStateEvent) => void;
  acceptTerminalData: (event: TerminalDataEvent) => void;
  acceptTerminalGap: (event: TerminalGapEvent) => void;
  acceptTerminalClosed: (event: TerminalClosedEvent) => void;
  ensureConnected: (serverId: string) => Promise<void>;
  connectServer: (serverId: string) => Promise<void>;
  retryServer: (serverId: string) => Promise<void>;
  trustHostKey: (serverId: string) => Promise<void>;
  dismissHostKey: (serverId: string) => void;
  openSession: (serverId: string) => Promise<TerminalSessionView | null>;
  closeSession: (serverId: string, sessionId: string) => Promise<void>;
  reconnectSession: (serverId: string, sessionId: string) => Promise<void>;
  activateSession: (serverId: string, sessionId: string) => void;
  resizeSession: (sessionId: string, columns: number, rows: number) => Promise<void>;
  writeSession: (sessionId: string, bytes: Uint8Array) => Promise<void>;
  disconnectServer: (serverId: string) => Promise<void>;
  disposeServer: (serverId: string) => Promise<void>;
  reset: () => void;
}

type PendingTerminalEvent =
  | { kind: 'data'; event: TerminalDataEvent }
  | { kind: 'gap'; event: TerminalGapEvent }
  | { kind: 'closed'; event: TerminalClosedEvent };

interface PendingTerminalBuffer {
  events: PendingTerminalEvent[];
  bytes: number;
  overflowMissed: number;
}

interface OutputBuffer {
  chunks: Uint8Array[];
  bytes: number;
  listeners: Set<(bytes: Uint8Array) => void>;
}

const pendingTerminalEvents = new Map<string, PendingTerminalBuffer>();
const terminalOutput = new Map<string, OutputBuffer>();
const connectionRequests = new Map<string, Promise<void>>();

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  core: null,
  eventBridgeStatus: 'idle',
  eventBridgeError: null,
  runtimes: {},
  setCore: (core) => set({ core }),
  setEventBridgeStatus: (eventBridgeStatus, eventBridgeError = null) => set({
    eventBridgeStatus,
    eventBridgeError,
  }),
  acceptConnectionState: (event) => {
    set((state) => {
      const runtime = state.runtimes[event.serverId];
      if (!runtime || event.sequence <= runtime.lastConnectionSequence) {
        return state;
      }
      const next: ServerRuntime = {
        ...runtime,
        lastConnectionSequence: event.sequence,
      };
      switch (event.state.kind) {
        case 'connecting':
          next.status = 'connecting';
          break;
        case 'ready':
          if (event.connectionId === null) {
            next.status = 'error';
            next.connection = null;
            next.error = 'Core 返回的连接状态无效，请重试';
            break;
          }
          next.status = 'ready';
          next.connection = {
            serverId: event.serverId,
            connectionId: event.connectionId,
          };
          next.error = null;
          break;
        case 'closed':
          next.status = 'closed';
          break;
        case 'error':
          next.status = event.state.code === 'SSH_HOST_KEY_CHANGED'
            ? 'blocked'
            : 'error';
          next.error = connectionErrorMessage({
            code: event.state.code,
            message: event.state.message,
            retryable: event.state.retryable,
          });
          break;
      }
      return {
        runtimes: {
          ...state.runtimes,
          [event.serverId]: next,
        },
      };
    });
  },
  acceptTerminalData: (event) => {
    const located = locateSession(get().runtimes, event.terminalSessionId);
    if (!located) {
      bufferPendingTerminalEvent(event.terminalSessionId, {
        kind: 'data',
        event,
      });
      return;
    }
    applyTerminalData(set, event);
  },
  acceptTerminalGap: (event) => {
    const located = locateSession(get().runtimes, event.terminalSessionId);
    if (!located) {
      bufferPendingTerminalEvent(event.terminalSessionId, {
        kind: 'gap',
        event,
      });
      return;
    }
    applyTerminalGap(set, event);
  },
  acceptTerminalClosed: (event) => {
    const located = locateSession(get().runtimes, event.terminalSessionId);
    if (!located) {
      bufferPendingTerminalEvent(event.terminalSessionId, {
        kind: 'closed',
        event,
      });
      return;
    }
    applyTerminalClosed(set, event);
  },
  ensureConnected: async (serverId) => {
    const runtime = get().runtimes[serverId];
    if (runtime && runtime.status !== 'idle') return;
    await get().connectServer(serverId);
  },
  connectServer: async (serverId) => {
    const existing = connectionRequests.get(serverId);
    if (existing) return existing;
    const runtime = get().runtimes[serverId];
    if (runtime?.status === 'connecting' || runtime?.status === 'host-key') return;
    if (runtime?.status === 'ready') {
      if (runtime.sessions.length === 0 && runtime.openingSessions === 0) {
        await get().openSession(serverId);
      }
      return;
    }
    const core = get().core;
    if (!core) {
      updateRuntime(set, serverId, (current) => ({
        ...current,
        status: 'error',
        error: 'Core 尚未连接，无法建立 SSH 连接',
      }));
      return;
    }

    const request = (async () => {
      updateRuntime(set, serverId, (current) => ({
        ...current,
        status: 'connecting',
        error: null,
        hostKeyPrompt: null,
      }));
      try {
        const outcome = await core.connect(serverId);
        if (!get().runtimes[serverId]) {
          if (outcome.kind === 'ready') {
            await core.disconnect(outcome.connection).catch(() => undefined);
          }
          return;
        }
        applyConnectOutcome(set, serverId, outcome);
        if (outcome.kind === 'ready') {
          useHarborStore.getState().markServerConnected(serverId);
        }
        if (
          outcome.kind === 'ready'
          && (get().runtimes[serverId]?.sessions.length ?? 0) === 0
        ) {
          await get().openSession(serverId);
        }
      } catch (error) {
        if (!get().runtimes[serverId]) return;
        updateRuntime(set, serverId, (current) => ({
          ...current,
          status: 'error',
          error: connectionErrorMessage(error),
        }));
      } finally {
        connectionRequests.delete(serverId);
      }
    })();
    connectionRequests.set(serverId, request);
    await request;
  },
  retryServer: async (serverId) => {
    const runtime = get().runtimes[serverId];
    if (runtime?.status === 'ready') {
      await get().openSession(serverId);
      return;
    }
    updateRuntime(set, serverId, (current) => ({
      ...current,
      status: 'idle',
      error: null,
    }));
    await get().connectServer(serverId);
  },
  trustHostKey: async (serverId) => {
    const core = get().core;
    const runtime = get().runtimes[serverId];
    if (!core || !runtime?.hostKeyPrompt) return;
    try {
      await core.trustHostKey(serverId, runtime.hostKeyPrompt.verificationId);
      if (!get().runtimes[serverId]) return;
      updateRuntime(set, serverId, (current) => ({
        ...current,
        hostKeyPrompt: null,
        status: 'idle',
        error: null,
      }));
      await get().connectServer(serverId);
    } catch (error) {
      updateRuntime(set, serverId, (current) => ({
        ...current,
        status: 'error',
        error: connectionErrorMessage(error),
      }));
    }
  },
  dismissHostKey: (serverId) => {
    updateRuntime(set, serverId, (current) => ({
      ...current,
      hostKeyPrompt: null,
      status: 'closed',
      error: '已取消主机指纹确认，SSH 连接尚未建立',
    }));
  },
  openSession: async (serverId) => {
    const core = get().core;
    const runtime = get().runtimes[serverId];
    if (!core || !runtime?.connection || runtime.status !== 'ready') return null;
    if (
      runtime.sessions.length + runtime.openingSessions
      >= MAX_TERMINAL_SESSIONS
    ) {
      updateRuntime(set, serverId, (current) => ({
        ...current,
        error: `每个服务器最多同时打开 ${MAX_TERMINAL_SESSIONS} 个终端会话`,
      }));
      return null;
    }
    updateRuntime(set, serverId, (current) => ({
      ...current,
      error: null,
      openingSessions: current.openingSessions + 1,
    }));
    try {
      const session = await core.openTerminal(
        runtime.connection,
        DEFAULT_COLUMNS,
        DEFAULT_ROWS,
      );
      const current = get().runtimes[serverId];
      if (
        !current
        || current.connection?.connectionId !== runtime.connection.connectionId
      ) {
        discardPendingTerminalEvents(session.id);
        await core.closeTerminal(session.id).catch(() => undefined);
        return null;
      }
      const view = addTerminalSession(set, get, serverId, session);
      drainPendingTerminalEvents(set, session.id);
      return view;
    } catch (error) {
      updateRuntime(set, serverId, (current) => ({
        ...current,
        error: openSessionErrorMessage(error),
      }));
      return null;
    } finally {
      updateRuntime(set, serverId, (current) => ({
        ...current,
        openingSessions: Math.max(0, current.openingSessions - 1),
      }));
    }
  },
  closeSession: async (serverId, sessionId) => {
    const core = get().core;
    if (core) {
      try {
        await core.closeTerminal(sessionId);
      } catch (error) {
        if (coreErrorCode(error) !== 'NOT_FOUND') {
          updateRuntime(set, serverId, (current) => ({
            ...current,
            error: openSessionErrorMessage(error),
          }));
          return;
        }
      }
    }
    removeTerminalSession(set, serverId, sessionId);
  },
  reconnectSession: async (serverId, sessionId) => {
    const core = get().core;
    const runtime = get().runtimes[serverId];
    const session = runtime?.sessions.find((candidate) => candidate.id === sessionId);
    if (!core || !runtime || !session) return;
    const replace = (opened: TerminalSession) => {
      replaceTerminalSession(set, serverId, sessionId, opened);
      drainPendingTerminalEvents(set, opened.id);
    };

    if (runtime.connection) {
      try {
        const opened = await core.openTerminal(
          runtime.connection,
          DEFAULT_COLUMNS,
          DEFAULT_ROWS,
        );
        if (!get().runtimes[serverId]) {
          discardPendingTerminalEvents(opened.id);
          await core.closeTerminal(opened.id).catch(() => undefined);
          return;
        }
        replace(opened);
        return;
      } catch {
        // The SSH transport may be gone even though the logical connection remains.
      }
    }

    if (runtime.connection) {
      try {
        await core.disconnect(runtime.connection);
      } catch {
        // Reconnect must still be able to replace a dead connection.
      }
    }
    updateRuntime(set, serverId, (current) => ({
      ...current,
      connection: null,
      status: 'idle',
      error: null,
    }));
    await get().connectServer(serverId);
    const connected = get().runtimes[serverId];
    if (!connected?.connection) return;
    try {
      const opened = await core.openTerminal(
        connected.connection,
        DEFAULT_COLUMNS,
        DEFAULT_ROWS,
      );
      if (!get().runtimes[serverId]) {
        discardPendingTerminalEvents(opened.id);
        await core.closeTerminal(opened.id).catch(() => undefined);
        return;
      }
      replace(opened);
    } catch (error) {
      updateRuntime(set, serverId, (current) => ({
        ...current,
        error: openSessionErrorMessage(error),
      }));
    }
  },
  activateSession: (serverId, sessionId) => {
    updateRuntime(set, serverId, (current) => (
      current.sessions.some((session) => session.id === sessionId)
        ? { ...current, activeSessionId: sessionId }
        : current
    ));
  },
  resizeSession: async (sessionId, columns, rows) => {
    const core = get().core;
    if (!core) return;
    try {
      await core.resizeTerminal(sessionId, columns, rows);
    } catch (error) {
      if (coreErrorCode(error) !== 'NOT_FOUND') {
        const located = locateSession(get().runtimes, sessionId);
        if (located) {
          updateRuntime(set, located.serverId, (current) => ({
            ...current,
            error: openSessionErrorMessage(error),
          }));
        }
      }
    }
  },
  writeSession: async (sessionId, bytes) => {
    const core = get().core;
    if (!core) return;
    try {
      await core.writeTerminal(sessionId, bytes);
    } catch (error) {
      const located = locateSession(get().runtimes, sessionId);
      if (located && coreErrorCode(error) !== 'NOT_FOUND') {
        updateRuntime(set, located.serverId, (current) => ({
          ...current,
          error: openSessionErrorMessage(error),
        }));
      }
    }
  },
  disconnectServer: async (serverId) => {
    const core = get().core;
    const runtime = get().runtimes[serverId];
    if (core && runtime?.connection) {
      try {
        await core.disconnect(runtime.connection);
      } catch (error) {
        if (coreErrorCode(error) !== 'NOT_FOUND') {
          updateRuntime(set, serverId, (current) => ({
            ...current,
            error: connectionErrorMessage(error),
          }));
          return;
        }
      }
    }
    clearServerSessions(set, get, serverId, 'connectionClosed');
    updateRuntime(set, serverId, (current) => ({
      ...current,
      connection: null,
      status: 'closed',
    }));
  },
  disposeServer: async (serverId) => {
    const runtime = get().runtimes[serverId];
    const core = get().core;
    connectionRequests.delete(serverId);
    if (runtime?.connection) {
      if (!core) {
        const error = new Error('Core 尚未连接，无法安全关闭 SSH 连接');
        updateRuntime(set, serverId, (current) => ({
          ...current,
          status: 'error',
          error: error.message,
        }));
        throw error;
      }
      try {
        await core.disconnect(runtime.connection);
      } catch (error) {
        if (coreErrorCode(error) !== 'NOT_FOUND') {
          updateRuntime(set, serverId, (current) => ({
            ...current,
            status: 'error',
            error: connectionErrorMessage(error),
          }));
          throw error;
        }
      }
    }
    clearServerSessions(set, get, serverId, 'connectionClosed');
    set((state) => {
      const runtimes = { ...state.runtimes };
      delete runtimes[serverId];
      return { runtimes };
    });
  },
  reset: () => {
    for (const id of terminalOutput.keys()) terminalOutput.delete(id);
    pendingTerminalEvents.clear();
    connectionRequests.clear();
    set({
      core: null,
      eventBridgeStatus: 'idle',
      eventBridgeError: null,
      runtimes: {},
    });
  },
}));

export async function attachTerminalEvents(core: CoreClient): Promise<UnlistenFn> {
  const store = useTerminalStore.getState();
  store.setCore(core);
  store.setEventBridgeStatus('loading');
  const unlisteners: UnlistenFn[] = [];
  try {
    unlisteners.push(
      await core.subscribeConnectionState((event) => {
        useTerminalStore.getState().acceptConnectionState(event);
      }),
      await core.subscribeTerminalData((event) => {
        useTerminalStore.getState().acceptTerminalData(event);
      }),
      await core.subscribeTerminalGap((event) => {
        useTerminalStore.getState().acceptTerminalGap(event);
      }),
      await core.subscribeTerminalClosed((event) => {
        useTerminalStore.getState().acceptTerminalClosed(event);
      }),
    );
    useTerminalStore.getState().setEventBridgeStatus('ready');
  } catch (error) {
    for (const unlisten of unlisteners) unlisten();
    useTerminalStore.getState().setEventBridgeStatus(
      'error',
      connectionErrorMessage(error),
    );
  }
  return () => {
    for (const unlisten of unlisteners) unlisten();
  };
}

export function subscribeTerminalOutput(
  sessionId: string,
  listener: (bytes: Uint8Array) => void,
): () => void {
  let buffer = terminalOutput.get(sessionId);
  if (!buffer) {
    buffer = { chunks: [], bytes: 0, listeners: new Set() };
    terminalOutput.set(sessionId, buffer);
  }
  buffer.listeners.add(listener);
  for (const chunk of buffer.chunks) listener(chunk);
  return () => {
    buffer.listeners.delete(listener);
  };
}

export function connectionErrorMessage(error: unknown): string {
  const parsed = CoreErrorSchema.safeParse(error);
  if (parsed.success) {
    switch (parsed.data.code) {
      case 'SSH_AUTHENTICATION':
        return 'SSH 认证失败，请检查系统凭据库中的密码或私钥';
      case 'SSH_CONNECTION':
        return '无法建立 SSH 连接，请检查主机、端口与网络';
      case 'SECRET_UNAVAILABLE':
        return '该服务器的凭据尚未配置，请先补充密码或私钥';
      case 'REMOTE_PERMISSION':
        return '私钥权限不安全，连接已阻断';
      case 'SSH_HOST_KEY_UNKNOWN':
        return '服务器主机指纹尚未确认，连接已阻断';
      case 'SSH_HOST_KEY_CHANGED':
        return '服务器主机指纹已变化，连接已阻断；请核对服务器身份';
      case 'VALIDATION':
        return 'SSH 连接参数无效，请检查主机、端口和用户名';
      case 'TIMEOUT':
        return 'SSH 连接超时，请重试';
      case 'CAPABILITY_UNAVAILABLE':
        return '当前环境不支持所需的 SSH 连接能力';
      case 'NOT_FOUND':
        return '服务器或 SSH 连接不存在，请刷新后重试';
      case 'CANCELLED':
        return 'SSH 连接已取消';
      case 'CONFLICT':
        return 'SSH 连接状态发生冲突，请重试';
      case 'REMOTE_COMMAND':
      case 'REMOTE_PARSE':
      case 'INTERNAL':
        return 'Core 内部错误，连接未建立';
    }
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return 'SSH 连接失败，请重试';
}

function openSessionErrorMessage(error: unknown): string {
  const message = connectionErrorMessage(error);
  return message === 'SSH 连接失败，请重试'
    ? '无法打开终端会话，请重试'
    : message;
}

function applyConnectOutcome(
  set: SetState,
  serverId: string,
  outcome: ConnectOutcome,
) {
  updateRuntime(set, serverId, (current) => {
    switch (outcome.kind) {
      case 'ready':
        return {
          ...current,
          connection: outcome.connection,
          status: 'ready',
          error: null,
          hostKeyPrompt: null,
        };
      case 'hostKeyRequired':
        return {
          ...current,
          status: 'host-key',
          hostKeyPrompt: outcome.prompt,
          error: null,
        };
      case 'hostKeyChanged':
        return {
          ...current,
          status: 'blocked',
          hostKeyPrompt: null,
          error:
            `服务器主机指纹已变化，连接已阻断。期望 ${outcome.expectedSha256}，实际 ${outcome.actualSha256}`,
        };
    }
  });
}

function addTerminalSession(
  set: SetState,
  get: () => TerminalStore,
  serverId: string,
  session: TerminalSession,
): TerminalSessionView {
  const runtime = get().runtimes[serverId] ?? emptyRuntime(serverId);
  const view: TerminalSessionView = {
    id: session.id,
    title: `终端 ${runtime.nextSessionNumber}`,
    connection: session.connection,
    status: 'open',
    lastSequence: 0,
    gap: false,
  };
  updateRuntime(set, serverId, (current) => ({
    ...current,
    activeSessionId: view.id,
    nextSessionNumber: current.nextSessionNumber + 1,
    sessions: [...current.sessions, view],
  }));
  return view;
}

function replaceTerminalSession(
  set: SetState,
  serverId: string,
  previousSessionId: string,
  opened: TerminalSession,
) {
  terminalOutput.delete(previousSessionId);
  updateRuntime(set, serverId, (current) => ({
    ...current,
    activeSessionId: opened.id,
    sessions: current.sessions.map((session) => (
      session.id === previousSessionId
        ? {
            ...session,
            id: opened.id,
            connection: opened.connection,
            status: 'open',
            lastSequence: 0,
            gap: false,
            closeReason: undefined,
            exitStatus: undefined,
          }
        : session
    )),
  }));
}

function removeTerminalSession(
  set: SetState,
  serverId: string,
  sessionId: string,
) {
  terminalOutput.delete(sessionId);
  updateRuntime(set, serverId, (current) => {
    const sessions = current.sessions.filter((session) => session.id !== sessionId);
    return {
      ...current,
      sessions,
      activeSessionId: current.activeSessionId === sessionId
        ? sessions.at(-1)?.id ?? null
        : current.activeSessionId,
    };
  });
}

function clearServerSessions(
  set: SetState,
  get: () => TerminalStore,
  serverId: string,
  reason: TerminalCloseReason,
) {
  const runtime = get().runtimes[serverId];
  for (const session of runtime?.sessions ?? []) {
    terminalOutput.delete(session.id);
  }
  updateRuntime(set, serverId, (current) => ({
    ...current,
    activeSessionId: null,
    sessions: current.sessions.map((session) => ({
      ...session,
      status: 'closed',
      closeReason: reason,
    })),
  }));
}

function applyTerminalData(set: SetState, event: TerminalDataEvent) {
  const located = locateSession(useTerminalStore.getState().runtimes, event.terminalSessionId);
  if (!located) return;
  const session = located.runtime.sessions.find(
    (candidate) => candidate.id === event.terminalSessionId,
  );
  if (!session || event.sequence <= session.lastSequence) return;
  const gap = session.gap || event.sequence > session.lastSequence + 1;
  pushTerminalOutput(event.terminalSessionId, Uint8Array.from(event.bytes));
  updateTerminalSession(set, located.serverId, event.terminalSessionId, (current) => ({
    ...current,
    lastSequence: event.sequence,
    gap,
  }));
}

function applyTerminalGap(set: SetState, event: TerminalGapEvent) {
  const located = locateSession(useTerminalStore.getState().runtimes, event.terminalSessionId);
  if (!located) return;
  updateTerminalSession(set, located.serverId, event.terminalSessionId, (current) => ({
    ...current,
    gap: true,
  }));
}

function applyTerminalClosed(set: SetState, event: TerminalClosedEvent) {
  const located = locateSession(useTerminalStore.getState().runtimes, event.terminalSessionId);
  if (!located) return;
  updateTerminalSession(set, located.serverId, event.terminalSessionId, (current) => ({
    ...current,
    status: 'closed',
    closeReason: event.reason,
    exitStatus: event.exitStatus,
  }));
}

function bufferPendingTerminalEvent(
  sessionId: string,
  event: PendingTerminalEvent,
) {
  let buffer = pendingTerminalEvents.get(sessionId);
  if (!buffer) {
    buffer = { events: [], bytes: 0, overflowMissed: 0 };
    pendingTerminalEvents.set(sessionId, buffer);
  }
  buffer.events.push(event);
  if (event.kind === 'data') buffer.bytes += event.event.bytes.length;
  trimPendingBuffer(buffer);
}

function trimPendingBuffer(buffer: PendingTerminalBuffer) {
  while (
    buffer.events.length > MAX_PENDING_TERMINAL_EVENTS
    || buffer.bytes > MAX_PENDING_TERMINAL_BYTES
  ) {
    const removed = buffer.events.shift();
    if (!removed) break;
    if (removed.kind === 'data') {
      buffer.bytes = Math.max(0, buffer.bytes - removed.event.bytes.length);
      buffer.overflowMissed += 1;
    }
  }
}

function drainPendingTerminalEvents(set: SetState, sessionId: string) {
  const pending = pendingTerminalEvents.get(sessionId);
  if (!pending) return;
  pendingTerminalEvents.delete(sessionId);
  if (pending.overflowMissed > 0) {
    applyTerminalGap(set, {
      terminalSessionId: sessionId,
      missed: pending.overflowMissed,
    });
  }
  for (const event of pending.events) {
    switch (event.kind) {
      case 'data':
        applyTerminalData(set, event.event);
        break;
      case 'gap':
        applyTerminalGap(set, event.event);
        break;
      case 'closed':
        applyTerminalClosed(set, event.event);
        break;
    }
  }
}

function discardPendingTerminalEvents(sessionId: string) {
  pendingTerminalEvents.delete(sessionId);
}

function pushTerminalOutput(sessionId: string, bytes: Uint8Array) {
  let buffer = terminalOutput.get(sessionId);
  if (!buffer) {
    buffer = { chunks: [], bytes: 0, listeners: new Set() };
    terminalOutput.set(sessionId, buffer);
  }
  buffer.chunks.push(bytes);
  buffer.bytes += bytes.length;
  while (
    buffer.bytes > MAX_TERMINAL_OUTPUT_BYTES
    && buffer.chunks.length > 1
  ) {
    const removed = buffer.chunks.shift();
    if (!removed) break;
    buffer.bytes = Math.max(0, buffer.bytes - removed.length);
  }
  for (const listener of buffer.listeners) listener(bytes);
}

function updateTerminalSession(
  set: SetState,
  serverId: string,
  sessionId: string,
  update: (session: TerminalSessionView) => TerminalSessionView,
) {
  updateRuntime(set, serverId, (current) => ({
    ...current,
    sessions: current.sessions.map((session) => (
      session.id === sessionId ? update(session) : session
    )),
  }));
}

function updateRuntime(
  set: SetState,
  serverId: string,
  update: (runtime: ServerRuntime) => ServerRuntime,
) {
  set((state) => ({
    runtimes: {
      ...state.runtimes,
      [serverId]: update(state.runtimes[serverId] ?? emptyRuntime(serverId)),
    },
  }));
}

function locateSession(
  runtimes: Record<string, ServerRuntime>,
  sessionId: string,
): { serverId: string; runtime: ServerRuntime } | null {
  for (const [serverId, runtime] of Object.entries(runtimes)) {
    if (runtime.sessions.some((session) => session.id === sessionId)) {
      return { serverId, runtime };
    }
  }
  return null;
}

function emptyRuntime(serverId: string): ServerRuntime {
  return {
    serverId,
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
}

function coreErrorCode(error: unknown): string | null {
  const parsed = CoreErrorSchema.safeParse(error);
  return parsed.success ? parsed.data.code : null;
}

type SetState = (
  partial:
    | Partial<TerminalStore>
    | ((state: TerminalStore) => Partial<TerminalStore> | TerminalStore),
) => void;
