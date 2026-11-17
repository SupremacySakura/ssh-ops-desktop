// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import type { SshConfigImportPreview } from '@opspilot/contracts';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';
import { useHarborStore } from './store/harbor-store';
import { useMonitorStore } from './store/monitor-store';
import { useTerminalStore } from './store/terminal-store';
import { createFakeCoreClient } from './test/fake-core';

vi.mock('./features/terminal/xterm-viewport', () => ({
  XtermViewport: ({ session }: { session: { id: string } }) => (
    <div data-testid={`terminal-viewport-${session.id}`} />
  ),
}));

const readyCore = createFakeCoreClient({
  health: {
    version: 'test-version',
    databaseReady: true,
    secretStoreReady: true,
  },
});

beforeEach(() => {
  useHarborStore.getState().reset();
  useMonitorStore.getState().reset();
  useTerminalStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useMonitorStore.getState().reset();
  useTerminalStore.getState().reset();
});

describe('Harbor empty shell', () => {
  it('shows the brand, search, empty catalog, empty workspace, and ready Core', async () => {
    render(<App core={readyCore} />);

    expect(screen.getByText('HARBOR')).toBeVisible();
    expect(screen.getByRole('searchbox', { name: '搜索服务器' })).toBeVisible();
    expect(await screen.findByRole('heading', { name: '还没有服务器' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '未选择服务器' })).toBeVisible();
    expect(await screen.findByText('Core 已就绪')).toBeVisible();
    expect(screen.getByText('test-version')).toBeVisible();
  });

  it('contains no legacy OpsPilot navigation or feature entry points', async () => {
    render(<App core={readyCore} />);
    await screen.findByText('Core 已就绪');

    for (const legacyLabel of [
      'AI Agent',
      '仪表盘',
      '项目',
      'Nginx',
      '任务与日志',
      '设置',
    ]) {
      expect(screen.queryByText(legacyLabel)).not.toBeInTheDocument();
    }
  });

  it('keeps the shell visible and reports a Core failure explicitly', async () => {
    const unavailableCore = createFakeCoreClient({
      overrides: {
        health: () => Promise.reject(new Error('IPC unavailable')),
      },
    });

    render(<App core={unavailableCore} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取 Core 状态');
    expect(screen.getByRole('heading', { name: '还没有服务器' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '未选择服务器' })).toBeVisible();
  });

  it('reports a reachable but unready Core without hiding the workspace', async () => {
    const unreadyCore = createFakeCoreClient({
      health: {
        version: 'test-version',
        databaseReady: true,
        secretStoreReady: false,
      },
    });

    render(<App core={unreadyCore} />);

    expect(await screen.findByText('Core 未就绪')).toBeVisible();
    expect(screen.getByRole('heading', { name: '未选择服务器' })).toBeVisible();
  });

  it('loads grouped nameplates with favorites pinned ahead of their groups', async () => {
    const group = {
      id: '019c62b2-2970-7000-8000-000000000004',
      name: '生产',
      sortOrder: 10,
    };
    const testing = {
      id: '019c62b2-2970-7000-8000-000000000005',
      name: '测试',
      sortOrder: 20,
    };
    const core = createFakeCoreClient({
      groups: [testing, group],
      servers: [
        {
          id: '019c62b2-2970-7000-8000-000000000006',
          name: 'prod-web-01',
          host: 'prod.example.com',
          port: 22,
          user: 'deploy',
          authType: 'key',
          secretRef: 'secret-ref-fixture-1',
          groupId: group.id,
          favorite: false,
          lastConnectedAt: 1_700_000_000,
          createdAt: 1_699_000_000,
        },
        {
          id: '019c62b2-2970-7000-8000-000000000007',
          name: 'pinned-db',
          host: 'db.example.com',
          port: 2222,
          user: 'ops',
          authType: 'password',
          secretRef: 'secret-ref-fixture-2',
          groupId: group.id,
          favorite: true,
          createdAt: 1_699_500_000,
        },
        {
          id: '019c62b2-2970-7000-8000-000000000008',
          name: 'dev-box',
          host: '10.0.0.12',
          port: 22,
          user: 'shi',
          authType: 'key',
          secretRef: 'secret-ref-fixture-3',
          groupId: null,
          favorite: false,
          createdAt: 1_699_600_000,
        },
      ],
    });

    render(<App core={core} />);

    expect(await screen.findByText('prod-web-01')).toBeVisible();
    expect(screen.getByText('收藏')).toBeVisible();
    expect(screen.getByText('生产')).toBeVisible();
    expect(screen.getByText('未分组')).toBeVisible();
    expect(screen.getByText('dev-box')).toBeVisible();

    const serverButton = screen.getByRole('button', {
      name: /^打开服务器 prod-web-01/u,
    });
    fireEvent.click(serverButton);
    expect(serverButton).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('heading', { name: 'prod-web-01' })).toBeVisible();
  });

  it('validates and saves a new server through the add-server dialog', async () => {
    const group = {
      id: '019c62b2-2970-7000-8000-000000000004',
      name: '生产',
      sortOrder: 10,
    };
    const core = createFakeCoreClient({ groups: [group] });

    render(<App core={core} />);
    await screen.findByRole('heading', { name: '还没有服务器' });
    fireEvent.click(screen.getAllByRole('button', { name: '添加服务器' })[0]);

    const dialog = screen.getByRole('dialog', { name: '添加服务器' });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存服务器' }));
    expect(await within(dialog).findByText('请输入服务器名称')).toBeVisible();
    expect(within(dialog).getByText('请输入主机地址')).toBeVisible();
    expect(within(dialog).getByText('请输入用户名')).toBeVisible();
    expect(within(dialog).getByText('请输入私钥')).toBeVisible();

    fireEvent.change(within(dialog).getByLabelText('名称'), {
      target: { value: 'prod-web-01' },
    });
    fireEvent.change(within(dialog).getByLabelText('主机'), {
      target: { value: 'prod.example.com' },
    });
    fireEvent.change(within(dialog).getByLabelText('端口'), {
      target: { value: '0' },
    });
    fireEvent.change(within(dialog).getByLabelText('用户名'), {
      target: { value: 'deploy' },
    });
    fireEvent.change(within(dialog).getByLabelText('分组'), {
      target: { value: group.id },
    });
    fireEvent.change(within(dialog).getByLabelText('私钥'), {
      target: { value: 'private-key-fixture' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存服务器' }));
    expect(await within(dialog).findByText('端口必须在 1–65535 之间')).toBeVisible();

    fireEvent.change(within(dialog).getByLabelText('端口'), {
      target: { value: '2222' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存服务器' }));

    expect(await screen.findByRole('button', {
      name: /^打开服务器 prod-web-01/u,
    })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: '添加服务器' })).not.toBeInTheDocument();
    expect(core.calls).toContainEqual(expect.objectContaining({ method: 'createServer' }));
  });

  it('edits a server without requiring its credential to be re-entered', async () => {
    const core = createFakeCoreClient({
      servers: [{
        id: '019c62b2-2970-7000-8000-000000000006',
        name: 'prod-web-01',
        host: 'prod.example.com',
        port: 22,
        user: 'deploy',
        authType: 'key',
        secretRef: 'secret-ref-fixture-1',
        groupId: null,
        favorite: false,
        lastConnectedAt: null,
        createdAt: 1_699_000_000,
      }],
    });

    render(<App core={core} />);
    fireEvent.click(await screen.findByRole('button', {
      name: /^打开服务器 prod-web-01/u,
    }));
    fireEvent.click(screen.getByRole('button', { name: '编辑服务器' }));

    const dialog = screen.getByRole('dialog', { name: '编辑服务器' });
    expect(within(dialog).getByLabelText('主机')).toHaveValue('prod.example.com');
    expect(within(dialog).getByLabelText('用户名')).toHaveValue('deploy');
    expect(within(dialog).getByLabelText('私钥')).toHaveValue('');

    fireEvent.change(within(dialog).getByLabelText('名称'), {
      target: { value: 'prod-web-01-renamed' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存服务器' }));

    expect(await screen.findByRole('heading', {
      name: 'prod-web-01-renamed',
    })).toBeVisible();
    expect(core.calls).toContainEqual(expect.objectContaining({ method: 'updateServer' }));
  });

  it('disconnects the old SSH identity before reconnecting an edited endpoint', async () => {
    const core = createFakeCoreClient({
      servers: [{
        id: '019c62b2-2970-7000-8000-000000000007',
        name: 'prod-web-01',
        host: 'prod.example.com',
        port: 22,
        user: 'deploy',
        authType: 'key',
        secretRef: 'secret-ref-fixture-1',
        groupId: null,
        favorite: false,
        lastConnectedAt: null,
        createdAt: 1_699_000_000,
      }],
    });

    render(<App core={core} />);
    fireEvent.click(await screen.findByRole('button', {
      name: /^打开服务器 prod-web-01/u,
    }));
    await screen.findByRole('tab', { name: '切换到 终端 1' });
    const oldConnection = useTerminalStore.getState()
      .runtimes['019c62b2-2970-7000-8000-000000000007']?.connection;
    const oldSessionId = useTerminalStore.getState()
      .runtimes['019c62b2-2970-7000-8000-000000000007']?.sessions[0]?.id;

    fireEvent.click(screen.getByRole('button', { name: '编辑服务器' }));
    const dialog = screen.getByRole('dialog', { name: '编辑服务器' });
    fireEvent.change(within(dialog).getByLabelText('主机'), {
      target: { value: 'replacement.example.com' },
    });
    fireEvent.change(within(dialog).getByLabelText('用户名'), {
      target: { value: 'replacement' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存服务器' }));

    await waitFor(() => {
      expect(
        core.calls.filter((call) => call.method === 'connect'),
      ).toHaveLength(2);
    });
    expect(core.calls).toContainEqual({
      method: 'disconnect',
      args: [oldConnection],
    });
    const current = useTerminalStore.getState()
      .runtimes['019c62b2-2970-7000-8000-000000000007'];
    expect(current?.connection?.connectionId).not.toBe(oldConnection?.connectionId);
    expect(current?.sessions[0]?.id).not.toBe(oldSessionId);
    expect(current?.connectionIdentity).toContain('replacement.example.com');
  });

  it('keeps imported servers visibly pending while their metadata is edited', async () => {
    const core = createFakeCoreClient({
      servers: [{
        id: '019c62b2-2970-7000-8000-000000000015',
        name: 'imported-pending',
        host: 'pending.example.com',
        port: 22,
        user: 'deploy',
        authType: 'key',
        secretRef: null,
        groupId: null,
        favorite: false,
        lastConnectedAt: null,
        createdAt: 1_699_000_000,
      }],
    });

    render(<App core={core} />);
    const server = await screen.findByRole('button', {
      name: /^打开服务器 imported-pending/u,
    });
    expect(screen.getByText('凭据待配置')).toBeVisible();
    fireEvent.click(server);
    expect(screen.getByText(/认证方式待配置/u)).toBeVisible();
    expect(core.calls.filter((call) => call.method === 'connect')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '编辑服务器' }));

    const dialog = screen.getByRole('dialog', { name: '编辑服务器' });
    expect(within(dialog).getByText(
      '当前凭据待配置；留空只保存服务器元数据，补充凭据后才能连接。',
    )).toBeVisible();
    expect(within(dialog).getByPlaceholderText('留空继续待配置')).toBeVisible();

    fireEvent.change(within(dialog).getByLabelText('名称'), {
      target: { value: 'imported-pending-renamed' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存服务器' }));

    expect(await screen.findByRole('heading', {
      name: 'imported-pending-renamed',
    })).toBeVisible();
    expect(screen.getByText(/认证方式待配置/u)).toBeVisible();
    expect(core.calls).toContainEqual(expect.objectContaining({ method: 'updateServer' }));
    expect(core.calls.filter((call) => call.method === 'connect')).toHaveLength(0);
  });

  it('auto-connects as soon as a pending server receives its credential', async () => {
    const core = createFakeCoreClient({
      servers: [{
        id: '019c62b2-2970-7000-8000-000000000016',
        name: 'pending-credential',
        host: 'pending.example.com',
        port: 22,
        user: 'deploy',
        authType: 'key',
        secretRef: null,
        groupId: null,
        favorite: false,
        lastConnectedAt: null,
        createdAt: 1_699_000_000,
      }],
    });

    render(<App core={core} />);
    fireEvent.click(await screen.findByRole('button', {
      name: /^打开服务器 pending-credential/u,
    }));
    await screen.findByText(/认证方式待配置/u);
    expect(core.calls.filter((call) => call.method === 'connect')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: '编辑并补充凭据' }));
    const dialog = screen.getByRole('dialog', { name: '编辑服务器' });
    fireEvent.change(within(dialog).getByLabelText('私钥'), {
      target: { value: 'private-key-fixture' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存服务器' }));

    expect(await screen.findByRole('tab', { name: '切换到 终端 1' })).toBeVisible();
    expect(core.calls.filter((call) => call.method === 'connect')).toHaveLength(1);
    expect(
      core.calls.filter((call) => call.method === 'openTerminal'),
    ).toHaveLength(1);
  });

  it('requires confirmation before deleting the selected server', async () => {
    const core = createFakeCoreClient({
      servers: [{
        id: '019c62b2-2970-7000-8000-000000000006',
        name: 'prod-web-01',
        host: 'prod.example.com',
        port: 22,
        user: 'deploy',
        authType: 'key',
        secretRef: 'secret-ref-fixture-1',
        groupId: null,
        favorite: false,
        lastConnectedAt: null,
        createdAt: 1_699_000_000,
      }],
    });

    render(<App core={core} />);
    fireEvent.click(await screen.findByRole('button', {
      name: /^打开服务器 prod-web-01/u,
    }));
    await screen.findByRole('tab', { name: '切换到 终端 1' });
    fireEvent.click(screen.getByRole('button', { name: '删除服务器' }));

    const confirmation = screen.getByRole('alertdialog', { name: '删除服务器？' });
    expect(confirmation).toHaveTextContent('prod-web-01');
    fireEvent.click(within(confirmation).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(core.calls).not.toContainEqual(expect.objectContaining({ method: 'deleteServer' }));

    fireEvent.click(screen.getByRole('button', { name: '删除服务器' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', {
      name: '确认删除',
    }));

    expect(await screen.findByRole('heading', { name: '未选择服务器' })).toBeVisible();
    expect(core.calls).toContainEqual(expect.objectContaining({ method: 'deleteServer' }));
    const disconnectIndex = core.calls.findIndex((call) => call.method === 'disconnect');
    const deleteIndex = core.calls.findIndex((call) => call.method === 'deleteServer');
    expect(disconnectIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(disconnectIndex);
  });

  it('does not delete a server when its SSH connection cannot be closed', async () => {
    const core = createFakeCoreClient({
      servers: [{
        id: '019c62b2-2970-7000-8000-000000000006',
        name: 'prod-web-01',
        host: 'prod.example.com',
        port: 22,
        user: 'deploy',
        authType: 'key',
        secretRef: 'secret-ref-fixture-1',
        groupId: null,
        favorite: false,
        lastConnectedAt: null,
        createdAt: 1_699_000_000,
      }],
      overrides: {
        disconnect: async () => {
          throw new Error('无法关闭 SSH 连接');
        },
      },
    });

    render(<App core={core} />);
    fireEvent.click(await screen.findByRole('button', {
      name: /^打开服务器 prod-web-01/u,
    }));
    await screen.findByRole('tab', { name: '切换到 终端 1' });
    fireEvent.click(screen.getByRole('button', { name: '删除服务器' }));

    const confirmation = screen.getByRole('alertdialog', { name: '删除服务器？' });
    fireEvent.click(within(confirmation).getByRole('button', {
      name: '确认删除',
    }));

    expect(await within(confirmation).findByRole('alert')).toHaveTextContent(
      '无法关闭 SSH 连接',
    );
    expect(confirmation).toBeVisible();
    expect(core.calls).not.toContainEqual(
      expect.objectContaining({ method: 'deleteServer' }),
    );
  });

  it('creates, renames, and deletes groups from the group manager', async () => {
    const group = {
      id: '019c62b2-2970-7000-8000-000000000004',
      name: '生产',
      sortOrder: 10,
    };
    const core = createFakeCoreClient({
      groups: [group],
      servers: [{
        id: '019c62b2-2970-7000-8000-000000000006',
        name: 'prod-web-01',
        host: 'prod.example.com',
        port: 22,
        user: 'deploy',
        authType: 'key',
        secretRef: 'secret-ref-fixture-1',
        groupId: group.id,
        favorite: false,
        lastConnectedAt: null,
        createdAt: 1_699_000_000,
      }],
    });

    render(<App core={core} />);
    await screen.findByRole('button', { name: /^打开服务器 prod-web-01/u });
    fireEvent.click(screen.getByRole('button', { name: '管理分组' }));

    const manager = screen.getByRole('dialog', { name: '分组管理' });
    fireEvent.change(within(manager).getByLabelText('新分组名称'), {
      target: { value: '测试' },
    });
    fireEvent.change(within(manager).getByLabelText('新分组排序'), {
      target: { value: '20' },
    });
    fireEvent.click(within(manager).getByRole('button', { name: '创建分组' }));
    expect(await within(manager).findByLabelText('分组名称 测试')).toBeVisible();

    fireEvent.change(within(manager).getByLabelText('分组名称 生产'), {
      target: { value: '核心生产' },
    });
    fireEvent.click(within(manager).getByRole('button', { name: '保存分组 生产' }));
    expect(await within(manager).findByLabelText('分组名称 核心生产')).toBeVisible();

    fireEvent.click(within(manager).getByRole('button', { name: '删除分组 测试' }));
    const confirmation = screen.getByRole('alertdialog', { name: '删除分组？' });
    fireEvent.click(within(confirmation).getByRole('button', { name: '确认删除' }));
    await screen.findByRole('button', { name: '删除分组 核心生产' });
    expect(within(manager).queryByLabelText('分组名称 测试')).not.toBeInTheDocument();

    fireEvent.click(within(manager).getByRole('button', { name: '删除分组 核心生产' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', {
      name: '确认删除',
    }));
    await screen.findByText('还没有分组。先创建一个，再把服务器停靠进去。');

    fireEvent.click(within(manager).getByRole('button', { name: '关闭分组管理' }));
    expect(await screen.findByText('未分组')).toBeVisible();
  });

  it('opens Command-K, searches servers, and supports arrow/Enter navigation', async () => {
    const core = createFakeCoreClient({
      servers: [
        {
          id: '019c62b2-2970-7000-8000-000000000006',
          name: 'pinned-db',
          host: 'db.example.com',
          port: 22,
          user: 'ops',
          authType: 'key',
          secretRef: 'secret-ref-fixture-2',
          groupId: null,
          favorite: true,
          lastConnectedAt: null,
          createdAt: 1_699_000_000,
        },
        {
          id: '019c62b2-2970-7000-8000-000000000007',
          name: 'prod-web-01',
          host: 'prod.example.com',
          port: 22,
          user: 'deploy',
          authType: 'key',
          secretRef: 'secret-ref-fixture-1',
          groupId: null,
          favorite: false,
          lastConnectedAt: null,
          createdAt: 1_699_500_000,
        },
      ],
    });

    render(<App core={core} />);
    await screen.findByRole('button', { name: /^打开服务器 pinned-db/u });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });

    const palette = screen.getByRole('dialog', { name: '命令面板' });
    const search = within(palette).getByRole('searchbox', {
      name: '搜索服务器或命令',
    });
    expect(search).toHaveFocus();
    expect(within(palette).getByText('从 SSH Config 导入')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'example.com' } });
    expect(within(palette).getAllByRole('option')).toHaveLength(2);
    expect(within(palette).getAllByRole('option')[0]).toHaveAccessibleName(
      /pinned-db/u,
    );
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(within(palette).getAllByRole('option')[1]).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(screen.queryByRole('dialog', { name: '命令面板' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: /^打开服务器 prod-web-01/u,
    })).toHaveAttribute('aria-current', 'true');

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const reopened = screen.getByRole('dialog', { name: '命令面板' });
    fireEvent.change(within(reopened).getByRole('searchbox'), {
      target: { value: '添加' },
    });
    fireEvent.keyDown(within(reopened).getByRole('searchbox'), { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: '添加服务器' })).toBeVisible();
  });

  it('auto-connects a selected server and opens its first terminal session', async () => {
    const core = createFakeCoreClient({
      servers: [terminalServer('prod-web-01')],
    });

    render(<App core={core} />);
    fireEvent.click(await screen.findByRole('button', {
      name: /^打开服务器 prod-web-01/u,
    }));

    expect(await screen.findByRole('tab', { name: '切换到 终端 1' })).toBeVisible();
    expect(screen.getByLabelText('终端会话数量')).toHaveTextContent('1/8');
    expect(screen.getByRole('button', { name: '新增终端会话' })).toBeEnabled();
    expect(core.calls.filter((call) => call.method === 'connect')).toHaveLength(1);
    expect(
      core.calls.filter((call) => call.method === 'openTerminal'),
    ).toHaveLength(1);
  });

  it('blocks an unknown host key until explicit trust, then retries the connection', async () => {
    let attempt = 0;
    const core = createFakeCoreClient({
      servers: [terminalServer('prod-web-01')],
      connectOutcome: () => {
        attempt += 1;
        if (attempt === 1) {
          return {
            kind: 'hostKeyRequired',
            prompt: {
              verificationId: '019c62b2-2970-7000-8000-000000000020',
              algorithm: 'ssh-ed25519',
              sha256: 'SHA256:fixture',
              expiresAt: '2026-01-01T00:00:00.000Z',
            },
          };
        }
        return {
          kind: 'ready',
          connection: {
            serverId: '019c62b2-2970-7000-8000-000000000006',
            connectionId: '019c62b2-2970-7000-8000-000000000021',
          },
        };
      },
    });

    render(<App core={core} />);
    fireEvent.click(await screen.findByRole('button', {
      name: /^打开服务器 prod-web-01/u,
    }));

    const dialog = await screen.findByRole('dialog', {
      name: '首次连接，核对主机指纹',
    });
    const trust = within(dialog).getByRole('button', {
      name: '信任并以 SSH 连接',
    });
    expect(trust).toBeDisabled();
    fireEvent.click(within(dialog).getByLabelText(
      '我已通过独立渠道核对上述 SHA-256 主机指纹。',
    ));
    expect(trust).toBeEnabled();
    fireEvent.click(trust);

    expect(await screen.findByRole('tab', { name: '切换到 终端 1' })).toBeVisible();
    expect(screen.queryByRole('dialog', {
      name: '首次连接，核对主机指纹',
    })).not.toBeInTheDocument();
    expect(core.calls).toContainEqual({
      method: 'trustHostKey',
      args: [
        '019c62b2-2970-7000-8000-000000000006',
        '019c62b2-2970-7000-8000-000000000020',
      ],
    });
    expect(core.calls.filter((call) => call.method === 'connect')).toHaveLength(2);
  });

  it('shows an actionable connection failure and retries from the terminal view', async () => {
    let attempt = 0;
    const server = terminalServer('prod-web-01');
    const core = createFakeCoreClient({
      servers: [server],
      overrides: {
        connect: async () => {
          attempt += 1;
          if (attempt === 1) {
            throw {
              code: 'SSH_AUTHENTICATION',
              message: 'fixture authentication failure',
              retryable: false,
            };
          }
          return {
            kind: 'ready',
            connection: {
              serverId: server.id,
              connectionId: '019c62b2-2970-7000-8000-000000000022',
            },
          };
        },
      },
    });

    render(<App core={core} />);
    fireEvent.click(await screen.findByRole('button', {
      name: /^打开服务器 prod-web-01/u,
    }));

    expect(await screen.findByRole('alert')).toHaveTextContent('SSH 认证失败');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('tab', { name: '切换到 终端 1' })).toBeVisible();
  });

  it('limits a server to eight terminals and preserves sessions when switching servers', async () => {
    const first = terminalServer('prod-web-01', '019c62b2-2970-7000-8000-000000000006');
    const second = terminalServer('dev-box', '019c62b2-2970-7000-8000-000000000007');
    const core = createFakeCoreClient({ servers: [first, second] });

    render(<App core={core} />);
    fireEvent.click(await screen.findByRole('button', {
      name: /^打开服务器 prod-web-01/u,
    }));
    await screen.findByRole('tab', { name: '切换到 终端 1' });
    const firstSessionId = useTerminalStore.getState()
      .runtimes[first.id]?.sessions[0]?.id;
    expect(firstSessionId).toBeTruthy();
    const firstViewport = screen.getByTestId(`terminal-viewport-${firstSessionId}`);

    for (let count = 1; count < 8; count += 1) {
      fireEvent.click(screen.getByRole('button', { name: '新增终端会话' }));
      await waitFor(() => {
        expect(screen.getByLabelText('终端会话数量')).toHaveTextContent(
          `${count + 1}/8`,
        );
      });
    }
    expect(screen.getByRole('button', { name: '新增终端会话' })).toBeDisabled();
    expect(screen.getByLabelText('终端会话数量')).toHaveTextContent('8/8');

    fireEvent.click(screen.getByRole('button', { name: /^打开服务器 dev-box/u }));
    await screen.findByRole('heading', { name: 'dev-box' });
    expect(
      core.calls.filter((call) => call.method === 'connect'),
    ).toHaveLength(2);
    expect(
      useTerminalStore.getState().runtimes[first.id]?.sessions,
    ).toHaveLength(8);

    fireEvent.click(screen.getByRole('button', {
      name: /^打开服务器 prod-web-01/u,
    }));
    expect(screen.getByTestId(`terminal-viewport-${firstSessionId}`)).toBe(firstViewport);
    expect(
      core.calls.filter((call) => call.method === 'connect'),
    ).toHaveLength(2);
  });

  it('previews SSH Config rows, imports only ready selections, and marks pending credentials', async () => {
    const importPreview: SshConfigImportPreview = {
      previewId: '019c62b2-2970-7000-8000-000000000010',
      sourcePath: '~/.ssh/config',
      items: [{
        id: '019c62b2-2970-7000-8000-000000000011',
        alias: 'imported-prod',
        host: 'imported.example.com',
        port: 2222,
        username: 'deploy',
        identityFile: '~/.ssh/id_ed25519',
        status: 'ready',
        unsupportedDirectives: [],
        warnings: [],
      }, {
        id: '019c62b2-2970-7000-8000-000000000012',
        alias: 'existing',
        host: 'existing.example.com',
        port: 22,
        username: 'deploy',
        identityFile: null,
        status: 'existing',
        unsupportedDirectives: [],
        warnings: [],
      }, {
        id: '019c62b2-2970-7000-8000-000000000013',
        alias: 'imported-copy',
        host: 'imported.example.com',
        port: 2222,
        username: 'deploy',
        identityFile: null,
        status: 'duplicateInBatch',
        unsupportedDirectives: [],
        warnings: [],
      }, {
        id: '019c62b2-2970-7000-8000-000000000014',
        alias: 'proxied',
        host: 'proxied.example.com',
        port: 22,
        username: 'deploy',
        identityFile: null,
        status: 'unsupported',
        unsupportedDirectives: ['ProxyJump'],
        warnings: ['第 8 行：ProxyJump 暂不支持；该 Host 已停用，避免按错误路径直连。'],
      }],
      warnings: [],
      warningCount: 0,
      existingCount: 1,
      importableCount: 1,
    };
    const core = createFakeCoreClient({
      sshConfigImport: importPreview,
    });

    render(<App core={core} />);
    await screen.findByRole('heading', { name: '还没有服务器' });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.click(within(screen.getByRole('dialog', { name: '命令面板' })).getByRole(
      'option',
      { name: /从 SSH Config 导入/u },
    ));

    const dialog = await screen.findByRole('dialog', { name: '导入 SSH Config' });
    expect(await within(dialog).findByText('imported-prod')).toBeVisible();
    expect(within(dialog).getAllByText('~/.ssh/config')).toHaveLength(2);
    expect(within(dialog).getAllByText('imported.example.com')).toHaveLength(2);
    expect(within(dialog).getAllByText('deploy')).toHaveLength(4);
    expect(within(dialog).getAllByText('2222')).toHaveLength(2);

    const readyChoice = within(dialog).getByRole('checkbox', {
      name: '选择 imported-prod',
    });
    expect(readyChoice).toBeEnabled();
    expect(readyChoice).toBeChecked();
    expect(within(dialog).getByRole('checkbox', {
      name: '选择 existing',
    })).toBeDisabled();
    expect(within(dialog).getByRole('checkbox', {
      name: '选择 imported-copy',
    })).toBeDisabled();
    expect(within(dialog).getByRole('checkbox', {
      name: '选择 proxied',
    })).toBeDisabled();
    expect(within(dialog).getAllByText('已存在')).toHaveLength(2);
    expect(within(dialog).getByText('同批重复')).toBeVisible();
    expect(within(dialog).getByText('暂不支持')).toBeVisible();

    fireEvent.click(readyChoice);
    expect(within(dialog).getByRole('button', {
      name: '导入 0 台服务器',
    })).toBeDisabled();
    fireEvent.click(readyChoice);
    fireEvent.click(within(dialog).getByRole('button', {
      name: '导入 1 台服务器',
    }));

    expect(await within(dialog).findByText('导入完成')).toBeVisible();
    expect(within(dialog).getByText(/已导入/u)).toHaveTextContent('已导入 1 台服务器');
    fireEvent.click(within(dialog).getByRole('button', { name: '完成' }));

    const imported = await screen.findByRole('button', {
      name: /^打开服务器 imported-prod/u,
    });
    expect(screen.getAllByText('凭据待配置').length).toBeGreaterThan(0);
    fireEvent.click(imported);
    expect(screen.getByText(/尚未配置密码或私钥/u)).toBeVisible();
    expect(core.calls).toContainEqual({
      method: 'applySshConfigImport',
      args: [{
        previewId: importPreview.previewId,
        selectedRowIds: [importPreview.items[0].id],
      }],
    });
  });

  it('shows a Chinese error when the SSH Config file is missing', async () => {
    const core = createFakeCoreClient({
      overrides: {
        previewSshConfigImport: async () => {
          throw {
            code: 'NOT_FOUND',
            message: '未找到 SSH Config 文件，请确认 ~/.ssh/config 存在',
            retryable: false,
          };
        },
      },
    });

    render(<App core={core} />);
    await screen.findByRole('heading', { name: '还没有服务器' });
    fireEvent.click(screen.getByRole('button', { name: '从 SSH Config 导入' }));

    const dialog = await screen.findByRole('dialog', { name: '导入 SSH Config' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '未找到 SSH Config 文件',
    );
    expect(within(dialog).getByRole('button', { name: '重新读取' })).toBeVisible();
  });
});

describe('Harbor monitoring workspace', () => {
  it('shows five calibrated cards, live header gauges, and the process table', async () => {
    const core = createFakeCoreClient({
      servers: [terminalServer('monitor-box')],
    });

    render(<App core={core} />);
    fireEvent.click(await screen.findByRole('button', {
      name: /^打开服务器 monitor-box/u,
    }));
    await screen.findByRole('tab', { name: '切换到 终端 1' });

    fireEvent.click(screen.getByRole('button', { name: '监控' }));

    expect(await screen.findByRole('heading', { name: '系统监控' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'CPU 概览' })).toBeVisible();
    expect(screen.getByRole('region', { name: '内存概览' })).toBeVisible();
    expect(screen.getByRole('region', { name: '磁盘概览' })).toBeVisible();
    expect(screen.getByRole('region', { name: '负载概览' })).toBeVisible();
    expect(screen.getByRole('region', { name: '运行时间概览' })).toBeVisible();
    expect(
      await within(screen.getByRole('region', { name: 'CPU 概览' })).findByText('34.0%'),
    ).toBeVisible();
    await waitFor(() => {
      expect(screen.getByLabelText('CPU 使用率')).toHaveTextContent('34.0%');
      expect(screen.getByLabelText('内存使用率')).toHaveTextContent('62.0%');
      expect(screen.getByLabelText('磁盘使用率')).toHaveTextContent('48.0%');
    });
    const table = screen.getByRole('table', { name: 'Top 10 进程' });
    expect(within(table).getByText('nginx worker')).toBeVisible();
    expect(within(table).getAllByText('postgres').length).toBeGreaterThan(0);
  });
});

function terminalServer(name: string, id = '019c62b2-2970-7000-8000-000000000006') {
  return {
    id,
    name,
    host: `${name}.example.com`,
    port: 22,
    user: 'deploy',
    authType: 'key' as const,
    secretRef: 'secret-ref-fixture',
    groupId: null,
    favorite: false,
    lastConnectedAt: null,
    createdAt: 1_699_000_000,
  };
}
