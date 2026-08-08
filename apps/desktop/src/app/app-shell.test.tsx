// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from './app-shell';

afterEach(cleanup);

describe('AppShell', () => {
  it('renders the desktop navigation and keeps production and Core context visible', () => {
    const onNavigate = vi.fn();

    render(
      <AppShell
        coreReady
        coreVersion="0.1.0"
        environment="production"
        onEnvironmentChange={vi.fn()}
        onNavigate={onNavigate}
        route="dashboard"
      >
        <h1>服务器总览</h1>
      </AppShell>,
    );

    expect(screen.getByRole('navigation', { name: '主导航' })).toBeVisible();
    expect(screen.getByRole('button', { name: '搜索服务器、项目或命令' })).toBeVisible();
    expect(screen.getByLabelText('当前环境')).toHaveTextContent('生产环境');
    expect(screen.getByRole('status', { name: 'Core 状态' })).toHaveTextContent('Core 0.1.0');
    fireEvent.click(screen.getByRole('button', { name: '服务器' }));
    expect(onNavigate).toHaveBeenCalledWith('servers');
  });

  it('collapses and expands the sidebar without removing navigation', () => {
    render(
      <AppShell
        coreReady
        coreVersion="0.1.0"
        environment="all"
        onEnvironmentChange={vi.fn()}
        onNavigate={vi.fn()}
        route="dashboard"
      >
        <h1>服务器总览</h1>
      </AppShell>,
    );

    fireEvent.click(screen.getByRole('button', { name: '收起侧栏' }));
    expect(screen.getByRole('button', { name: '展开侧栏' })).toBeVisible();
    expect(screen.getByRole('button', { name: '服务器' })).toBeVisible();
  });
});
