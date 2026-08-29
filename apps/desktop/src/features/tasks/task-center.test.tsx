// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { CoreClient } from '../../api/core';
import { TasksPage } from './task-center';

afterEach(cleanup);

const core = {
  tasks: async () => [
    { taskId: 'task-1', sequence: 1, status: 'running', progress: 75, createdAt: '2026-08-08T14:30:00Z', currentStep: '部署 ecommerce-backend' },
    { taskId: 'task-2', sequence: 2, status: 'succeeded', progress: 100, createdAt: '2026-08-08T12:00:00Z', currentStep: 'Nginx 配置检查' },
    { taskId: 'task-3', sequence: 3, status: 'failed', progress: 40, createdAt: '2026-08-08T11:00:00Z', currentStep: '重启 redis-cache' },
  ],
} as unknown as CoreClient;

describe('TasksPage', () => {
  it('renders the task list and log output from real tasks', async () => {
    render(<TasksPage core={core} />);

    expect(screen.getByRole('heading', { level: 1, name: '任务与日志' })).toBeVisible();
    expect(screen.getByText('追踪异步任务与执行历史')).toBeVisible();
    expect(screen.getByRole('button', { name: '导出日志' })).toBeVisible();
    expect(screen.getByRole('button', { name: '运行中' })).toHaveClass('active');
    expect(screen.getByRole('button', { name: '已完成' })).toBeVisible();
    expect(screen.getByRole('button', { name: '失败' })).toBeVisible();
    expect(screen.getByText('任务列表')).toBeVisible();
    expect(await screen.findByText('部署 ecommerce-backend')).toBeVisible();
    expect(screen.getAllByText('75%').length).toBeGreaterThan(0);
    expect(screen.getByText('任务 #task-1 输出')).toBeVisible();
  });

  it('switches the active tab', async () => {
    render(<TasksPage core={core} />);

    const completed = screen.getByRole('button', { name: '已完成' });
    const failed = screen.getByRole('button', { name: '失败' });
    const running = screen.getByRole('button', { name: '运行中' });

    fireEvent.click(completed);
    expect(completed).toHaveClass('active');
    expect(running).not.toHaveClass('active');

    fireEvent.click(failed);
    expect(failed).toHaveClass('active');
    expect(completed).not.toHaveClass('active');
  });
});
