// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionHandle, ServerSummary } from '@opspilot/contracts';
import type { CoreClient } from '../../api/core';
import { TerminalPage } from './terminal-page';

afterEach(cleanup);

// xterm 视口只有在 matchMedia 存在时才会真正挂载；jsdom 里手动补齐以便驱动键盘输入。
window.matchMedia = window.matchMedia ?? (() => ({
  matches: false, media: '', onchange: null,
  addEventListener() { /* fixture */ }, removeEventListener() { /* fixture */ },
  addListener() { /* fixture */ }, removeListener() { /* fixture */ }, dispatchEvent: () => false,
})) as typeof window.matchMedia;

let xtermOnData: ((value: string) => void) | undefined;

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 120;
    rows = 32;
    dispose() { /* fixture */ }
    loadAddon() { /* fixture */ }
    onData(handler: (value: string) => void) { xtermOnData = handler; return { dispose() { /* fixture */ } }; }
    open() { /* fixture */ }
    reset() { /* fixture */ }
    write() { /* fixture */ }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() { /* fixture */ } } }));

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
    expect(screen.getByLabelText('终端连接摘要')).toHaveTextContent('web-01');
    expect(screen.getByRole('complementary', { name: '终端 AI 助手' })).toBeVisible();
    expect(screen.getByRole('link', { name: '前往 AI Agent 工作区' })).toHaveAttribute('href', '#agent');
    onData?.({ terminalSessionId: '00000000-0000-4000-8000-000000000003', sequence: 1, bytes: [36, 32] });
    await waitFor(() => expect(screen.getByLabelText('终端输出')).toHaveTextContent('$'));

    fireEvent.change(screen.getByLabelText('终端输入'), { target: { value: 'echo one\necho two' } });
    fireEvent.click(screen.getByRole('button', { name: '发送到终端' }));
    expect(await screen.findByRole('alertdialog', { name: '确认粘贴内容' })).toHaveTextContent('2 行');
    expect(writeTerminal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认发送' }));
    expect(writeTerminal).toHaveBeenCalled();
  });

  it('sends arrow-key escape sequences directly without paste confirmation', async () => {
    const writeTerminal = vi.fn(async () => undefined);
    const core = {
      openTerminal: async () => ({ id: '00000000-0000-4000-8000-000000000003', connection }),
      subscribeTerminalData: async () => () => undefined,
      subscribeTerminalGap: async () => () => undefined,
      writeTerminal,
      closeTerminal: async () => undefined,
    } as unknown as CoreClient;
    render(<TerminalPage connections={[{ server, connection }]} core={core} />);

    fireEvent.click(screen.getByRole('button', { name: '新建终端会话' }));
    expect(await screen.findByText('已连接 · web-01')).toBeVisible();

    xtermOnData?.('\x1b[A'); // ↑：历史上一条命令
    xtermOnData?.('\x1b[B'); // ↓：历史下一条命令
    await waitFor(() => expect(writeTerminal).toHaveBeenCalledTimes(2));
    expect(writeTerminal).toHaveBeenNthCalledWith(1, '00000000-0000-4000-8000-000000000003', [27, 91, 65]);
    expect(writeTerminal).toHaveBeenNthCalledWith(2, '00000000-0000-4000-8000-000000000003', [27, 91, 66]);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('confirms bracketed-paste markers, including modifier variants, before sending', async () => {
    const writeTerminal = vi.fn(async () => undefined);
    const core = {
      openTerminal: async () => ({ id: '00000000-0000-4000-8000-000000000003', connection }),
      subscribeTerminalData: async () => () => undefined,
      subscribeTerminalGap: async () => () => undefined,
      writeTerminal,
      closeTerminal: async () => undefined,
    } as unknown as CoreClient;
    render(<TerminalPage connections={[{ server, connection }]} core={core} />);

    fireEvent.click(screen.getByRole('button', { name: '新建终端会话' }));
    expect(await screen.findByText('已连接 · web-01')).toBeVisible();

    xtermOnData?.('\x1b[200~'); // 括号粘贴开始标记：必须确认
    expect(await screen.findByRole('alertdialog', { name: '确认粘贴内容' })).toBeVisible();
    expect(writeTerminal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    xtermOnData?.('\x1b[200;1~'); // 带修饰符的粘贴标记变体：同样必须确认
    expect(await screen.findByRole('alertdialog', { name: '确认粘贴内容' })).toBeVisible();
    expect(writeTerminal).not.toHaveBeenCalled();
  });
});
