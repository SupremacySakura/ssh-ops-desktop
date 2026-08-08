// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionHandle, ServerSummary } from '@opspilot/contracts';
import type { CoreClient } from '../../api/core';
import { DashboardPage } from './dashboard-page';

afterEach(cleanup);

const server = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'web-01',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  environment: 'production',
  authType: 'ssh_agent',
  tagIds: [],
} as ServerSummary;
const connection = {
  serverId: server.id,
  connectionId: '00000000-0000-4000-8000-000000000002',
} as ConnectionHandle;

describe('DashboardPage', () => {
  it('loads real metrics, services, and listening ports without inventing values', async () => {
    const core = {
      tasks: async () => [],
      systemMetrics: async () => ({
        timestamp: '2026-08-08T00:00:00Z',
        memory: { totalBytes: 100, availableBytes: 40, usedBytes: 60 },
        load: { one: 0.5, five: 0.4, fifteen: 0.3 },
        disks: [],
        unavailable: [],
      }),
      systemProbe: async () => ({ id: 'ubuntu', versionId: '24.04', prettyName: 'Ubuntu 24.04', serviceManager: 'systemd' }),
      systemPorts: async () => [{ protocol: 'tcp', address: '0.0.0.0', port: 443, process: 'nginx' }],
      systemServices: async () => [{ unit: 'nginx.service', loadState: 'loaded', activeState: 'active', subState: 'running', description: 'Nginx' }],
    } as unknown as CoreClient;
    render(<DashboardPage connections={[{ server, connection }]} core={core} servers={[server]} />);

    fireEvent.click(screen.getByRole('button', { name: '刷新指标' }));
    expect(await screen.findByText('Ubuntu 24.04')).toBeVisible();
    expect(screen.getByText('nginx.service')).toBeVisible();
    expect(screen.getByText('TCP 0.0.0.0:443')).toBeVisible();
    expect(screen.getByText('60%')).toBeVisible();
  });

  it('routes the add-server action instead of presenting a dead button', () => {
    const onAddServer = vi.fn();
    render(<DashboardPage connections={[]} core={{ tasks: async () => [] } as unknown as CoreClient} onAddServer={onAddServer} servers={[]} />);
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加服务器' }));
    expect(onAddServer).toHaveBeenCalledOnce();
  });

  it('shows an honest empty state and routes terminal and Agent quick actions', () => {
    const onOpenAgent = vi.fn();
    const onOpenTerminal = vi.fn();

    render(
      <DashboardPage
        agent={{ agentAvailable: false, reason: 'not configured' }}
        connections={[]}
        core={{ tasks: async () => [] } as unknown as CoreClient}
        onOpenAgent={onOpenAgent}
        onOpenTerminal={onOpenTerminal}
        servers={[]}
      />,
    );

    expect(screen.getByText('暂无已连接服务器')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '打开终端' }));
    fireEvent.click(screen.getByRole('button', { name: 'AI 巡检' }));
    expect(onOpenTerminal).toHaveBeenCalledOnce();
    expect(onOpenAgent).toHaveBeenCalledOnce();
  });
});
