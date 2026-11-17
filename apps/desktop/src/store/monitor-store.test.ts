import type { MonitorProcess, MonitorSnapshot } from '@opspilot/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeCoreClient } from '../test/fake-core';
import {
  MAX_MONITOR_POINTS,
  MONITOR_STALE_AFTER_MS,
  MONITOR_SAMPLE_INTERVAL_MS,
  appendMonitorPoint,
  buildMonitorChartSegments,
  isMonitorSnapshotStale,
  sortMonitorProcesses,
  useMonitorStore,
  type MonitorPoint,
} from './monitor-store';

function snapshot(timestamp: number, cpuPercent: number): MonitorSnapshot {
  return {
    timestamp: new Date(timestamp).toISOString(),
    cpuPercent,
    memory: {
      totalBytes: 100,
      availableBytes: 40,
      usedBytes: 60,
    },
    topProcesses: [],
    unavailable: [],
  };
}

const connection = {
  serverId: '019c62b2-2970-7000-8000-000000000101',
  connectionId: '019c62b2-2970-7000-8000-000000000102',
};

beforeEach(() => {
  useMonitorStore.getState().reset();
});

afterEach(() => {
  useMonitorStore.getState().reset();
  vi.useRealTimers();
});

describe('Monitoring ring buffer', () => {
  it('keeps the newest 150 points and ignores duplicate or out-of-order timestamps', () => {
    let points: MonitorPoint[] = [];
    for (let index = 0; index < 151; index += 1) {
      points = appendMonitorPoint(
        points,
        snapshot(1_700_000_000_000 + index * 2_000, index),
      );
    }

    expect(points).toHaveLength(MAX_MONITOR_POINTS);
    expect(points[0]?.timestamp).toBe(1_700_000_000_000 + 2_000);
    expect(points.at(-1)?.timestamp).toBe(1_700_000_000_000 + 150 * 2_000);
    expect(points.at(-1)).toMatchObject({
      cpuPercent: 150,
      memoryPercent: 60,
    });

    const duplicate = appendMonitorPoint(
      points,
      snapshot(1_700_000_000_000 + 150 * 2_000, 99),
    );
    expect(duplicate).toBe(points);

    const outOfOrder = appendMonitorPoint(
      points,
      snapshot(1_700_000_000_000 + 149 * 2_000, 98),
    );
    expect(outOfOrder).toBe(points);
  });
});

describe('Monitoring process sorting', () => {
  it('sorts the union by CPU or memory with PID as a stable tie-breaker', () => {
    const processes: MonitorProcess[] = [
      {
        pid: 3,
        user: 'root',
        name: 'worker-c',
        cpuPercent: 50,
        memoryPercent: 10,
      },
      {
        pid: 2,
        user: 'deploy',
        name: 'worker-b',
        cpuPercent: 50,
        memoryPercent: 20,
      },
      {
        pid: 1,
        user: 'postgres',
        name: 'worker-a',
        cpuPercent: 10,
        memoryPercent: 50,
      },
    ];

    expect(sortMonitorProcesses(processes, 'cpu').map((process) => process.pid))
      .toEqual([2, 3, 1]);
    expect(sortMonitorProcesses(processes, 'memory').map((process) => process.pid))
      .toEqual([1, 2, 3]);
    expect(sortMonitorProcesses(
      Array.from({ length: 12 }, (_, index) => ({
        ...processes[0],
        pid: index + 1,
        cpuPercent: index,
      })),
      'cpu',
    )).toHaveLength(10);
  });
});

describe('Monitoring chart geometry', () => {
  it('maps values into a five-minute SVG window and breaks paths at gaps', () => {
    const end = 1_700_000_300_000;
    const points: MonitorPoint[] = [
      { timestamp: end - 10_000, cpuPercent: 10, memoryPercent: 60 },
      { timestamp: end - 8_000, cpuPercent: 20, memoryPercent: 62 },
      { timestamp: end - 1_000, cpuPercent: 30, memoryPercent: 64 },
    ];

    const segments = buildMonitorChartSegments(points, 'cpuPercent', 300, 100);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatch(/^M /u);
    expect(segments[0]).toContain(' L ');
    expect(segments[1]).toMatch(/^M /u);
    expect(segments[0]?.split(' L ')).toHaveLength(2);
  });
});

describe('Monitoring freshness', () => {
  it('marks only an old received snapshot as stale', () => {
    expect(isMonitorSnapshotStale(null, 1_000)).toBe(false);
    expect(isMonitorSnapshotStale(1_000, 1_000 + MONITOR_STALE_AFTER_MS)).toBe(false);
    expect(isMonitorSnapshotStale(1_000, 1_001 + MONITOR_STALE_AFTER_MS)).toBe(true);
  });
});

describe('Monitoring sampler', () => {
  it('schedules the next request only after the current sample completes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
    let calls = 0;
    let resolveFirst!: (value: MonitorSnapshot) => void;
    const first = new Promise<MonitorSnapshot>((resolve) => {
      resolveFirst = resolve;
    });
    const core = createFakeCoreClient({
      overrides: {
        monitorSnapshot: vi.fn(() => {
          calls += 1;
          return calls === 1
            ? first
            : Promise.resolve(snapshot(Date.now(), 20));
        }),
      },
    });

    useMonitorStore.getState().startSampling(core, connection);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(MONITOR_SAMPLE_INTERVAL_MS - 1);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(1);

    resolveFirst(snapshot(Date.now(), 10));
    await vi.advanceTimersByTimeAsync(0);
    expect(useMonitorStore.getState().states[connection.serverId]?.phase).toBe('ready');

    await vi.advanceTimersByTimeAsync(MONITOR_SAMPLE_INTERVAL_MS - 1);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
  });

  it('drops late responses after a connection change and keeps buffers per server', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
    const oldConnection = { ...connection };
    const newConnection = {
      ...connection,
      connectionId: '019c62b2-2970-7000-8000-000000000103',
    };
    const otherServer = {
      serverId: '019c62b2-2970-7000-8000-000000000104',
      connectionId: '019c62b2-2970-7000-8000-000000000105',
    };
    let resolveOld!: (value: MonitorSnapshot) => void;
    const oldRequest = new Promise<MonitorSnapshot>((resolve) => {
      resolveOld = resolve;
    });
    const calls: string[] = [];
    const core = createFakeCoreClient({
      overrides: {
        monitorSnapshot: vi.fn((activeConnection) => {
          calls.push(activeConnection.connectionId);
          if (activeConnection.connectionId === oldConnection.connectionId) {
            return oldRequest;
          }
          return Promise.resolve(snapshot(
            Date.now(),
            activeConnection.serverId === otherServer.serverId ? 20 : 10,
          ));
        }),
      },
    });

    useMonitorStore.getState().startSampling(core, oldConnection);
    useMonitorStore.getState().stopSampling(
      oldConnection.serverId,
      oldConnection.connectionId,
    );
    useMonitorStore.getState().startSampling(core, newConnection);
    await vi.advanceTimersByTimeAsync(0);
    expect(useMonitorStore.getState().states[oldConnection.serverId]?.latest?.cpuPercent)
      .toBe(10);

    resolveOld(snapshot(Date.now() + 1_000, 99));
    await vi.advanceTimersByTimeAsync(0);
    expect(useMonitorStore.getState().states[oldConnection.serverId]?.latest?.cpuPercent)
      .toBe(10);
    expect(useMonitorStore.getState().states[oldConnection.serverId]?.samples)
      .toHaveLength(1);

    useMonitorStore.getState().startSampling(core, otherServer);
    await vi.advanceTimersByTimeAsync(0);
    expect(useMonitorStore.getState().states[oldConnection.serverId]?.samples)
      .toHaveLength(1);
    expect(useMonitorStore.getState().states[otherServer.serverId]?.samples)
      .toHaveLength(1);

    useMonitorStore.getState().stopSampling(
      oldConnection.serverId,
      newConnection.connectionId,
    );
    useMonitorStore.getState().stopSampling(
      otherServer.serverId,
      otherServer.connectionId,
    );
    expect(useMonitorStore.getState().states[otherServer.serverId]?.latest).toBeNull();
    expect(useMonitorStore.getState().states[otherServer.serverId]?.samples)
      .toHaveLength(0);
    const callCount = calls.length;
    await vi.advanceTimersByTimeAsync(MONITOR_SAMPLE_INTERVAL_MS * 2);
    expect(calls).toHaveLength(callCount);
  });

  it('clears samples when the same server reconnects with a new connectionId', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
    const nextConnection = {
      ...connection,
      connectionId: '019c62b2-2970-7000-8000-000000000106',
    };
    let resolveOld!: (value: MonitorSnapshot) => void;
    let calls = 0;
    const core = createFakeCoreClient({
      overrides: {
        monitorSnapshot: vi.fn((activeConnection) => {
          calls += 1;
          if (activeConnection.connectionId === connection.connectionId) {
            return calls === 1
              ? Promise.resolve(snapshot(Date.now(), 11))
              : new Promise<MonitorSnapshot>((resolve) => {
                  resolveOld = resolve;
                });
          }
          return Promise.resolve(snapshot(Date.now(), 22));
        }),
      },
    });

    useMonitorStore.getState().startSampling(core, connection);
    await vi.advanceTimersByTimeAsync(0);
    expect(useMonitorStore.getState().states[connection.serverId]?.samples)
      .toHaveLength(1);

    await vi.advanceTimersByTimeAsync(MONITOR_SAMPLE_INTERVAL_MS);
    expect(calls).toBe(2);

    useMonitorStore.getState().startSampling(core, nextConnection);
    expect(useMonitorStore.getState().states[connection.serverId]?.samples)
      .toHaveLength(0);

    await vi.advanceTimersByTimeAsync(0);
    expect(useMonitorStore.getState().states[connection.serverId]).toMatchObject({
      connectionId: nextConnection.connectionId,
      phase: 'ready',
    });
    expect(useMonitorStore.getState().states[connection.serverId]?.samples)
      .toHaveLength(1);

    resolveOld(snapshot(Date.now() + 5_000, 99));
    await vi.advanceTimersByTimeAsync(0);
    const samples = useMonitorStore.getState().states[connection.serverId]?.samples;
    expect(samples).toHaveLength(1);
    expect(samples?.[0]?.cpuPercent).toBe(22);
  });

  it('shows a Chinese failure, retries immediately, and does not duplicate timers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
    let calls = 0;
    const core = createFakeCoreClient({
      overrides: {
        monitorSnapshot: vi.fn(() => {
          calls += 1;
          if (calls === 1) {
            return Promise.reject({
              code: 'REMOTE_PERMISSION',
              message: 'permission denied',
              retryable: false,
            });
          }
          return Promise.resolve(snapshot(Date.now(), 25));
        }),
      },
    });

    useMonitorStore.getState().startSampling(core, connection);
    await vi.advanceTimersByTimeAsync(0);
    expect(useMonitorStore.getState().states[connection.serverId]).toMatchObject({
      phase: 'error',
      latest: null,
      error: '服务器拒绝读取系统指标',
    });

    useMonitorStore.getState().retrySampling(connection.serverId);
    await vi.advanceTimersByTimeAsync(0);
    expect(useMonitorStore.getState().states[connection.serverId]).toMatchObject({
      phase: 'ready',
      error: null,
    });
    expect(calls).toBe(2);

    await vi.advanceTimersByTimeAsync(MONITOR_SAMPLE_INTERVAL_MS);
    expect(calls).toBe(3);
  });

  it('never echoes a raw monitor failure message', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
    const core = createFakeCoreClient({
      overrides: {
        monitorSnapshot: vi.fn(() => Promise.reject({
          code: 'INTERNAL',
          message: 'sqlx error: database is locked',
          retryable: false,
        })),
      },
    });

    useMonitorStore.getState().startSampling(core, connection);
    await vi.advanceTimersByTimeAsync(0);

    const error = useMonitorStore.getState().states[connection.serverId]?.error;
    expect(error).toBe('监控采样失败，请重试');
    expect(error).not.toContain('sqlx');
  });

  it('stops polling on a lost transport and clears the live value without losing history', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
    let calls = 0;
    const core = createFakeCoreClient({
      overrides: {
        monitorSnapshot: vi.fn(() => {
          calls += 1;
          if (calls === 1) {
            return Promise.resolve(snapshot(Date.now(), 15));
          }
          return Promise.reject({
            code: 'SSH_CONNECTION',
            message: 'transport closed',
            retryable: true,
          });
        }),
      },
    });

    useMonitorStore.getState().startSampling(core, connection);
    await vi.advanceTimersByTimeAsync(0);
    expect(useMonitorStore.getState().states[connection.serverId]?.samples)
      .toHaveLength(1);

    await vi.advanceTimersByTimeAsync(MONITOR_SAMPLE_INTERVAL_MS);
    expect(useMonitorStore.getState().states[connection.serverId]).toMatchObject({
      phase: 'offline',
      latest: null,
      error: 'SSH 连接已断开，监控采样已暂停',
    });
    expect(useMonitorStore.getState().states[connection.serverId]?.samples)
      .toHaveLength(1);

    const stoppedAt = calls;
    await vi.advanceTimersByTimeAsync(MONITOR_SAMPLE_INTERVAL_MS * 3);
    expect(calls).toBe(stoppedAt);
  });

  it('clears partial failures when the connection goes offline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
    const partial: MonitorSnapshot = {
      timestamp: new Date(Date.now()).toISOString(),
      cpuPercent: 12,
      topProcesses: [],
      unavailable: ['memory'],
    };
    const core = createFakeCoreClient({
      overrides: {
        monitorSnapshot: vi.fn(() => Promise.resolve(partial)),
      },
    });

    useMonitorStore.getState().startSampling(core, connection);
    await vi.advanceTimersByTimeAsync(0);
    expect(useMonitorStore.getState().states[connection.serverId]?.unavailable)
      .toEqual(['memory']);

    useMonitorStore.getState().stopSampling(
      connection.serverId,
      connection.connectionId,
      'offline',
    );
    expect(useMonitorStore.getState().states[connection.serverId]).toMatchObject({
      phase: 'offline',
      latest: null,
      unavailable: [],
    });
  });
});
