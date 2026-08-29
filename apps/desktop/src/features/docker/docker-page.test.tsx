// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionHandle, ServerSummary } from '@opspilot/contracts';
import type { CoreClient } from '../../api/core';
import { DockerPage } from './docker-page';

afterEach(cleanup);

const server = {
  id: 's1', name: 'web-01', host: 'example.com', port: 22,
  username: 'deploy', environment: 'production' as const, authType: 'ssh_agent' as const, tagIds: [],
} as ServerSummary;
const connection = {
  serverId: server.id, connectionId: 'c1',
} as ConnectionHandle;

const core = {
  dockerVersion: async () => ({ version: '27.0.0', apiVersion: '1.47', os: 'linux', arch: 'amd64', transport: 'unix' }),
  dockerContainers: async () => [
    { id: 'a1', names: 'nginx-proxy', image: 'nginx:alpine', state: 'running', status: 'Up 3 days', ports: '0.0.0.0:80 -> 80' },
    { id: 'a2', names: 'redis-cache', image: 'redis:7-alpine', state: 'restarting', status: 'Restarting', ports: '6379' },
  ],
} as unknown as CoreClient;

describe('DockerPage', () => {
  it('renders the Docker design mockup body with real containers', async () => {
    render(<DockerPage connections={[{ server, connection }]} core={core} onExec={vi.fn()} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Docker' })).toBeVisible();
    expect(screen.getByText('容器与镜像管理')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Docker 服务器' })).toHaveTextContent('web-01');
    expect(screen.getByRole('button', { name: '运行容器' })).toBeVisible();
    expect(screen.getByRole('button', { name: '容器' })).toHaveClass('active');

    fireEvent.click(screen.getByRole('button', { name: '运行容器' }));
    expect(await screen.findByText('nginx-proxy')).toBeVisible();
    expect(screen.getByText('redis-cache')).toBeVisible();
    expect(screen.getByText('nginx:alpine')).toBeVisible();
    expect(screen.getByText('Restarting')).toBeVisible();
  });
});
