// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionHandle, ServerSummary } from '@opspilot/contracts';
import type { CoreClient } from '../../api/core';
import { FileManagerPage } from './file-manager-page';

// Monaco 无法在 jsdom 中运行；用同契约的 textarea 顶替，行为断言不变。
vi.mock('../../app/ui/code-editor', () => ({
  CodeEditor: ({ 'aria-label': ariaLabel, onChange, value }: {
    'aria-label'?: string;
    onChange(value: string): void;
    value: string;
  }) => <textarea aria-label={ariaLabel} onChange={(event) => onChange(event.target.value)} value={value} />,
}));

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
    expect(screen.getByRole('heading', { name: '远程文件' })).toBeVisible();
    fireEvent.change(screen.getByLabelText('远程目录'), { target: { value: '/etc' } });
    fireEvent.click(screen.getByRole('button', { name: '浏览目录' }));
    expect(await screen.findByRole('region', { name: '远端文件列表' })).toBeVisible();
    fireEvent.click(await screen.findByRole('button', { name: '打开 app.conf' }));

    const dialog = await screen.findByRole('alertdialog', { name: '/etc/app.conf' });
    expect(dialog).toBeVisible();
    expect(await within(dialog).findByDisplayValue('port=8080')).toBeVisible();
    expect(within(dialog).getByText('c'.repeat(64))).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: '下载' }));
    expect(await screen.findByText(/下载已准备/u)).toBeVisible();

    fireEvent.change(within(dialog).getByLabelText('文件编辑内容'), { target: { value: 'port=9090\n' } });
    expect(within(dialog).getByText(/- port=8080/u)).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: '查看 Diff 并保存' }));
    expect(await screen.findByRole('alertdialog', { name: '操作审批' })).toHaveTextContent('/etc/app.conf');
    expect(prepareOperation).toHaveBeenCalledWith(expect.objectContaining({
      name: 'file.write',
      args: expect.objectContaining({ expectedSha256: 'c'.repeat(64), path: '/etc/app.conf' }),
    }));
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));
    expect(await screen.findByText(/文件任务已成功执行/u)).toBeVisible();
    expect(approveOperation).toHaveBeenCalledOnce();
  });

  it('creates a new empty file through the approval gateway and refreshes', async () => {
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
      targetLabel: '/etc/notes.txt',
      impactSummary: 'create remote file /etc/notes.txt',
      expiresAt: '2026-08-08T12:00:00Z',
    }));
    const approveOperation = vi.fn(async (proof) => ({
      taskId: '00000000-0000-4000-8000-000000000004',
      toolCallId: proof.toolCallId,
      argsDigest: proof.argsDigest,
    }));
    const listFiles = vi.fn(async () => [{ name: 'app.conf', path: '/etc/app.conf', kind: 'file', size: 10 }]);
    const core = { listFiles, prepareOperation, approveOperation } as unknown as CoreClient;

    render(<FileManagerPage connections={[{ server, connection }]} core={core} />);
    fireEvent.change(screen.getByLabelText('远程目录'), { target: { value: '/etc' } });
    fireEvent.click(screen.getByRole('button', { name: '浏览目录' }));
    expect(await screen.findByRole('button', { name: '打开 app.conf' })).toBeVisible();
    expect(listFiles).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '新建文件' }));
    fireEvent.change(screen.getByLabelText('新文件名'), { target: { value: 'notes.txt' } });
    fireEvent.click(screen.getByRole('button', { name: '确认' }));

    expect(await screen.findByRole('alertdialog', { name: '操作审批' })).toBeVisible();
    expect(prepareOperation).toHaveBeenCalledWith(expect.objectContaining({
      name: 'file.write',
      args: { connection, path: '/etc/notes.txt', bytes: [] },
    }));
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));
    expect(await screen.findByText(/文件任务已成功执行/u)).toBeVisible();
    expect(approveOperation).toHaveBeenCalledOnce();
    expect(listFiles).toHaveBeenCalledTimes(2);
  });

  it('renames a remote entry through the approval gateway', async () => {
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
      toolName: 'file.rename',
      argsDigest: 'd'.repeat(64),
      risk: {
        level: 'L2', approvalRequired: true, snapshotRequired: false,
        confirmationText: 'Review the impact and confirm execution', reason: 'deterministic tool policy',
      },
      targetLabel: '/etc/app.conf',
      impactSummary: 'rename /etc/app.conf to /etc/app.conf.bak',
      expiresAt: '2026-08-08T12:00:00Z',
    }));
    const core = {
      listFiles: async () => [{ name: 'app.conf', path: '/etc/app.conf', kind: 'file', size: 10 }],
      prepareOperation,
      approveOperation: vi.fn(),
    } as unknown as CoreClient;

    render(<FileManagerPage connections={[{ server, connection }]} core={core} />);
    fireEvent.change(screen.getByLabelText('远程目录'), { target: { value: '/etc' } });
    fireEvent.click(screen.getByRole('button', { name: '浏览目录' }));
    fireEvent.contextMenu(await screen.findByRole('button', { name: '打开 app.conf' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }));

    const input = screen.getByLabelText('新名称 app.conf');
    expect(input).toHaveValue('app.conf');
    fireEvent.change(input, { target: { value: 'app.conf.bak' } });
    fireEvent.click(screen.getByRole('button', { name: '确认' }));

    expect(await screen.findByRole('alertdialog', { name: '操作审批' })).toBeVisible();
    expect(prepareOperation).toHaveBeenCalledWith(expect.objectContaining({
      name: 'file.rename',
      args: { connection, path: '/etc/app.conf', target: '/etc/app.conf.bak' },
    }));
  });

  it('uploads a local folder as a file tree through the approval gateway', async () => {
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
      toolName: 'file.upload_tree',
      argsDigest: 'd'.repeat(64),
      risk: {
        level: 'L2', approvalRequired: true, snapshotRequired: false,
        confirmationText: 'Review the impact and confirm execution', reason: 'deterministic tool policy',
      },
      targetLabel: '/etc',
      impactSummary: 'upload folder tree under /etc',
      expiresAt: '2026-08-08T12:00:00Z',
    }));
    const core = {
      listFiles: async () => [{ name: 'app.conf', path: '/etc/app.conf', kind: 'file', size: 10 }],
      prepareOperation,
      approveOperation: vi.fn(),
    } as unknown as CoreClient;

    render(<FileManagerPage connections={[{ server, connection }]} core={core} />);
    fireEvent.change(screen.getByLabelText('远程目录'), { target: { value: '/etc' } });
    fireEvent.click(screen.getByRole('button', { name: '浏览目录' }));
    expect(await screen.findByRole('button', { name: '打开 app.conf' })).toBeVisible();

    const first = new File(['hello'], 'a.txt');
    const second = new File(['world'], 'b.txt');
    Object.defineProperty(first, 'webkitRelativePath', { value: 'bundle/sub/a.txt' });
    Object.defineProperty(second, 'webkitRelativePath', { value: 'bundle/b.txt' });
    const input = screen.getByLabelText('上传本地文件夹');
    Object.defineProperty(input, 'files', { value: [first, second] });
    fireEvent.change(input);

    const staging = await screen.findByRole('region', { name: '待上传文件夹' });
    expect(within(staging).getByText('bundle/sub/a.txt')).toBeVisible();
    expect(within(staging).getByText('bundle/b.txt')).toBeVisible();
    expect(within(staging).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(within(staging).getByRole('button', { name: '上传文件夹到当前目录' }));

    expect(await screen.findByRole('alertdialog', { name: '操作审批' })).toBeVisible();
    expect(prepareOperation).toHaveBeenCalledWith(expect.objectContaining({
      name: 'file.upload_tree',
      args: {
        connection,
        rootPath: '/etc',
        files: [
          { path: 'bundle/sub/a.txt', bytes: [...new TextEncoder().encode('hello')] },
          { path: 'bundle/b.txt', bytes: [...new TextEncoder().encode('world')] },
        ],
      },
    }));
  });

  it('removes a single staged file from the upload staging list', async () => {
    const server = {
      id: '00000000-0000-4000-8000-000000000001', name: 'web-01', host: 'example.com', port: 22,
      username: 'deploy', environment: 'production', authType: 'ssh_agent', tagIds: [],
    } as ServerSummary;
    const connection = {
      serverId: server.id, connectionId: '00000000-0000-4000-8000-000000000002',
    } as ConnectionHandle;
    const core = {
      listFiles: async () => [{ name: 'app.conf', path: '/etc/app.conf', kind: 'file', size: 10 }],
      prepareOperation: vi.fn(),
      approveOperation: vi.fn(),
    } as unknown as CoreClient;

    render(<FileManagerPage connections={[{ server, connection }]} core={core} />);

    const first = new File(['hello'], 'a.txt');
    const second = new File(['world'], 'b.txt');
    Object.defineProperty(first, 'webkitRelativePath', { value: 'bundle/sub/a.txt' });
    Object.defineProperty(second, 'webkitRelativePath', { value: 'bundle/b.txt' });
    const input = screen.getByLabelText('上传本地文件夹');
    Object.defineProperty(input, 'files', { value: [first, second] });
    fireEvent.change(input);

    const staging = await screen.findByRole('region', { name: '待上传文件夹' });
    expect(within(staging).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(within(staging).getByRole('button', { name: '移除 bundle/sub/a.txt' }));

    expect(within(staging).queryByText('bundle/sub/a.txt')).not.toBeInTheDocument();
    expect(within(staging).getByText('bundle/b.txt')).toBeVisible();
    expect(within(staging).getAllByRole('listitem')).toHaveLength(1);
  });
});
