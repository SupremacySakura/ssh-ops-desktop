// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import App from './App';
import { ThemeProvider } from './app/theme';

afterEach(cleanup);

const readyCore = {
  health: async () => ({
    version: 'test-version',
    databaseReady: true,
    secretStoreReady: true,
  }),
};

describe('App health status', () => {
  it('shows explicit readiness returned through the CoreClient boundary', async () => {
    render(<ThemeProvider><App core={readyCore} /></ThemeProvider>);

    expect(await screen.findByText('Core 运行正常 · test-version')).toBeVisible();
  });

  it('shows an error instead of loading forever when Core health rejects', async () => {
    const core = {
      health: () => Promise.reject(new Error('IPC unavailable')),
    };

    render(<ThemeProvider><App core={core} /></ThemeProvider>);

    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取 Core 状态');
    expect(screen.queryByText('正在检查 Core')).not.toBeInTheDocument();
  });

  it('keeps visited pages mounted so in-page state survives tab switches', async () => {
    render(<ThemeProvider><App core={readyCore} /></ThemeProvider>);
    expect(await screen.findByRole('heading', { name: '仪表盘' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '服务器' }));
    const search = await screen.findByPlaceholderText('搜索名称、IP、用户名...');
    fireEvent.change(search, { target: { value: 'web-01' } });

    fireEvent.click(screen.getByRole('button', { name: '仪表盘' }));
    expect(screen.getByRole('heading', { name: '仪表盘' })).toBeVisible();
    // 离开的页面保持挂载但隐藏，搜索词不丢失。
    expect(screen.getByRole('heading', { name: '服务器', hidden: true })).not.toBeVisible();
    expect(screen.getByPlaceholderText('搜索名称、IP、用户名...')).toHaveValue('web-01');

    fireEvent.click(screen.getByRole('button', { name: '服务器' }));
    expect(screen.getByPlaceholderText('搜索名称、IP、用户名...')).toHaveValue('web-01');
    expect(screen.getByRole('heading', { name: '服务器', hidden: true })).toBeVisible();
  });
});
