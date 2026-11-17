import {
  CoreErrorSchema,
  type ConnectionHandle,
  type CoreError,
  type DockerAction,
  type DockerContainer,
} from '@opspilot/contracts';
import { create } from 'zustand';

import type { CoreClient } from '../api/core';

export type DockerLoadStatus = 'idle' | 'loading' | 'ready' | 'error';
export type DockerLogsStatus = 'loading' | 'ready' | 'error';

export interface DockerLogsState {
  containerId: string;
  containerName: string;
  tail: number;
  status: DockerLogsStatus;
  stdout: string;
  stderr: string;
  error: CoreError | null;
}

export interface DockerServerState {
  connectionId: string | null;
  status: DockerLoadStatus;
  containers: DockerContainer[];
  startedAtWarning: string | null;
  error: CoreError | null;
  action: { containerId: string; action: DockerAction } | null;
  actionError: CoreError | null;
  notice: string | null;
  logs: DockerLogsState | null;
}

interface DockerStore {
  core: CoreClient | null;
  states: Record<string, DockerServerState>;
  setCore: (core: CoreClient | null) => void;
  loadContainers: (
    serverId: string,
    connection: ConnectionHandle,
  ) => Promise<boolean>;
  runDockerAction: (
    serverId: string,
    connection: ConnectionHandle,
    container: DockerContainer,
    action: DockerAction,
  ) => Promise<void>;
  openLogs: (
    serverId: string,
    connection: ConnectionHandle,
    container: DockerContainer,
    tail: number,
  ) => Promise<void>;
  closeLogs: (serverId: string) => void;
  clearNotice: (serverId: string) => void;
  reset: () => void;
}

const loadSequences = new Map<string, number>();
const logSequences = new Map<string, number>();

export const useDockerStore = create<DockerStore>((set, get) => ({
  core: null,
  states: {},
  setCore: (core) => set({ core }),
  loadContainers: async (serverId, connection) => {
    const core = get().core;
    const sequence = nextSequence(loadSequences, serverId);
    const previous = get().states[serverId] ?? emptyState();
    const connectionChanged = (
      previous.connectionId !== null
      && previous.connectionId !== connection.connectionId
    );
    const actionInFlight = !connectionChanged && previous.action !== null;
    updateState(set, serverId, {
      ...previous,
      connectionId: connection.connectionId,
      status: 'loading',
      containers: connectionChanged ? [] : previous.containers,
      startedAtWarning: connectionChanged ? null : previous.startedAtWarning,
      error: null,
      action: actionInFlight ? previous.action : null,
      actionError: actionInFlight ? previous.actionError : null,
      notice: actionInFlight ? previous.notice : null,
      logs: connectionChanged ? null : previous.logs,
    });
    if (!core) {
      const error = internalError('Core 尚未连接，无法读取 Docker 容器');
      updateState(set, serverId, {
        ...get().states[serverId],
        status: 'error',
        error,
      });
      return false;
    }

    try {
      const result = await core.listDockerContainers(connection);
      if (!isCurrentLoad(get(), serverId, sequence, connection.connectionId)) {
        return false;
      }
      const current = get().states[serverId] ?? emptyState();
      updateState(set, serverId, {
        ...current,
        status: 'ready',
        containers: result.containers,
        startedAtWarning: result.startedAtWarning,
        error: null,
      });
      return true;
    } catch (error) {
      if (!isCurrentLoad(get(), serverId, sequence, connection.connectionId)) {
        return false;
      }
      const current = get().states[serverId] ?? emptyState();
      updateState(set, serverId, {
        ...current,
        status: current.containers.length > 0 ? 'ready' : 'error',
        error: dockerCoreError(error),
      });
      return false;
    }
  },
  runDockerAction: async (serverId, connection, container, action) => {
    const core = get().core;
    const previous = get().states[serverId] ?? emptyState();
    if (
      previous.connectionId !== null
      && previous.connectionId !== connection.connectionId
    ) {
      updateState(set, serverId, {
        ...previous,
        action: null,
        actionError: internalError('Docker 连接已变化，请刷新容器列表'),
      });
      return;
    }
    if (!core) {
      updateState(set, serverId, {
        ...previous,
        action: null,
        actionError: internalError('Core 尚未连接，无法执行 Docker 操作'),
      });
      return;
    }
    if (previous.action !== null) return;
    updateState(set, serverId, {
      ...previous,
      connectionId: connection.connectionId,
      action: { containerId: container.id, action },
      actionError: null,
      notice: null,
    });
    try {
      await core.runDockerAction(connection, container.id, action);
    } catch (error) {
      const current = get().states[serverId] ?? previous;
      if (current.connectionId !== connection.connectionId) return;
      updateState(set, serverId, {
        ...current,
        action: null,
        actionError: dockerCoreError(error),
      });
      return;
    }

    const current = get().states[serverId] ?? previous;
    if (current.connectionId !== connection.connectionId) return;
    const label = dockerActionLabel(action);
    updateState(set, serverId, {
      ...current,
      action: null,
      actionError: null,
      notice: label,
    });
    const refreshed = await get().loadContainers(serverId, connection);
    const afterRefresh = get().states[serverId];
    if (afterRefresh?.connectionId !== connection.connectionId) return;
    updateState(set, serverId, {
      ...afterRefresh,
      notice: refreshed ? label : '操作已完成、刷新失败',
    });
  },
  openLogs: async (serverId, connection, container, tail) => {
    const core = get().core;
    const sequence = nextSequence(logSequences, serverId);
    const previous = get().states[serverId] ?? emptyState();
    const logs: DockerLogsState = {
      containerId: container.id,
      containerName: container.names[0] ?? container.id,
      tail,
      status: 'loading',
      stdout: '',
      stderr: '',
      error: null,
    };
    updateState(set, serverId, {
      ...previous,
      connectionId: connection.connectionId,
      logs,
    });
    if (!core) {
      updateLogs(set, get, serverId, sequence, connection.connectionId, {
        ...logs,
        status: 'error',
        error: internalError('Core 尚未连接，无法读取容器日志'),
      });
      return;
    }
    try {
      const result = await core.getDockerLogs(connection, container.id, tail);
      updateLogs(set, get, serverId, sequence, connection.connectionId, {
        ...logs,
        status: 'ready',
        stdout: result.stdout,
        stderr: result.stderr,
      });
    } catch (error) {
      updateLogs(set, get, serverId, sequence, connection.connectionId, {
        ...logs,
        status: 'error',
        error: dockerCoreError(error),
      });
    }
  },
  closeLogs: (serverId) => {
    nextSequence(logSequences, serverId);
    const current = get().states[serverId];
    if (!current) return;
    updateState(set, serverId, { ...current, logs: null });
  },
  clearNotice: (serverId) => {
    const current = get().states[serverId];
    if (!current) return;
    updateState(set, serverId, { ...current, notice: null });
  },
  reset: () => {
    loadSequences.clear();
    logSequences.clear();
    set({ core: null, states: {} });
  },
}));

export function dockerErrorMessage(error: unknown): string {
  const parsed = CoreErrorSchema.safeParse(error);
  if (parsed.success) {
    switch (parsed.data.code) {
      case 'DOCKER_NOT_INSTALLED':
        return '未检测到 Docker CLI，请先在服务器安装 Docker';
      case 'DOCKER_PERMISSION_DENIED':
        return '当前 SSH 用户无权访问 Docker socket，请检查 docker 组或账号权限';
      case 'DOCKER_DAEMON_UNAVAILABLE':
        return 'Docker daemon 未运行，请启动 daemon 后重试';
      case 'DOCKER_CONTAINER_NOT_FOUND':
        return '容器已不存在，请刷新列表';
      case 'DOCKER_SHELL_UNAVAILABLE':
        return '容器内没有该 shell，请改用 sh、bash 或 ash';
      case 'SSH_CONNECTION':
        return '服务器离线，请重新连接 SSH';
      case 'REMOTE_PARSE':
        return 'Docker 输出无法解析，可能是不兼容的 Docker 版本';
      case 'REMOTE_COMMAND':
        return remoteCommandMessage(parsed.data.message);
      case 'TIMEOUT':
        return 'Docker 操作超时，请重试';
      case 'CONFLICT':
        return `Docker 操作冲突：${parsed.data.message}`;
      case 'NOT_FOUND':
        return 'SSH 连接或容器已不存在，请刷新后重试';
      default:
        return parsed.data.message;
    }
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return 'Docker 操作失败，请重试';
}

function remoteCommandMessage(message: string): string {
  if (/is not running/iu.test(message)) {
    return '容器未运行，无法执行该操作';
  }
  if (/already running/iu.test(message)) {
    return '容器已在运行，无需重复启动';
  }
  if (/is paused/iu.test(message)) {
    return '容器已暂停，请先恢复容器再执行该操作';
  }
  if (/port is already allocated/iu.test(message)) {
    return '容器端口已被占用，启动失败';
  }
  return `Docker 命令执行失败：${message}`;
}

export function dockerActionLabel(action: DockerAction): string {
  switch (action) {
    case 'start':
      return '容器已启动';
    case 'stop':
      return '容器已停止';
    case 'restart':
      return '容器已重启';
  }
}

function emptyState(): DockerServerState {
  return {
    connectionId: null,
    status: 'idle',
    containers: [],
    startedAtWarning: null,
    error: null,
    action: null,
    actionError: null,
    notice: null,
    logs: null,
  };
}

function updateState(
  set: (
    partial:
      | Partial<DockerStore>
      | ((state: DockerStore) => Partial<DockerStore>),
  ) => void,
  serverId: string,
  state: DockerServerState,
) {
  set((current) => ({
    states: {
      ...current.states,
      [serverId]: state,
    },
  }));
}

function updateLogs(
  set: (
    partial:
      | Partial<DockerStore>
      | ((state: DockerStore) => Partial<DockerStore>),
  ) => void,
  get: () => DockerStore,
  serverId: string,
  sequence: number,
  connectionId: string,
  logs: DockerLogsState,
) {
  const current = get().states[serverId];
  if (
    !current
    || current.connectionId !== connectionId
    || logSequences.get(serverId) !== sequence
    || current.logs?.containerId !== logs.containerId
    || current.logs.tail !== logs.tail
  ) {
    return;
  }
  updateState(set, serverId, { ...current, logs });
}

function nextSequence(sequences: Map<string, number>, serverId: string): number {
  const next = (sequences.get(serverId) ?? 0) + 1;
  sequences.set(serverId, next);
  return next;
}

function isCurrentLoad(
  state: DockerStore,
  serverId: string,
  sequence: number,
  connectionId: string,
): boolean {
  return (
    loadSequences.get(serverId) === sequence
    && state.states[serverId]?.connectionId === connectionId
  );
}

function dockerCoreError(error: unknown): CoreError {
  const parsed = CoreErrorSchema.safeParse(error);
  if (parsed.success) return parsed.data;
  return internalError(
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : 'Docker 操作失败，请重试',
  );
}

function internalError(message: string): CoreError {
  return {
    code: 'INTERNAL',
    message,
    retryable: false,
  };
}
