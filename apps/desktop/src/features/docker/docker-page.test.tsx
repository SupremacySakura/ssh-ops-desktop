// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionHandle, ServerSummary } from '@opspilot/contracts';
import type { CoreClient } from '../../api/core';
import { DockerPage } from './docker-page';

afterEach(cleanup);

const server = { id: '00000000-0000-4000-8000-000000000001', name: 'web-01', host: 'example.com', port: 22, username: 'deploy', environment: 'production', authType: 'ssh_agent', tagIds: [] } as ServerSummary;
const connection = { serverId: server.id, connectionId: '00000000-0000-4000-8000-000000000002' } as ConnectionHandle;

describe('DockerPage', () => {
  it('loads real Core data and routes restart through the approval gateway', async () => {
    const core = {
      dockerVersion: async () => ({ version: '27.0', apiVersion: '1.46', os: 'linux', arch: 'amd64', transport: 'cli' }),
      dockerContainers: async () => [{ id: 'abc', names: 'web', image: 'nginx:alpine', state: 'running', status: 'Up', ports: '80/tcp' }],
      dockerLogs: async () => 'ready on :80',
      dockerStats: async () => ({ containerId: 'abc', name: 'web', cpuPercent: '1.2%', memoryUsage: '10MiB / 1GiB', memoryPercent: '1%', networkIo: '1kB / 2kB', blockIo: '0B / 0B' }),
      openDockerExec: vi.fn(async () => ({ id: '00000000-0000-4000-8000-000000000005', connection })),
      prepareOperation: async (call: { toolCallId: string; runId: string; serverId: string }) => ({
        kind: 'awaiting_approval', approvalId: '00000000-0000-4000-8000-000000000003',
        toolCallId: call.toolCallId, runId: call.runId, serverId: call.serverId,
        toolName: 'docker.container.restart', argsDigest: 'd'.repeat(64),
        risk: { level: 'L2', approvalRequired: true, snapshotRequired: false, confirmationText: '确认重启', reason: '容器会短暂中断' },
        targetLabel: 'web', impactSummary: 'restart Docker container web', expiresAt: '2026-08-08T12:00:00Z',
      }),
      approveOperation: vi.fn(async (proof) => ({ taskId: '00000000-0000-4000-8000-000000000004', toolCallId: proof.toolCallId, argsDigest: proof.argsDigest })),
      rejectOperation: async () => undefined,
    } as unknown as CoreClient;
    const onExec = vi.fn();
    render(<DockerPage connections={[{ server, connection }]} core={core} onExec={onExec} />);

    fireEvent.click(screen.getByRole('button', { name: '加载 Docker' }));
    expect(await screen.findByText('nginx:alpine')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '查看 web 详情' }));
    expect(screen.getByRole('complementary', { name: 'web 详情' })).toHaveTextContent('nginx:alpine');
    fireEvent.click(screen.getByRole('button', { name: '查看 web 日志' }));
    expect(await screen.findByText('ready on :80')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '查看 web 指标' }));
    expect(await screen.findByText('1.2%')).toBeVisible();
    expect(screen.getByRole('button', { name: '停止 web' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '进入 web Exec' }));
    expect(await screen.findByText(/隔离 Exec/u)).toBeVisible();
    expect(onExec).toHaveBeenCalledWith(expect.objectContaining({ connection }), server);
    fireEvent.click(screen.getByRole('button', { name: '重启 web' }));
    expect(await screen.findByRole('alertdialog', { name: '操作审批' })).toHaveTextContent('容器会短暂中断');
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));
    expect(await screen.findByText('Docker 任务已提交')).toBeVisible();
  });
});
