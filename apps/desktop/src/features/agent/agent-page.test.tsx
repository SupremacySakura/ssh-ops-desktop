// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionHandle, ModelProfileSummary, ServerSummary } from '@opspilot/contracts';
import type { CoreClient } from '../../api/core';
import { AgentPage } from './agent-page';

afterEach(cleanup);

const server = {
  id: '00000000-0000-4000-8000-000000000010', name: 'web-01', host: 'example.com', port: 22,
  username: 'deploy', environment: 'production', authType: 'ssh_agent', tagIds: [],
} as ServerSummary;
const profile = {
  id: '00000000-0000-4000-8000-000000000020', name: 'Default', provider: 'openai-compatible',
  baseUrl: 'https://models.example.com/v1', model: 'ops', timeoutMs: 30_000,
  hasApiKey: true, isDefault: true,
} as ModelProfileSummary;
const connection = {
  serverId: server.id,
  connectionId: '00000000-0000-4000-8000-000000000011',
} as ConnectionHandle;

describe('AgentPage', () => {
  it('runs a scoped conversation and renders the persisted summary', async () => {
    const core = {
      agentCatalog: async () => [{ name: 'server.overview', schemaVersion: 1, description: 'Read overview', inputSchema: {} }],
      agentThreads: async () => [],
      createAgentThread: async () => ({
        id: '00000000-0000-4000-8000-000000000030', title: 'New conversation', contextSummary: '', summaryVersion: 1,
        updatedAt: '2026-08-08T00:00:00Z',
      }),
      startAgentRun: vi.fn(async () => ({
        id: '00000000-0000-4000-8000-000000000040',
        threadId: '00000000-0000-4000-8000-000000000030', serverId: server.id,
        modelProfileId: profile.id, status: 'succeeded', sequence: 4,
        inputSummary: 'Explain status', outputSummary: 'The selected server is configured for production.',
        updatedAt: '2026-08-08T00:00:00Z',
      })),
    } as unknown as CoreClient;

    render(<AgentPage availability={{ agentAvailable: true }} connections={[{ server, connection }]} core={core} profiles={[profile]} servers={[server]} />);
    fireEvent.change(await screen.findByLabelText('Agent 输入'), { target: { value: 'Explain status' } });
    fireEvent.click(screen.getByRole('button', { name: '生成计划并运行' }));

    expect(await screen.findByText('The selected server is configured for production.')).toBeVisible();
    expect(screen.getByText('server.overview')).toBeVisible();
    expect(screen.getByText('已完成')).toBeVisible();
    expect(core.startAgentRun).toHaveBeenCalledWith(expect.objectContaining({ connection }));
  });

  it('renders Core approval details and submits the immutable approval proof', async () => {
    const approveOperation = vi.fn(async () => ({ taskId: 'task' }));
    const core = {
      agentCatalog: async () => [],
      agentThreads: async () => [],
      subscribeAgentApproval: async (handler: (request: unknown) => void) => {
        queueMicrotask(() => handler({
          approvalId: '00000000-0000-4000-8000-000000000051',
          toolCallId: '00000000-0000-4000-8000-000000000052',
          runId: '00000000-0000-4000-8000-000000000053',
          serverId: server.id,
          toolName: 'systemd.service.restart',
          argsDigest: 'b'.repeat(64),
          risk: { level: 'L2', approvalRequired: true, snapshotRequired: false, confirmationText: '确认重启', reason: '服务会短暂中断' },
          targetLabel: 'nginx.service', impactSummary: '重启服务', expiresAt: '2026-08-08T12:00:00Z',
        }));
        return () => undefined;
      },
      approveOperation,
      rejectOperation: vi.fn(async () => undefined),
    } as unknown as CoreClient;

    render(<AgentPage availability={{ agentAvailable: true }} connections={[]} core={core} profiles={[profile]} servers={[server]} />);
    expect(await screen.findByRole('alertdialog', { name: '操作审批' })).toHaveTextContent('服务会短暂中断');
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));

    expect(await screen.findByText('任务已提交，执行状态由任务中心持续跟踪')).toBeVisible();
    expect(approveOperation).toHaveBeenCalledWith(expect.objectContaining({ argsDigest: 'b'.repeat(64) }));
  });

  it('keeps the manual terminal available when the Sidecar is degraded', () => {
    render(<AgentPage availability={{ agentAvailable: false, reason: 'crash_loop' }} connections={[]} core={{} as CoreClient} profiles={[]} servers={[]} />);
    expect(screen.getByRole('alert')).toHaveTextContent('crash_loop');
    expect(screen.getByRole('link', { name: '打开终端' })).toHaveAttribute('href', '#terminal');
  });
});
