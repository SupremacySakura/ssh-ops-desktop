// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import type { MonitorSnapshot } from '@opspilot/contracts';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MONITOR_STALE_AFTER_MS,
  useMonitorStore,
} from '../../store/monitor-store';
import { useTerminalStore } from '../../store/terminal-store';
import { MonitorPanel, MonitorTopbarGauges } from './monitor-panel';

const serverId = '019c62b2-2970-7000-8000-000000000201';
const connectionId = '019c62b2-2970-7000-8000-000000000202';

const snapshot: MonitorSnapshot = {
  timestamp: '2026-11-17T12:00:00.000Z',
  cpuPercent: 34,
  memory: {
    totalBytes: 100,
    availableBytes: 38,
    usedBytes: 62,
  },
  disk: {
    filesystem: '/dev/vda1',
    totalBytes: 100,
    usedBytes: 48,
    availableBytes: 52,
    mountPoint: '/',
  },
  topProcesses: [],
  unavailable: [],
};

beforeEach(() => {
  useMonitorStore.getState().reset();
  useTerminalStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useMonitorStore.getState().reset();
  useTerminalStore.getState().reset();
  vi.useRealTimers();
});

describe('Monitor topbar gauges', () => {
  it('shows live values, then replaces them once the snapshot is stale', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
    useMonitorStore.setState({
      states: {
        [serverId]: {
          connectionId,
          phase: 'ready',
          latest: snapshot,
          samples: [],
          error: null,
          unavailable: [],
          inFlight: false,
          lastUpdatedAt: Date.now(),
        },
      },
    });

    render(<MonitorTopbarGauges connectionId={connectionId} serverId={serverId} />);

    expect(screen.getByLabelText('CPU 使用率')).toHaveTextContent('34.0%');
    expect(screen.getByLabelText('内存使用率')).toHaveTextContent('62.0%');
    expect(screen.getByLabelText('磁盘使用率')).toHaveTextContent('48.0%');

    act(() => {
      vi.advanceTimersByTime(MONITOR_STALE_AFTER_MS + 1_000);
    });

    expect(screen.getByLabelText('CPU 使用率')).toHaveTextContent('过期');
    expect(screen.getByLabelText('CPU 使用率')).not.toHaveTextContent('34.0%');
    expect(screen.getByLabelText('内存使用率')).not.toHaveTextContent('62.0%');
    expect(screen.getByLabelText('磁盘使用率')).not.toHaveTextContent('48.0%');
  });

  it('shows a warming-up state instead of zero on the first CPU sample', () => {
    useMonitorStore.setState({
      states: {
        [serverId]: {
          connectionId,
          phase: 'ready',
          latest: {
            ...snapshot,
            cpuPercent: undefined,
            unavailable: ['cpu_warming_up'],
          },
          samples: [],
          error: null,
          unavailable: ['cpu_warming_up'],
          inFlight: false,
          lastUpdatedAt: Date.now(),
        },
      },
    });

    render(
      <MonitorPanel
        connectionId={connectionId}
        connectionStatus="ready"
        serverId={serverId}
      />,
    );

    const cpu = screen.getByRole('region', { name: 'CPU 概览' });
    expect(cpu).toHaveTextContent('正在采样');
    expect(cpu).not.toHaveTextContent('0.0%');
  });

  it('forces a dead transport down before reconnecting from the offline state', async () => {
    useMonitorStore.setState({
      states: {
        [serverId]: {
          connectionId,
          phase: 'offline',
          latest: null,
          samples: [],
          error: 'SSH 连接已断开，监控采样已暂停',
          unavailable: [],
          inFlight: false,
          lastUpdatedAt: null,
        },
      },
    });
    const originalDisconnect = useTerminalStore.getState().disconnectServer;
    const originalRetry = useTerminalStore.getState().retryServer;
    const disconnectServer = vi.fn(async () => undefined);
    const retryServer = vi.fn(async () => undefined);
    useTerminalStore.setState({ disconnectServer, retryServer });

    try {
      render(
        <MonitorPanel
          connectionId={connectionId}
          connectionStatus="ready"
          serverId={serverId}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: '重新连接' }));

      await vi.waitFor(() => {
        expect(disconnectServer).toHaveBeenCalledWith(serverId);
        expect(retryServer).toHaveBeenCalledWith(serverId);
      });
      expect(disconnectServer.mock.invocationCallOrder[0])
        .toBeLessThan(retryServer.mock.invocationCallOrder[0] ?? 0);
    } finally {
      useTerminalStore.setState({
        disconnectServer: originalDisconnect,
        retryServer: originalRetry,
      });
    }
  });
});
