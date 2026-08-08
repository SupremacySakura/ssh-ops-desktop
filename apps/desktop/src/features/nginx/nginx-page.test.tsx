// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionHandle, ServerSummary } from '@opspilot/contracts';
import type { CoreClient } from '../../api/core';
import { NginxPage } from './nginx-page';

afterEach(cleanup);

describe('NginxPage', () => {
  it('shows the candidate diff and requires exact L3 target confirmation', async () => {
    const server = { id: '00000000-0000-4000-8000-000000000001', name: 'web-01', host: 'example.com', port: 22, username: 'deploy', environment: 'production', authType: 'ssh_agent', tagIds: [] } as ServerSummary;
    const connection = { serverId: server.id, connectionId: '00000000-0000-4000-8000-000000000002' } as ConnectionHandle;
    const core = {
      nginxDiscover: async () => '/etc/nginx/nginx.conf',
      nginxRead: async () => [...new TextEncoder().encode('worker_processes 1;')],
      prepareOperation: async (call: { toolCallId: string; runId: string; serverId: string }) => ({
        kind: 'awaiting_approval', approvalId: '00000000-0000-4000-8000-000000000003', toolCallId: call.toolCallId,
        runId: call.runId, serverId: call.serverId, toolName: 'nginx.apply', argsDigest: 'e'.repeat(64),
        risk: { level: 'L3', approvalRequired: true, snapshotRequired: true, confirmationText: '输入配置路径确认', reason: '将替换并重载生产 Nginx' },
        targetLabel: '/etc/nginx/nginx.conf', confirmationTarget: '/etc/nginx/nginx.conf',
        impactSummary: 'snapshot, validate, replace, reload, health-check', expiresAt: '2026-08-08T12:00:00Z',
      }),
      approveOperation: vi.fn(async (proof) => ({ taskId: '00000000-0000-4000-8000-000000000004', toolCallId: proof.toolCallId, argsDigest: proof.argsDigest })),
      rejectOperation: async () => undefined,
    } as unknown as CoreClient;
    render(<NginxPage connections={[{ server, connection }]} core={core} />);

    fireEvent.click(screen.getByRole('button', { name: '发现并读取配置' }));
    const editor = await screen.findByLabelText('Nginx 候选配置');
    fireEvent.change(editor, { target: { value: 'worker_processes auto;' } });
    expect(screen.getByText('- worker_processes 1;')).toBeVisible();
    expect(screen.getByText('+ worker_processes auto;')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '准备安全变更' }));
    expect(await screen.findByRole('button', { name: '确认执行' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('确认目标资源'), { target: { value: '/etc/nginx/nginx.conf' } });
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));
    expect(await screen.findByText('Nginx 变更任务已提交')).toBeVisible();
  });
});
