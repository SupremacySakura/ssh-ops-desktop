// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import App from './App';
import { useHarborStore } from './store/harbor-store';
import { createFakeCoreClient } from './test/fake-core';

const readyCore = createFakeCoreClient({
  health: {
    version: 'test-version',
    databaseReady: true,
    secretStoreReady: true,
  },
});

beforeEach(() => {
  useHarborStore.getState().reset();
});

afterEach(cleanup);

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
    expect(within(palette).queryByText('从 SSH Config 导入')).not.toBeInTheDocument();

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
});
