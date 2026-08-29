// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServerSummary } from '@opspilot/contracts';
import type { CoreClient } from '../../api/core';
import { ServerListPage } from './server-list-page';

afterEach(cleanup);

const servers = [
  { id: 's1', name: 'production-web-01', host: '192.168.1.101', port: 22, username: 'root', environment: 'production', authType: 'password', tagIds: [], lastConnectedAt: '2026-08-08T10:00:00Z' },
  { id: 's2', name: 'staging-db-01', host: '10.0.2.15', port: 22, username: 'ubuntu', environment: 'staging', authType: 'private_key', tagIds: [] },
  { id: 's3', name: 'dev-workstation', host: '172.16.0.8', port: 22, username: 'shi', environment: 'development', authType: 'ssh_agent', tagIds: [] },
] as ServerSummary[];

function renderPage() {
  return render(<ServerListPage core={{} as unknown as CoreClient} onCreated={vi.fn()} servers={servers} />);
}

describe('ServerListPage', () => {
  it('renders the page header, filter card, data table and pagination from the design mockup', () => {
    renderPage();

    expect(screen.getByRole('heading', { name: '服务器' })).toBeInTheDocument();
    expect(screen.getByText('管理 SSH 主机、分组与连接状态')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导入' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加服务器' })).toBeInTheDocument();

    expect(screen.getByPlaceholderText('搜索名称、IP、用户名...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '环境筛选' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '分组筛选' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '认证筛选' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '筛选' })).toBeInTheDocument();

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('production-web-01')).toBeInTheDocument();
    expect(screen.getByText('192.168.1.101:22 · root')).toBeInTheDocument();
    expect(screen.getByText('staging-db-01')).toBeInTheDocument();
    expect(screen.getByText('dev-workstation')).toBeInTheDocument();

    expect(screen.getByText('显示 1-3 共 3 台')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上一页' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一页' })).toBeInTheDocument();
  });

  it('filters rows by search query and environment select', () => {
    renderPage();

    fireEvent.change(screen.getByPlaceholderText('搜索名称、IP、用户名...'), {
      target: { value: 'staging' },
    });
    expect(screen.getByText('staging-db-01')).toBeInTheDocument();
    expect(screen.queryByText('production-web-01')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('搜索名称、IP、用户名...'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: '环境筛选' }));
    fireEvent.click(screen.getByRole('option', { name: 'production' }));
    expect(screen.getByText('production-web-01')).toBeInTheDocument();
    expect(screen.queryByText('staging-db-01')).not.toBeInTheDocument();
  });

  it('shows an empty state when no row matches the filters', () => {
    renderPage();

    fireEvent.change(screen.getByPlaceholderText('搜索名称、IP、用户名...'), {
      target: { value: 'no-such-server' },
    });
    expect(screen.getByText('没有匹配的服务器')).toBeInTheDocument();
  });
});
