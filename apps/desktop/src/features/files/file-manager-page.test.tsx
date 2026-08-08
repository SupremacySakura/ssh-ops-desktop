// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionHandle, ServerSummary } from '@opspilot/contracts';
import type { CoreClient } from '../../api/core';
import { FileManagerPage } from './file-manager-page';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('FileManagerPage', () => {
  it('browses, downloads, diffs, and saves through the scoped Core gateway', async () => {
    const server = {
      id: '00000000-0000-4000-8000-000000000001', name: 'web-01', host: 'example.com', port: 22,
      username: 'deploy', environment: 'production', authType: 'ssh_agent', tagIds: [],
    } as ServerSummary;
    const connection = {
      serverId: server.id, connectionId: '00000000-0000-4000-8000-000000000002',
    } as ConnectionHandle;
    const prepareOperation = vi.fn(async (call: { toolCallId: string; runId: string; serverId: string }) => ({
      kind: 'awaiting_approval',
      approvalId: '00000000-0000-4000-8000-000000000003',
      toolCallId: call.toolCallId,
      runId: call.runId,
      serverId: call.serverId,
      toolName: 'file.write',
      argsDigest: 'd'.repeat(64),
      risk: {
        level: 'L2', approvalRequired: true, snapshotRequired: false,
        confirmationText: 'Review the impact and confirm execution', reason: 'deterministic tool policy',
      },
      targetLabel: '/etc/app.conf',
      impactSummary: 'conflict-check and replace remote file /etc/app.conf',
      expiresAt: '2026-08-08T12:00:00Z',
    }));
    const approveOperation = vi.fn(async (proof) => ({
      taskId: '00000000-0000-4000-8000-000000000004',
      toolCallId: proof.toolCallId,
      argsDigest: proof.argsDigest,
    }));
    const core = {
      listFiles: async () => [{ name: 'app.conf', path: '/etc/app.conf', kind: 'file', size: 10 }],
      readFile: async () => ({
        path: '/etc/app.conf', bytes: [...new TextEncoder().encode('port=8080\n')],
        sha256: 'c'.repeat(64), truncated: false,
      }),
      downloadFile: async () => ({
        path: '/etc/app.conf', bytes: [...new TextEncoder().encode('port=8080\n')],
        sha256: 'c'.repeat(64),
      }),
      prepareOperation,
      approveOperation,
    } as unknown as CoreClient;
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:fixture'),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    render(<FileManagerPage connections={[{ server, connection }]} core={core} />);
    fireEvent.change(screen.getByLabelText('远程目录'), { target: { value: '/etc' } });
    fireEvent.click(screen.getByRole('button', { name: '浏览目录' }));
    fireEvent.click(await screen.findByRole('button', { name: '打开 app.conf' }));

    expect(await screen.findByDisplayValue('port=8080')).toBeVisible();
    expect(screen.getByText('c'.repeat(64))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '下载' }));
    expect(await screen.findByText(/下载已准备/u)).toBeVisible();

    fireEvent.change(screen.getByLabelText('文件编辑内容'), { target: { value: 'port=9090\n' } });
    expect(screen.getByText(/- port=8080/u)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '查看 Diff 并保存' }));
    expect(await screen.findByRole('alertdialog', { name: '操作审批' })).toHaveTextContent('/etc/app.conf');
    expect(prepareOperation).toHaveBeenCalledWith(expect.objectContaining({
      name: 'file.write',
      args: expect.objectContaining({ expectedSha256: 'c'.repeat(64), path: '/etc/app.conf' }),
    }));
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));
    expect(await screen.findByText(/文件任务已成功执行/u)).toBeVisible();
    expect(approveOperation).toHaveBeenCalledOnce();
  });
});
