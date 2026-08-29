// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CoreClient } from '../../api/core';
import { AgentPage } from './agent-page';

afterEach(cleanup);

const baseProps = {
  connections: [{ server: { id: 's1', name: 'srv', host: 'h', port: 22, username: 'u', environment: 'production' as const, authType: 'password' as const, tagIds: [] }, connection: { serverId: 's1', connectionId: 'c1' } }],
  core: {} as CoreClient,
  profiles: [{ id: 'p1', name: 'OpenAI', provider: 'openai-compatible' as const, baseUrl: 'http://localhost', model: 'gpt-4o', timeoutMs: 30000, hasApiKey: true, isDefault: true }],
  servers: [{ id: 's1', name: 'srv', host: 'h', port: 22, username: 'u', environment: 'production' as const, authType: 'password' as const, tagIds: [] }],
};

describe('AgentPage', () => {
  it('renders the chat console from the design mockup', () => {
    render(<AgentPage availability={{ agentAvailable: true }} {...baseProps} />);

    expect(screen.getByRole('heading', { name: 'AI Agent' })).toBeVisible();
    expect(screen.getByPlaceholderText('输入指令或问题...')).toBeVisible();
    expect(screen.getByRole('button', { name: '发送' })).toBeVisible();
    expect(screen.getByText('输入指令或问题，Agent 的回复会显示在这里')).toBeVisible();
    expect(screen.getByText('Agent 将只在获得你确认后执行破坏性操作')).toBeVisible();
  });

  it('allows the user to type and send a message', async () => {
    const createAgentThread = vi.fn(async () => ({ id: 'thread-1', title: 'Test', contextSummary: '', summaryVersion: 1, updatedAt: '2026-08-08T00:00:00Z' }));
    const startAgentRun = vi.fn(async () => ({ id: 'run-1', threadId: 'thread-1', serverId: 's1', modelProfileId: 'p1', status: 'succeeded' as const, sequence: 1, inputSummary: 'hello', outputSummary: 'Done', updatedAt: '2026-08-08T00:00:00Z' }));
    const core = { createAgentThread, startAgentRun } as unknown as CoreClient;

    render(<AgentPage availability={{ agentAvailable: true }} {...baseProps} core={core} />);
    fireEvent.change(screen.getByPlaceholderText('输入指令或问题...'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('Done')).toBeVisible();
  });

  it('shows a degraded state when the sidecar is unavailable', () => {
    render(<AgentPage availability={{ agentAvailable: false, reason: 'crash_loop' }} {...baseProps} />);

    expect(screen.getByRole('alert')).toHaveTextContent('crash_loop');
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  });
});
