// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionHandle, ServerSummary } from '@opspilot/contracts';
import type { CoreClient } from '../../api/core';
import { TerminalPage } from './terminal-page';

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 120;
    rows = 32;
    dispose() { /* fixture */ }
    loadAddon() { /* fixture */ }
    onData() { return { dispose() { /* fixture */ } }; }
    open() { /* fixture */ }
    reset() { /* fixture */ }
    write() { /* fixture */ }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() { /* fixture */ } } }));

afterEach(cleanup);

const server = {
  id: '00000000-0000-4000-8000-000000000001', name: 'web-01', host: 'example.com', port: 22,
  username: 'deploy', environment: 'production', authType: 'ssh_agent', tagIds: [],
} as ServerSummary;
const connection = {
  serverId: server.id, connectionId: '00000000-0000-4000-8000-000000000002',
} as ConnectionHandle;

describe('TerminalPage', () => {
  it('streams scoped output and guards multiline paste before writing', async () => {
    let onData: ((event: { terminalSessionId: string; sequence: number; bytes: number[] }) => void) | undefined;
    const writeTerminal = vi.fn(async () => undefined);
    const core = {
      openTerminal: async () => ({ id: '00000000-0000-4000-8000-000000000003', connection }),
      subscribeTerminalData: async (handler: typeof onData) => { onData = handler; return () => undefined; },
      subscribeTerminalGap: async () => () => undefined,
      writeTerminal,
      closeTerminal: async () => undefined,
    } as unknown as CoreClient;
    render(<TerminalPage connections={[{ server, connection }]} core={core} />);

    fireEvent.click(screen.getByRole('button', { name: '新建终端会话' }));
    expect(await screen.findByText('已连接 · web-01')).toBeVisible();
    onData?.({ terminalSessionId: '00000000-0000-4000-8000-000000000003', sequence: 1, bytes: [36, 32] });
    await waitFor(() => expect(screen.getByLabelText('终端输出')).toHaveTextContent('$'));

    fireEvent.change(screen.getByLabelText('终端输入'), { target: { value: 'echo one\necho two' } });
    fireEvent.click(screen.getByRole('button', { name: '发送到终端' }));
    expect(await screen.findByRole('alertdialog', { name: '确认粘贴内容' })).toHaveTextContent('2 行');
    expect(writeTerminal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认发送' }));
    expect(writeTerminal).toHaveBeenCalled();
  });
});
