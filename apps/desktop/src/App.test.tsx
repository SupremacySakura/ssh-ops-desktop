// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import App from './App';
import type { CoreClient } from './api/core';
import { useHarborStore } from './store/harbor-store';

const readyCore: CoreClient = {
  health: async () => ({
    version: 'test-version',
    databaseReady: true,
    secretStoreReady: true,
  }),
};

beforeEach(() => {
  useHarborStore.getState().reset();
});

afterEach(cleanup);

describe('Harbor empty shell', () => {
  it('shows the brand, search, empty catalog, empty workspace, and ready Core', async () => {
    render(<App core={readyCore} />);

    expect(screen.getByText('HARBOR')).toBeVisible();
    expect(screen.getByRole('searchbox', { name: '搜索服务器' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '还没有服务器' })).toBeVisible();
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

  it('makes the catalog search reachable with Command-K', async () => {
    render(<App core={readyCore} />);

    const search = screen.getByRole('searchbox', { name: '搜索服务器' });
    expect(search).not.toHaveFocus();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(search).toHaveFocus();
  });

  it('keeps the shell visible and reports a Core failure explicitly', async () => {
    const unavailableCore: CoreClient = {
      health: () => Promise.reject(new Error('IPC unavailable')),
    };

    render(<App core={unavailableCore} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取 Core 状态');
    expect(screen.getByRole('heading', { name: '还没有服务器' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '未选择服务器' })).toBeVisible();
  });

  it('reports a reachable but unready Core without hiding the workspace', async () => {
    const unreadyCore: CoreClient = {
      health: async () => ({
        version: 'test-version',
        databaseReady: true,
        secretStoreReady: false,
      }),
    };

    render(<App core={unreadyCore} />);

    expect(await screen.findByText('Core 未就绪')).toBeVisible();
    expect(screen.getByRole('heading', { name: '未选择服务器' })).toBeVisible();
  });
});
