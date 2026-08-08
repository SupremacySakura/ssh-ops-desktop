// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionHandle, ServerSummary } from '@opspilot/contracts';
import type { CoreClient } from '../../api/core';
import { ProjectsPage } from './project-page';

afterEach(cleanup);

describe('ProjectsPage', () => {
  it('detects, creates, and prepares deployment through the approval gateway', async () => {
    const server = { id: '00000000-0000-4000-8000-000000000001', name: 'web-01', host: 'example.com', port: 22, username: 'deploy', environment: 'production', authType: 'ssh_agent', tagIds: [] } as ServerSummary;
    const connection = { serverId: server.id, connectionId: '00000000-0000-4000-8000-000000000002' } as ConnectionHandle;
    const project = { id: '00000000-0000-4000-8000-000000000003', serverId: server.id, name: 'API', rootPath: '/srv/api', runtime: 'node_js', deployStrategy: 'release_symlink' } as const;
    const core = {
      projects: async () => [],
      detectProject: async () => ({ primary: 'node_js', evidence: ['package.json'], confidence: 0.98 }),
      createProject: async () => project,
      prepareOperation: async (call: { toolCallId: string; runId: string; serverId: string }) => ({
        kind: 'awaiting_approval', approvalId: '00000000-0000-4000-8000-000000000004', toolCallId: call.toolCallId,
        runId: call.runId, serverId: call.serverId, toolName: 'deploy.run', argsDigest: 'f'.repeat(64),
        risk: { level: 'L2', approvalRequired: true, snapshotRequired: false, confirmationText: '确认发布', reason: '将切换线上 release' },
        targetLabel: 'deploy.run', impactSummary: 'build, switch, restart, health-check', expiresAt: '2026-08-08T12:00:00Z',
      }),
      approveOperation: vi.fn(async (proof) => ({ taskId: '00000000-0000-4000-8000-000000000005', toolCallId: proof.toolCallId, argsDigest: proof.argsDigest })),
      rejectOperation: async () => undefined,
    } as unknown as CoreClient;
    render(<ProjectsPage connections={[{ server, connection }]} core={core} />);

    fireEvent.change(screen.getByLabelText('项目根目录'), { target: { value: '/srv/api' } });
    fireEvent.click(screen.getByRole('button', { name: '检测项目' }));
    expect(await screen.findByText('node_js · 98%')).toBeVisible();
    fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'API' } });
    fireEvent.change(screen.getByLabelText('Git 仓库'), { target: { value: 'https://example.com/team/api.git' } });
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
    expect(within(await screen.findByRole('table', { name: '项目列表' })).getByText('/srv/api')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '查看 API 详情' }));
    expect(screen.getByRole('complementary', { name: 'API 详情' })).toHaveTextContent('release_symlink');
    fireEvent.change(screen.getByLabelText('发布版本 API'), { target: { value: 'v1.2.3' } });
    fireEvent.click(screen.getByRole('button', { name: '发布 API' }));
    expect(await screen.findByRole('alertdialog', { name: '操作审批' })).toHaveTextContent('将切换线上 release');
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));
    expect(await screen.findByText('发布任务已提交')).toBeVisible();
  });
});
