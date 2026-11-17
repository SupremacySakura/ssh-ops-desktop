import {
  CoreErrorSchema,
  RemoteDirectoryPathSchema,
  type ConnectOutcome,
  type ConnectionHandle,
  type ConnectionStateEvent,
  type CoreError,
  type DockerShell,
  type HostKeyChangedPrompt,
  type HostKeyPrompt,
  type Server,
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
  cwd: string | null;
  closeReason?: TerminalCloseReason;
  exitStatus?: number;
}

export interface ServerRuntime {
  serverId: string;
  connectionIdentity: string | null;
  connection: ConnectionHandle | null;
  status: ServerConnectionStatus;
  error: string | null;
  hostKeyPrompt: HostKeyPrompt | null;
  hostKeyChangedPrompt: HostKeyChangedPrompt | null;
  lastConnectionSequence: number;
  sessions: TerminalSessionView[];
  activeSessionId: string | null;
  openingSessions: number;
  nextSessionNumber: number;
}

export type DockerSessionOpenResult =
  | { kind: 'opened'; session: TerminalSessionView }
  | { kind: 'error'; error: CoreError };

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
  ensureConnected: (server: Server) => Promise<void>;
  connectServer: (serverId: string) => Promise<void>;
  retryServer: (serverId: string) => Promise<void>;
  trustHostKey: (serverId: string) => Promise<void>;
  dismissHostKey: (serverId: string) => void;
  openSession: (serverId: string) => Promise<TerminalSessionView | null>;
  openDockerSession: (
    serverId: string,
    containerId: string,
    shell: DockerShell,
  ) => Promise<DockerSessionOpenResult>;
  closeSession: (serverId: string, sessionId: string) => Promise<void>;
  reconnectSession: (serverId: string, sessionId: string) => Promise<void>;
  activateSession: (serverId: string, sessionId: string) => void;
  setWorkingDirectory: (sessionId: string, directory: string | null) => void;
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

interface ConnectionRequest {
  generation: number;
  promise: Promise<void>;
}

const pendingTerminalEvents = new Map<string, PendingTerminalBuffer>();
const terminalOutput = new Map<string, OutputBuffer>();
const connectionRequests = new Map<string, ConnectionRequest>();
const connectionGenerations = new Map<string, number>();
const reconnectRequests = new Map<string, Promise<void>>();
const closingSessionCounts = new Map<string, number>();
const terminalWriteQueues = new Map<string, Promise<void>>();

export function serverConnectionIdentity(server: Server): string {
  return JSON.stringify([
    server.host,
    server.port,
    server.user,
    server.authType,
    server.secretRef,
  ]);
}

export function countOpenSessions(runtime: ServerRuntime): number {
  return runtime.sessions.filter((session) => session.status === 'open').length;
}

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
      if (
        !runtime
        || event.state.kind !== 'closed'
        || runtime.connection === null
        || event.connectionId !== runtime.connection.connectionId
        || event.sequence <= runtime.lastConnectionSequence
      ) {
        return state;
      }
      const next: ServerRuntime = {
        ...runtime,
        lastConnectionSequence: event.sequence,
        connection: null,
        error: null,
        status: 'closed',
        sessions: runtime.sessions.map((session) => (
          session.status === 'open'
            ? {
                ...session,
                status: 'closed',
                closeReason: 'connectionClosed',
              }
            : session
        )),
      };
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
  ensureConnected: async (server) => {
    const identity = serverConnectionIdentity(server);
    const runtime = get().runtimes[server.id];
    if (runtime && runtime.connectionIdentity !== identity) {
      try {
        await get().disposeServer(server.id);
      } catch {
        return;
      }
    }
    if (server.secretRef === null) {
      updateRuntime(set, server.id, (current) => ({
        ...current,
        connectionIdentity: identity,
        connection: null,
        status: 'idle',
        hostKeyPrompt: null,
      }));
      return;
    }
    const current = get().runtimes[server.id];
    if (current && current.status !== 'idle') return;
    await startConnection(set, get, server.id, identity);
  },
  connectServer: async (serverId) => {
    const identity = get().runtimes[serverId]?.connectionIdentity ?? null;
    await startConnection(set, get, serverId, identity);
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
    await startConnection(
      set,
      get,
      serverId,
      get().runtimes[serverId]?.connectionIdentity ?? null,
    );
  },
  trustHostKey: async (serverId) => {
    const core = get().core;
    const runtime = get().runtimes[serverId];
    const prompt = runtime?.hostKeyPrompt ?? runtime?.hostKeyChangedPrompt;
    if (!core || !runtime || !prompt) return;
    const identity = runtime.connectionIdentity;
    const verificationId = prompt.verificationId;
    try {
      await core.trustHostKey(serverId, verificationId);
      const current = get().runtimes[serverId];
      if (!current || current.connectionIdentity !== identity) return;
      updateRuntime(set, serverId, (currentRuntime) => ({
        ...currentRuntime,
        hostKeyPrompt: null,
        hostKeyChangedPrompt: null,
        status: 'idle',
        error: null,
      }));
      await startConnection(set, get, serverId, identity);
    } catch (error) {
      const current = get().runtimes[serverId];
      if (current?.connectionIdentity === identity) {
        updateRuntime(set, serverId, (currentRuntime) => ({
          ...currentRuntime,
          status: 'error',
          error: connectionErrorMessage(error),
        }));
      }
    }
  },
  dismissHostKey: (serverId) => {
    updateRuntime(set, serverId, (current) => ({
      ...current,
      hostKeyPrompt: null,
      hostKeyChangedPrompt: null,
      status: 'closed',
      error: '已取消主机指纹确认，SSH 连接尚未建立',
    }));
  },
  openSession: async (serverId) => {
    const core = get().core;
    const runtime = get().runtimes[serverId];
    if (!core || !runtime?.connection || runtime.status !== 'ready') return null;
    if (
      countOpenSessions(runtime) + runtime.openingSessions
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
        || current.connectionIdentity !== runtime.connectionIdentity
        || current.connection?.connectionId !== runtime.connection.connectionId
        || !sameConnection(session.connection, runtime.connection)
      ) {
        discardPendingTerminalEvents(session.id);
        await core.closeTerminal(session.id).catch(() => undefined);
        return null;
      }
      const view = addTerminalSession(set, get, serverId, session);
      drainPendingTerminalEvents(set, session.id);
      return view;
    } catch (error) {
      if (get().runtimes[serverId]) {
        updateRuntime(set, serverId, (current) => ({
          ...current,
          error: openSessionErrorMessage(error),
        }));
      }
      return null;
    } finally {
      if (get().runtimes[serverId]) {
        updateRuntime(set, serverId, (current) => ({
          ...current,
          openingSessions: Math.max(0, current.openingSessions - 1),
        }));
      }
    }
  },
  openDockerSession: async (serverId, containerId, shell) => {
    const core = get().core;
    const runtime = get().runtimes[serverId];
    if (!core || !runtime?.connection || runtime.status !== 'ready') {
      return {
        kind: 'error',
        error: sessionError(
          'SSH_CONNECTION',
          '服务器离线或 SSH 连接尚未就绪，请重新连接',
          true,
        ),
      };
    }
    if (
      countOpenSessions(runtime) + runtime.openingSessions
      >= MAX_TERMINAL_SESSIONS
    ) {
      return {
        kind: 'error',
        error: sessionError(
          'CONFLICT',
          `每个服务器最多同时打开 ${MAX_TERMINAL_SESSIONS} 个终端会话`,
          false,
        ),
      };
    }

    updateRuntime(set, serverId, (current) => ({
      ...current,
      openingSessions: current.openingSessions + 1,
    }));
    try {
      const opened = await core.execDockerContainer(
        runtime.connection,
        containerId,
        shell,
        DEFAULT_COLUMNS,
        DEFAULT_ROWS,
      );
      const current = get().runtimes[serverId];
      if (
        !current
        || current.connectionIdentity !== runtime.connectionIdentity
        || current.connection?.connectionId !== runtime.connection.connectionId
        || !sameConnection(opened.connection, runtime.connection)
      ) {
        discardPendingTerminalEvents(opened.id);
        await core.closeTerminal(opened.id).catch(() => undefined);
        return {
          kind: 'error',
          error: sessionError(
            'CONFLICT',
            '服务器连接已变化，Docker exec 会话未接入终端',
            false,
          ),
        };
      }
      const view = addTerminalSession(set, get, serverId, opened);
      drainPendingTerminalEvents(set, opened.id);
      return { kind: 'opened', session: view };
    } catch (error) {
      return { kind: 'error', error: coreError(error) };
    } finally {
      if (get().runtimes[serverId]) {
        updateRuntime(set, serverId, (current) => ({
          ...current,
          openingSessions: Math.max(0, current.openingSessions - 1),
        }));
      }
    }
  },
  closeSession: async (serverId, sessionId) => {
    const core = get().core;
    markSessionClosing(sessionId);
    try {
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
    } finally {
      unmarkSessionClosing(sessionId);
    }
  },
  reconnectSession: async (serverId, sessionId) => {
    const existing = reconnectRequests.get(sessionId);
    if (existing) return existing;
    const core = get().core;
    const runtime = get().runtimes[serverId];
    const session = runtime?.sessions.find((candidate) => candidate.id === sessionId);
    if (!core || !runtime || !session || isSessionClosing(sessionId)) return;
    const identity = runtime.connectionIdentity;
    const generation = connectionGenerations.get(serverId) ?? 0;
    const currentRuntime = () => {
      if ((connectionGenerations.get(serverId) ?? 0) !== generation) return null;
      const current = get().runtimes[serverId];
      return current?.connectionIdentity === identity ? current : null;
    };
    const replace = async (
      opened: TerminalSession,
      expectedConnection: ConnectionHandle,
    ): Promise<boolean> => {
      const current = currentRuntime();
      if (
        !current
        || !current.sessions.some((candidate) => candidate.id === sessionId)
        || isSessionClosing(sessionId)
        || !sameConnection(opened.connection, expectedConnection)
      ) {
        discardPendingTerminalEvents(opened.id);
        await core.closeTerminal(opened.id).catch(() => undefined);
        return false;
      }
      const replaced = replaceTerminalSession(set, serverId, sessionId, opened);
      if (!replaced) {
        discardPendingTerminalEvents(opened.id);
        await core.closeTerminal(opened.id).catch(() => undefined);
        return false;
      }
      drainPendingTerminalEvents(set, opened.id);
      return true;
    };
    const releaseUnusedReconnectConnection = async (
      connection: ConnectionHandle,
    ) => {
      const current = currentRuntime();
      if (
        !current?.connection
        || !sameConnection(current.connection, connection)
        || countOpenSessions(current) > 0
      ) {
        return;
      }
      try {
        await core.disconnect(connection);
      } catch (error) {
        const after = currentRuntime();
        if (
          after?.connection
          && sameConnection(after.connection, connection)
        ) {
          updateRuntime(set, serverId, (runtime) => ({
            ...runtime,
            error: connectionErrorMessage(error),
          }));
        }
      }
    };

    const request = (async () => {
      if (runtime.connection) {
        try {
          const opened = await core.openTerminal(
            runtime.connection,
            DEFAULT_COLUMNS,
            DEFAULT_ROWS,
          );
          await replace(opened, runtime.connection);
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
      const afterDisconnect = currentRuntime();
      if (!afterDisconnect) return;
      if (!afterDisconnect.sessions.some((candidate) => candidate.id === sessionId)) {
        updateRuntime(set, serverId, (current) => ({
          ...current,
          connection: null,
          status: 'closed',
          error: '终端会话已关闭，未重新建立 SSH 连接',
        }));
        return;
      }
      updateRuntime(set, serverId, (current) => ({
        ...current,
        connection: null,
        status: 'idle',
        error: null,
      }));
      await startConnection(set, get, serverId, identity, false);
      const connected = get().runtimes[serverId];
      if (
        !connected
        || (connectionGenerations.get(serverId) ?? 0) !== generation
        || connected.connectionIdentity !== identity
      ) {
        return;
      }
      if (!connected.connection) return;
      if (
        isSessionClosing(sessionId)
        || !connected.sessions.some((candidate) => candidate.id === sessionId)
      ) {
        try {
          await core.disconnect(connected.connection);
        } catch {
          // The original tab is gone; keep the handle visible if teardown fails.
        }
        const current = get().runtimes[serverId];
        if (
          current
          && (connectionGenerations.get(serverId) ?? 0) === generation
          && current.connectionIdentity === identity
          && current.connection?.connectionId === connected.connection.connectionId
        ) {
          updateRuntime(set, serverId, (runtime) => ({
            ...runtime,
            error: '终端会话已关闭，重新建立的 SSH 连接已释放',
          }));
        }
        return;
      }
      try {
        const opened = await core.openTerminal(
          connected.connection,
          DEFAULT_COLUMNS,
          DEFAULT_ROWS,
        );
        if (!await replace(opened, connected.connection)) {
          await releaseUnusedReconnectConnection(connected.connection);
        }
      } catch (error) {
        const currentRuntimeState = currentRuntime();
        if (
          currentRuntimeState
          && (
            isSessionClosing(sessionId)
            || !currentRuntimeState.sessions.some(
              (candidate) => candidate.id === sessionId,
            )
          )
        ) {
          await releaseUnusedReconnectConnection(connected.connection);
        } else if (get().runtimes[serverId]) {
          updateRuntime(set, serverId, (current) => ({
            ...current,
            error: openSessionErrorMessage(error),
          }));
        }
      }
    })().finally(() => {
      if (reconnectRequests.get(sessionId) === request) {
        reconnectRequests.delete(sessionId);
      }
    });
    reconnectRequests.set(sessionId, request);
    await request;
  },
  activateSession: (serverId, sessionId) => {
    updateRuntime(set, serverId, (current) => (
      current.sessions.some((session) => session.id === sessionId)
        ? { ...current, activeSessionId: sessionId }
        : current
    ));
  },
  setWorkingDirectory: (sessionId, directory) => {
    if (directory === null) return;
    const parsed = RemoteDirectoryPathSchema.safeParse(directory);
    if (!parsed.success) return;
    const located = locateSession(get().runtimes, sessionId);
    if (!located) return;
    const session = located.runtime.sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session || session.status !== 'open') return;
    updateTerminalSession(set, located.serverId, sessionId, (current) => ({
      ...current,
      cwd: parsed.data,
    }));
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
    const previous = terminalWriteQueues.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => core.writeTerminal(sessionId, bytes));
    terminalWriteQueues.set(sessionId, current);
    try {
      await current;
    } catch (error) {
      const located = locateSession(get().runtimes, sessionId);
      if (located && coreErrorCode(error) !== 'NOT_FOUND') {
        updateRuntime(set, located.serverId, (current) => ({
          ...current,
          error: openSessionErrorMessage(error),
        }));
      }
    } finally {
      if (terminalWriteQueues.get(sessionId) === current) {
        terminalWriteQueues.delete(sessionId);
      }
    }
  },
  disconnectServer: async (serverId) => {
    const core = get().core;
    const runtime = get().runtimes[serverId];
    const generation = invalidateConnectionRequests(serverId);
    if (core && runtime?.connection) {
      try {
        await core.disconnect(runtime.connection);
      } catch (error) {
        const code = coreErrorCode(error);
        if (code !== 'NOT_FOUND' && code !== 'SSH_CONNECTION') {
          updateRuntime(set, serverId, (current) => ({
            ...current,
            error: connectionErrorMessage(error),
          }));
          return;
        }
      }
    }
    if ((connectionGenerations.get(serverId) ?? 0) !== generation) return;
    clearServerSessions(set, serverId, 'connectionClosed');
    updateRuntime(set, serverId, (current) => ({
      ...current,
      connection: null,
      status: 'closed',
    }));
  },
  disposeServer: async (serverId) => {
    const runtime = get().runtimes[serverId];
    const core = get().core;
    invalidateConnectionRequests(serverId);
    for (const session of runtime?.sessions ?? []) {
      discardPendingTerminalEvents(session.id);
      reconnectRequests.delete(session.id);
    }
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
    clearServerSessions(set, serverId, 'connectionClosed');
    for (const session of runtime?.sessions ?? []) {
      terminalOutput.delete(session.id);
    }
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
    connectionGenerations.clear();
    reconnectRequests.clear();
    closingSessionCounts.clear();
    terminalWriteQueues.clear();
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

async function startConnection(
  set: SetState,
  get: () => TerminalStore,
  serverId: string,
  identity: string | null,
  openInitialSession = true,
) {
  const existing = connectionRequests.get(serverId);
  if (existing) return existing.promise;
  const runtime = get().runtimes[serverId];
  if (runtime?.status === 'connecting' || runtime?.status === 'host-key') return;
  if (runtime?.status === 'ready') {
    if (
      openInitialSession
      && countOpenSessions(runtime) + runtime.openingSessions === 0
    ) {
      await get().openSession(serverId);
    }
    return;
  }
  const core = get().core;
  if (!core) {
    updateRuntime(set, serverId, (current) => ({
      ...current,
      connectionIdentity: identity,
      status: 'error',
      error: 'Core 尚未连接，无法建立 SSH 连接',
    }));
    return;
  }

  const generation = connectionGenerations.get(serverId) ?? 0;
  const isCurrent = () => (
    (connectionGenerations.get(serverId) ?? 0) === generation
    && get().runtimes[serverId]?.connectionIdentity === identity
  );
  const request: ConnectionRequest = {
    generation,
    promise: (async () => {
      updateRuntime(set, serverId, (current) => ({
        ...current,
        connectionIdentity: identity,
        status: 'connecting',
        error: null,
        hostKeyPrompt: null,
      }));
      try {
        const outcome = await core.connect(serverId);
        if (!isCurrent()) {
          if (outcome.kind === 'ready') {
            await core.disconnect(outcome.connection).catch(() => undefined);
          }
          return;
        }
        applyConnectOutcome(set, serverId, outcome);
        if (outcome.kind === 'ready') {
          useHarborStore.getState().markServerConnected(serverId);
        }
        const connected = get().runtimes[serverId];
        if (
          openInitialSession
          && outcome.kind === 'ready'
          && connected
          && countOpenSessions(connected) + connected.openingSessions === 0
        ) {
          await get().openSession(serverId);
        }
      } catch (error) {
        if (!isCurrent()) return;
        updateRuntime(set, serverId, (current) => ({
          ...current,
          status: 'error',
          error: connectionErrorMessage(error),
        }));
      }
    })(),
  };
  connectionRequests.set(serverId, request);
  try {
    await request.promise;
  } finally {
    if (connectionRequests.get(serverId) === request) {
      connectionRequests.delete(serverId);
    }
  }
}

function invalidateConnectionRequests(serverId: string): number {
  connectionRequests.delete(serverId);
  const generation = (connectionGenerations.get(serverId) ?? 0) + 1;
  connectionGenerations.set(serverId, generation);
  return generation;
}

function isSessionClosing(sessionId: string): boolean {
  return (closingSessionCounts.get(sessionId) ?? 0) > 0;
}

function markSessionClosing(sessionId: string) {
  closingSessionCounts.set(
    sessionId,
    (closingSessionCounts.get(sessionId) ?? 0) + 1,
  );
}

function unmarkSessionClosing(sessionId: string) {
  const count = closingSessionCounts.get(sessionId) ?? 0;
  if (count <= 1) {
    closingSessionCounts.delete(sessionId);
  } else {
    closingSessionCounts.set(sessionId, count - 1);
  }
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
          hostKeyChangedPrompt: null,
        };
      case 'hostKeyRequired':
        return {
          ...current,
          status: 'host-key',
          hostKeyPrompt: outcome.prompt,
          hostKeyChangedPrompt: null,
          error: null,
        };
      case 'hostKeyChanged':
        return {
          ...current,
          status: 'host-key',
          hostKeyPrompt: null,
          hostKeyChangedPrompt: outcome.prompt,
          error: null,
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
    cwd: null,
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
): boolean {
  const runtime = useTerminalStore.getState().runtimes[serverId];
  if (!runtime?.sessions.some((session) => session.id === previousSessionId)) {
    return false;
  }
  const previousOutput = terminalOutput.get(previousSessionId);
  terminalOutput.delete(previousSessionId);
  if (previousOutput) {
    terminalOutput.set(opened.id, {
      chunks: [...previousOutput.chunks],
      bytes: previousOutput.bytes,
      listeners: new Set(),
    });
  }
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
            cwd: null,
            closeReason: undefined,
            exitStatus: undefined,
          }
        : session
    )),
  }));
  return true;
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
  serverId: string,
  reason: TerminalCloseReason,
) {
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
  if (
    !session
    || session.status === 'closed'
    || event.sequence <= session.lastSequence
  ) return;
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
  const session = located.runtime.sessions.find(
    (candidate) => candidate.id === event.terminalSessionId,
  );
  if (!session || session.status === 'closed') return;
  updateTerminalSession(set, located.serverId, event.terminalSessionId, (current) => ({
    ...current,
    gap: true,
  }));
}

function applyTerminalClosed(set: SetState, event: TerminalClosedEvent) {
  const located = locateSession(useTerminalStore.getState().runtimes, event.terminalSessionId);
  if (!located) return;
  const session = located.runtime.sessions.find(
    (candidate) => candidate.id === event.terminalSessionId,
  );
  if (!session || session.status === 'closed') return;
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
  if (event.kind !== 'closed' && buffer.events.some(({ kind }) => kind === 'closed')) {
    return;
  }
  if (event.kind === 'closed') {
    buffer.events = buffer.events.filter(({ kind }) => kind !== 'closed');
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
    const dataIndex = buffer.events.findIndex(({ kind }) => kind === 'data');
    if (dataIndex < 0) break;
    const [removed] = buffer.events.splice(dataIndex, 1);
    if (!removed || removed.kind !== 'data') break;
    buffer.bytes = Math.max(0, buffer.bytes - removed.event.bytes.length);
    buffer.overflowMissed += 1;
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

function sameConnection(
  left: ConnectionHandle,
  right: ConnectionHandle,
): boolean {
  return (
    left.serverId === right.serverId
    && left.connectionId === right.connectionId
  );
}

function emptyRuntime(serverId: string): ServerRuntime {
  return {
    serverId,
    connectionIdentity: null,
    connection: null,
    status: 'idle',
    error: null,
    hostKeyPrompt: null,
    hostKeyChangedPrompt: null,
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

function coreError(error: unknown): CoreError {
  const parsed = CoreErrorSchema.safeParse(error);
  if (parsed.success) return parsed.data;
  return sessionError(
    'INTERNAL',
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : 'Docker exec 会话创建失败',
    false,
  );
}

function sessionError(
  code: CoreError['code'],
  message: string,
  retryable: boolean,
): CoreError {
  return { code, message, retryable };
}

type SetState = (
  partial:
    | Partial<TerminalStore>
    | ((state: TerminalStore) => Partial<TerminalStore> | TerminalStore),
) => void;
