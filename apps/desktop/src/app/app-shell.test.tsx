// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from './app-shell';
import { ThemeProvider } from './theme';

afterEach(cleanup);

describe('AppShell', () => {
  it('renders the desktop navigation and topbar search', () => {
    const onNavigate = vi.fn();

    render(
      <ThemeProvider>
        <AppShell coreReady coreVersion="0.1.0" onNavigate={onNavigate} route="dashboard">
          <h1>服务器总览</h1>
        </AppShell>
      </ThemeProvider>,
    );

    expect(screen.getByRole('navigation', { name: '主导航' })).toBeVisible();
    expect(screen.getByPlaceholderText('搜索服务器、任务、文件...')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '服务器' }));
    expect(onNavigate).toHaveBeenCalledWith('servers');
  });

  it('collapses and expands the sidebar without removing navigation', () => {
    render(
      <ThemeProvider>
        <AppShell coreReady coreVersion="0.1.0" onNavigate={vi.fn()} route="dashboard">
          <h1>服务器总览</h1>
        </AppShell>
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '收起侧边栏' }));
    expect(screen.getByRole('button', { name: '展开侧边栏' })).toBeVisible();
    expect(screen.getByRole('button', { name: '服务器' })).toBeVisible();
  });
});
