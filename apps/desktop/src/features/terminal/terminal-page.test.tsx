// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { ConnectionHandle, ServerSummary } from '@opspilot/contracts';
import type { CoreClient } from '../../api/core';
import { TerminalPage } from './terminal-page';

afterEach(cleanup);

const server = {
  id: '00000000-0000-4000-8000-000000000001', name: 'web-01', host: 'example.com', port: 22,
  username: 'deploy', environment: 'production', authType: 'ssh_agent', tagIds: [],
} as ServerSummary;
const connection = {
  serverId: server.id, connectionId: '00000000-0000-4000-8000-000000000002',
} as ConnectionHandle;
const core = {
  subscribeTerminalData: async () => () => undefined,
  subscribeTerminalGap: async () => () => undefined,
} as unknown as CoreClient;

describe('TerminalPage', () => {
  it('renders the terminal page body matching the design mockup', () => {
    render(<TerminalPage connections={[{ server, connection }]} core={core} />);

    expect(screen.getByRole('heading', { name: '终端' })).toBeInTheDocument();
    expect(screen.getByText('安全的 SSH 会话管理')).toBeInTheDocument();

    expect(screen.getByRole('button', { name: '选择服务器' })).toHaveTextContent('web-01');
    expect(screen.getByRole('button', { name: '新建会话' })).toBeInTheDocument();

    expect(screen.getByText('尚无会话')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+' })).toBeInTheDocument();

    expect(screen.getByRole('button', { name: '断开' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '全屏' })).toBeInTheDocument();
  });
});
