// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServerSummary } from '@opspilot/contracts';
import type { CoreClient } from '../../api/core';
import { DashboardPage } from './dashboard-page';

afterEach(cleanup);

const server = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'web-01',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  environment: 'production',
  authType: 'ssh_agent',
  tagIds: [],
} as ServerSummary;

describe('DashboardPage', () => {
  it('renders key metrics and recent activity', () => {
    render(<DashboardPage agent={{ agentAvailable: true }} connections={[]} core={{ tasks: async () => [] } as unknown as CoreClient} servers={[server]} />);
    expect(screen.getByText('服务器总数')).toBeVisible();
    expect(screen.getByText('最近活动')).toBeVisible();
  });

  it('routes the add-server action', () => {
    const onAddServer = vi.fn();
    render(<DashboardPage agent={{ agentAvailable: false, reason: 'not configured' }} connections={[]} core={{ tasks: async () => [] } as unknown as CoreClient} onAddServer={onAddServer} servers={[]} />);
    fireEvent.click(screen.getByRole('button', { name: '添加服务器' }));
    expect(onAddServer).toHaveBeenCalledOnce();
  });

  it('routes the Agent quick action', () => {
    const onOpenAgent = vi.fn();
    render(
      <DashboardPage
        agent={{ agentAvailable: false, reason: 'not configured' }}
        connections={[]}
        core={{ tasks: async () => [] } as unknown as CoreClient}
        onOpenAgent={onOpenAgent}
        servers={[]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: '开始对话' }));
    expect(onOpenAgent).toHaveBeenCalledOnce();
  });
});
