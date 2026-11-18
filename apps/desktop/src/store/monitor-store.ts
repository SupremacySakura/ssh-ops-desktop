import {
  CoreErrorSchema,
  type ConnectionHandle,
  type MonitorProcess,
  type MonitorSnapshot,
  type MonitorUnavailable,
} from '@opspilot/contracts';
import { create } from 'zustand';

import type { CoreClient } from '../api/core';

export const MAX_MONITOR_POINTS = 150;
export const MONITOR_SAMPLE_INTERVAL_MS = 2_000;
export const MONITOR_CHART_WINDOW_MS = 5 * 60 * 1_000;
export const MONITOR_CHART_GAP_MS = 5_000;
export const MONITOR_STALE_AFTER_MS = 6_000;

export interface MonitorPoint {
  timestamp: number;
  cpuPercent: number | null;
  memoryPercent: number | null;
}

export type MonitorProcessSort = 'cpu' | 'memory';
export type MonitorPhase = 'idle' | 'sampling' | 'ready' | 'error' | 'offline';

export interface MonitorViewState {
  connectionId: string | null;
  phase: MonitorPhase;
  latest: MonitorSnapshot | null;
  samples: MonitorPoint[];
  error: string | null;
  unavailable: MonitorUnavailable[];
  inFlight: boolean;
  lastUpdatedAt: number | null;
}

interface MonitorState {
  states: Record<string, MonitorViewState>;
  startSampling: (core: CoreClient, connection: ConnectionHandle) => void;
  stopSampling: (
    serverId: string,
    connectionId?: string,
    reason?: 'idle' | 'offline',
  ) => void;
  retrySampling: (serverId: string) => void;
  reset: () => void;
}

type SetState = (
  updater: (state: MonitorState) => Partial<MonitorState>,
) => void;

interface MonitorSession {
  core: CoreClient;
  connection: ConnectionHandle;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  inFlight: boolean;
}

const sessions = new Map<string, MonitorSession>();

export function memoryPercent(snapshot: MonitorSnapshot): number | null {
  const memory = snapshot.memory;
  if (!memory || memory.totalBytes <= 0) return null;
  return clampPercent((memory.usedBytes / memory.totalBytes) * 100);
}

export function diskPercent(snapshot: MonitorSnapshot): number | null {
  const disk = snapshot.disk;
  if (!disk || disk.totalBytes <= 0) return null;
  return clampPercent((disk.usedBytes / disk.totalBytes) * 100);
}

export function appendMonitorPoint(
  points: MonitorPoint[],
  snapshot: MonitorSnapshot,
): MonitorPoint[] {
  const timestamp = Date.parse(snapshot.timestamp);
  if (!Number.isFinite(timestamp)) return points;
  const last = points.at(-1);
  if (last && timestamp <= last.timestamp) return points;
  const next = [...points, {
    timestamp,
    cpuPercent: snapshot.cpuPercent ?? null,
    memoryPercent: memoryPercent(snapshot),
  }];
  return next.length > MAX_MONITOR_POINTS
    ? next.slice(-MAX_MONITOR_POINTS)
    : next;
}

export function sortMonitorProcesses(
  processes: MonitorProcess[],
  sort: MonitorProcessSort,
): MonitorProcess[] {
  const field = sort === 'cpu' ? 'cpuPercent' : 'memoryPercent';
  return [...processes]
    .sort((left, right) => (
      right[field] - left[field]
      || left.pid - right.pid
      || left.name.localeCompare(right.name)
    ))
    .slice(0, 10);
}

export function buildMonitorChartSegments(
  points: MonitorPoint[],
  field: 'cpuPercent' | 'memoryPercent',
  width: number,
  height: number,
): string[] {
  const end = points.at(-1)?.timestamp;
  if (end === undefined) return [];
  const start = end - MONITOR_CHART_WINDOW_MS;
  const segments: string[] = [];
  let current = '';
  let previousTimestamp: number | null = null;

  for (const point of points) {
    if (point.timestamp < start) continue;
    const value = point[field];
    if (value === null) {
      if (current) segments.push(current);
      current = '';
      previousTimestamp = null;
      continue;
    }
    const x = ((point.timestamp - start) / MONITOR_CHART_WINDOW_MS) * width;
    const y = height - (clampPercent(value) / 100) * height;
    const coordinate = `${round(x)} ${round(y)}`;
    if (
      previousTimestamp === null
      || point.timestamp - previousTimestamp > MONITOR_CHART_GAP_MS
    ) {
      if (current) segments.push(current);
      current = `M ${coordinate}`;
    } else {
      current += ` L ${coordinate}`;
    }
    previousTimestamp = point.timestamp;
  }
  if (current) segments.push(current);
  return segments;
}

export function snapshotHasData(snapshot: MonitorSnapshot): boolean {
  return snapshot.cpuPercent !== undefined
    || snapshot.memory !== undefined
    || snapshot.disk !== undefined
    || snapshot.load !== undefined
    || snapshot.uptimeSeconds !== undefined
    || snapshot.topProcesses.length > 0;
}

export function isMonitorSnapshotStale(
  lastUpdatedAt: number | null,
  now: number,
): boolean {
  return lastUpdatedAt !== null && now - lastUpdatedAt > MONITOR_STALE_AFTER_MS;
}

export const useMonitorStore = create<MonitorState>((set, get) => ({
  states: {},
  startSampling: (core, connection) => {
    const current = sessions.get(connection.serverId);
    if (
      current
      && current.core === core
      && current.connection.connectionId === connection.connectionId
    ) {
      return;
    }
    if (current) stopSession(current);

    const session: MonitorSession = {
      core,
      connection,
      timer: null,
      stopped: false,
      inFlight: false,
    };
    sessions.set(connection.serverId, session);
    set((state) => {
      const previous = state.states[connection.serverId] ?? emptyMonitorState();
      const connectionChanged = previous.connectionId !== connection.connectionId;
      return {
        states: {
          ...state.states,
          [connection.serverId]: {
            ...previous,
            connectionId: connection.connectionId,
            phase: 'sampling',
            latest: null,
            samples: connectionChanged ? [] : previous.samples,
            error: null,
            unavailable: [],
            inFlight: false,
            lastUpdatedAt: null,
          },
        },
      };
    });
    void runSample(set, get, session);
  },
  stopSampling: (serverId, connectionId, reason = 'idle') => {
    const session = sessions.get(serverId);
    if (session && connectionId && session.connection.connectionId !== connectionId) {
      return;
    }
    if (session) stopSession(session);
    set((state) => {
      const previous = state.states[serverId];
      if (
        !previous
        || (connectionId && previous.connectionId && previous.connectionId !== connectionId)
      ) {
        return state;
      }
      return {
        states: {
          ...state.states,
          [serverId]: {
            ...previous,
            connectionId: null,
            phase: reason,
            latest: null,
            samples: [],
            error: reason === 'offline' ? '服务器离线，请重连后继续采样' : null,
            unavailable: [],
            inFlight: false,
            lastUpdatedAt: null,
          },
        },
      };
    });
  },
  retrySampling: (serverId) => {
    const session = sessions.get(serverId);
    if (!session || session.stopped || session.inFlight) return;
    if (session.timer !== null) clearTimeout(session.timer);
    session.timer = null;
    set((state) => {
      const previous = state.states[serverId];
      if (!previous) return state;
      return {
        states: {
          ...state.states,
          [serverId]: {
            ...previous,
            phase: 'sampling',
            error: null,
          },
        },
      };
    });
    void runSample(set, get, session);
  },
  reset: () => {
    for (const session of sessions.values()) stopSession(session);
    sessions.clear();
    set({ states: {} });
  },
}));

async function runSample(
  set: SetState,
  get: () => MonitorState,
  session: MonitorSession,
) {
  if (!isCurrentSession(session)) return;
  session.inFlight = true;
  set((state) => {
    const previous = state.states[session.connection.serverId];
    if (!previous) return state;
    return {
      states: {
        ...state.states,
        [session.connection.serverId]: {
          ...previous,
          phase: previous.latest ? previous.phase : 'sampling',
          error: null,
          inFlight: true,
        },
      },
    };
  });

  try {
    const snapshot = await session.core.monitorSnapshot(session.connection);
    if (!isCurrentSession(session)) return;
    const collectedAt = Date.now();
    set((state) => {
      const previous = state.states[session.connection.serverId];
      if (!previous) return state;
      if (!snapshotHasData(snapshot)) {
        return {
          states: {
            ...state.states,
            [session.connection.serverId]: {
              ...previous,
              phase: 'error',
              latest: null,
              error: '采集失败：服务器未返回可用监控数据',
              unavailable: snapshot.unavailable,
              inFlight: false,
              lastUpdatedAt: collectedAt,
            },
          },
        };
      }
      return {
        states: {
          ...state.states,
          [session.connection.serverId]: {
            ...previous,
            phase: 'ready',
            latest: snapshot,
            samples: appendMonitorPoint(previous.samples, snapshot),
            error: null,
            unavailable: snapshot.unavailable,
            inFlight: false,
            lastUpdatedAt: collectedAt,
          },
        },
      };
    });
  } catch (error) {
    if (!isCurrentSession(session)) return;
    const code = coreErrorCode(error);
    const offline = code === 'SSH_CONNECTION' || code === 'NOT_FOUND';
    set((state) => {
      const previous = state.states[session.connection.serverId];
      if (!previous) return state;
      return {
        states: {
          ...state.states,
          [session.connection.serverId]: {
            ...previous,
            phase: offline ? 'offline' : 'error',
            latest: null,
            error: offline
              ? 'SSH 连接已断开，监控采样已暂停'
              : monitorErrorMessage(error),
            unavailable: [],
            inFlight: false,
          },
        },
      };
    });
  } finally {
    session.inFlight = false;
    if (isCurrentSession(session)) {
      const phase = get().states[session.connection.serverId]?.phase;
      set((state) => {
        const previous = state.states[session.connection.serverId];
        if (!previous) return state;
        return {
          states: {
            ...state.states,
            [session.connection.serverId]: {
              ...previous,
              inFlight: false,
            },
          },
        };
      });
      if (phase !== 'offline') {
        session.timer = setTimeout(() => {
          session.timer = null;
          void runSample(set, get, session);
        }, MONITOR_SAMPLE_INTERVAL_MS);
      }
    }
  }
}

function stopSession(session: MonitorSession) {
  session.stopped = true;
  if (session.timer !== null) clearTimeout(session.timer);
  session.timer = null;
  if (sessions.get(session.connection.serverId) === session) {
    sessions.delete(session.connection.serverId);
  }
}

function isCurrentSession(session: MonitorSession): boolean {
  return (
    !session.stopped
    && sessions.get(session.connection.serverId) === session
    && useMonitorStore.getState().states[session.connection.serverId]?.connectionId
      === session.connection.connectionId
  );
}

function emptyMonitorState(): MonitorViewState {
  return {
    connectionId: null,
    phase: 'idle',
    latest: null,
    samples: [],
    error: null,
    unavailable: [],
    inFlight: false,
    lastUpdatedAt: null,
  };
}

function coreErrorCode(error: unknown): string | null {
  const parsed = CoreErrorSchema.safeParse(error);
  return parsed.success ? parsed.data.code : null;
}

function monitorErrorMessage(error: unknown): string {
  const parsed = CoreErrorSchema.safeParse(error);
  if (!parsed.success) return '监控采样失败，请重试';
  switch (parsed.data.code) {
    case 'TIMEOUT':
      return '监控采样超时，请重试';
    case 'REMOTE_PERMISSION':
      return '服务器拒绝读取系统指标';
    case 'CAPABILITY_UNAVAILABLE':
      return '服务器缺少监控所需的系统命令';
    case 'REMOTE_PARSE':
      return '服务器返回的监控数据无法解析';
    case 'CONFLICT':
      return hasCjk(parsed.data.message)
        ? parsed.data.message
        : 'SSH 连接已切换，请重新采样';
    case 'VALIDATION':
      return hasCjk(parsed.data.message)
        ? parsed.data.message
        : '监控采样参数无效，请重新连接后重试';
    default:
      return '监控采样失败，请重试';
  }
}

function hasCjk(message: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(message);
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
