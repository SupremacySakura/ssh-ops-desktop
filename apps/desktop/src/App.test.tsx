// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import App from './App';

afterEach(cleanup);

describe('App health status', () => {
  it('shows explicit readiness returned through the CoreClient boundary', async () => {
    const core = {
      health: async () => ({
        version: 'test-version',
        databaseReady: true,
        secretStoreReady: true,
      }),
    };

    render(<App core={core} />);

    expect(await screen.findByText('Core 已就绪')).toBeVisible();
    expect(screen.getByRole('status', { name: 'Core 状态' })).toHaveTextContent('Core test-version');
  });

  it('shows an error instead of loading forever when Core health rejects', async () => {
    const core = {
      health: () => Promise.reject(new Error('IPC unavailable')),
    };

    render(<App core={core} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取 Core 状态');
    expect(screen.queryByText('正在检查 Core')).not.toBeInTheDocument();
  });

  it('keeps visited pages mounted so in-page state survives tab switches', async () => {
    const core = {
      health: async () => ({
        version: 'test-version',
        databaseReady: true,
        secretStoreReady: true,
      }),
    };

    render(<App core={core} />);
    expect(await screen.findByText('服务器总览')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '服务器' }));
    const search = await screen.findByLabelText('搜索服务器');
    fireEvent.change(search, { target: { value: 'web-01' } });

    fireEvent.click(screen.getByRole('button', { name: '仪表盘' }));
    expect(screen.getByText('服务器总览')).toBeVisible();
    // 离开的页面保持挂载但隐藏，搜索词不丢失。
    expect(screen.getByText('服务器管理')).not.toBeVisible();
    expect(screen.getByLabelText('搜索服务器')).toHaveValue('web-01');

    fireEvent.click(screen.getByRole('button', { name: '服务器' }));
    expect(screen.getByLabelText('搜索服务器')).toHaveValue('web-01');
    expect(screen.getByText('服务器管理')).toBeVisible();
  });
});
