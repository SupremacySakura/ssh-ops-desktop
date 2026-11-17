// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import type {
  ConnectionHandle,
  RemoteFileEntry,
} from '@opspilot/contracts';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFakeCoreClient } from '../../test/fake-core';
import { FileBrowser } from './file-browser';

vi.mock('./code-editor', () => ({
  CodeEditor: ({
    onChange,
    value,
  }: {
    onChange(value: string): void;
    value: string;
  }) => (
    <textarea
      aria-label="远程文件内容"
      onChange={(event) => onChange(event.target.value)}
      value={value}
    />
  ),
}));

const connection: ConnectionHandle = {
  serverId: '019c62b2-2970-7000-8000-000000000003',
  connectionId: '019c62b2-2970-7000-8000-000000000010',
};
const hash = '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03';
const etc: RemoteFileEntry = {
  name: 'etc',
  path: '/etc',
  kind: 'directory',
  size: 0,
  modifiedAt: 1_700_000_000,
  permissions: 0o755,
};
const config: RemoteFileEntry = {
  name: 'app.conf',
  path: '/app.conf',
  kind: 'file',
  size: 6,
  modifiedAt: 1_700_000_100,
  permissions: 0o640,
};
const link: RemoteFileEntry = {
  name: 'current',
  path: '/current',
  kind: 'symlink',
  size: 10,
  modifiedAt: 1_700_000_200,
  permissions: 0o777,
};
const nginx: RemoteFileEntry = {
  name: 'nginx.conf',
  path: '/etc/nginx.conf',
  kind: 'file',
  size: 12,
  modifiedAt: 1_700_000_300,
  permissions: 0o644,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function readyCore() {
  return createFakeCoreClient({
    files: {
      entriesByDirectory: {
        '/': [config, link, etc],
        '/etc': [nginx],
      },
      documents: {
        '/app.conf': {
          path: '/app.conf',
          text: 'hello\n',
          sha256: hash,
          size: 6,
          modifiedAt: 1_700_000_100,
        },
      },
    },
  });
}

function renderBrowser({
  active = true,
  core = readyCore(),
  jumpRequest = null,
  onReconnect = vi.fn(),
  status = 'ready' as const,
}: {
  active?: boolean;
  core?: ReturnType<typeof readyCore>;
  jumpRequest?: { nonce: number; path: string; notice?: string } | null;
  onReconnect?: () => void;
  status?: 'ready' | 'closed';
} = {}) {
  const view = render(
    <FileBrowser
      active={active}
      connection={status === 'ready' ? connection : null}
      connectionStatus={status}
      core={core}
      jumpRequest={jumpRequest}
      onReconnect={onReconnect}
    />,
  );
  return { ...view, core, onReconnect };
}

describe('FileBrowser', () => {
  it('lists directories first with size, modified time, and permissions', async () => {
    const { core } = renderBrowser();

    const table = await screen.findByRole('table', { name: '目录内容' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0]).getByRole('button', { name: '打开目录 etc' })).toBeVisible();
    expect(within(rows[1]).getByRole('button', { name: '打开文件 app.conf' })).toBeVisible();
    expect(within(rows[2]).getByRole('button', { name: '打开文件 current' })).toBeVisible();
    expect(within(rows[1]).getByText('6 B')).toBeVisible();
    expect(within(rows[1]).getByText('0640')).toBeVisible();
    expect(within(rows[1]).getByText('2023-11-15 06:15')).toBeVisible();
    expect(core.calls).toContainEqual(expect.objectContaining({
      method: 'listFiles',
      args: [connection, '/'],
    }));
  });

  it('opens directories on double click and keeps breadcrumbs and tree selection in sync', async () => {
    const { core } = renderBrowser();

    fireEvent.doubleClick(await screen.findByRole('button', { name: '打开目录 etc' }));
    expect(await screen.findByRole('button', { name: '打开文件 nginx.conf' })).toBeVisible();
    expect(screen.getByRole('button', { name: '跳转到 /etc' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('button', { name: '目录 /etc' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(core.calls).toContainEqual(expect.objectContaining({
      method: 'listFiles',
      args: [connection, '/etc'],
    }));
  });

  it('shows an offline state with a reconnect action and never opens SFTP', () => {
    const onReconnect = vi.fn();
    const { core } = renderBrowser({ status: 'closed', onReconnect });

    expect(screen.getByRole('heading', { name: '服务器连接已断开' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '重新连接服务器' }));
    expect(onReconnect).toHaveBeenCalledOnce();
    expect(core.calls.some((call) => call.method === 'listFiles')).toBe(false);
  });

  it('applies terminal jump requests and surfaces the fallback warning', async () => {
    const core = readyCore();
    const { rerender } = renderBrowser({ core });
    await screen.findByRole('table', { name: '目录内容' });

    rerender(
      <FileBrowser
        active
        connection={connection}
        connectionStatus="ready"
        core={core}
        jumpRequest={{
          nonce: 1,
          path: '/etc',
          notice: '无法确定终端当前目录，已打开根目录',
        }}
        onReconnect={vi.fn()}
      />,
    );

    expect(await screen.findByText('无法确定终端当前目录，已打开根目录')).toBeVisible();
    expect(await screen.findByRole('button', { name: '打开文件 nginx.conf' })).toBeVisible();
  });

  it('keeps a retry action when a directory read fails', async () => {
    let attempts = 0;
    const base = readyCore();
    const core = createFakeCoreClient({
      files: {
        entriesByDirectory: {
          '/': [etc],
        },
      },
      overrides: {
        listFiles: async (target, path) => {
          attempts += 1;
          if (attempts === 1) {
            throw Object.assign(new Error('远程目录读取失败'), {
              code: 'SSH_CONNECTION',
              retryable: true,
            });
          }
          return base.listFiles(target, path);
        },
      },
    });
    renderBrowser({ core });

    expect(await screen.findByRole('heading', { name: '目录读取失败' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '重试目录' }));
    expect(await screen.findByRole('button', { name: '打开目录 etc' })).toBeVisible();
    await waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2));
  });

  it('opens a text file in the editor', async () => {
    const core = readyCore();
    core.calls.length = 0;
    renderBrowser({ core });
    await screen.findByRole('table', { name: '目录内容' });

    fireEvent.doubleClick(screen.getByRole('button', { name: '打开文件 app.conf' }));
    expect(await screen.findByRole('dialog', { name: '编辑 app.conf' })).toBeVisible();
    expect(core.calls).toContainEqual({
      method: 'readFile',
      args: [connection, '/app.conf'],
    });
  });

  it('keeps the editor draft mounted when the server connection drops', async () => {
    const core = readyCore();
    const { rerender } = renderBrowser({ core });
    fireEvent.doubleClick(await screen.findByRole('button', { name: '打开文件 app.conf' }));
    const editor = await screen.findByRole('textbox', { name: '远程文件内容' });
    fireEvent.change(editor, { target: { value: 'draft survives\n' } });

    rerender(
      <FileBrowser
        active
        connection={null}
        connectionStatus="closed"
        core={core}
        jumpRequest={null}
        onReconnect={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: '服务器连接已断开' })).toBeVisible();
    expect(screen.getByRole('dialog', { name: '编辑 app.conf' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: '远程文件内容' })).toHaveValue(
      'draft survives\n',
    );
  });

  it('refuses an oversized file without reading it into the editor', async () => {
    const large: RemoteFileEntry = {
      name: 'large.log',
      path: '/large.log',
      kind: 'file',
      size: 2 * 1024 * 1024,
      modifiedAt: 1_700_000_400,
      permissions: 0o644,
    };
    const core = createFakeCoreClient({
      files: {
        entriesByDirectory: {
          '/': [large],
        },
      },
    });
    renderBrowser({ core });
    fireEvent.doubleClick(await screen.findByRole('button', { name: '打开文件 large.log' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('超过 1 MiB');
    expect(core.calls.some((call) => call.method === 'readFile')).toBe(false);
  });

  it('does not follow symlinks or open binary read errors in the editor', async () => {
    const core = createFakeCoreClient({
      files: {
        entriesByDirectory: {
          '/': [link, config],
        },
      },
      overrides: {
        readFile: async () => {
          throw Object.assign(
            new Error('远程文件包含 NUL，按二进制文件处理，未打开编辑器'),
            { code: 'VALIDATION', retryable: false },
          );
        },
      },
    });
    renderBrowser({ core });

    fireEvent.doubleClick(await screen.findByRole('button', { name: '打开文件 current' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('符号链接');
    expect(core.calls.some((call) => call.method === 'readFile')).toBe(false);

    fireEvent.doubleClick(screen.getByRole('button', { name: '打开文件 app.conf' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('按二进制文件处理');
    expect(screen.queryByRole('dialog', { name: '编辑 app.conf' })).not.toBeInTheDocument();
  });

  it('downloads a bounded file through the WebView fallback', async () => {
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    const createObjectURL = vi.fn(() => 'blob:harbor-download');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    try {
      const core = readyCore();
      renderBrowser({ core });
      fireEvent.click(await screen.findByRole('button', { name: '下载 app.conf' }));

      expect(await screen.findByRole('status')).toHaveTextContent(
        '已开始下载 app.conf',
      );
      expect(core.calls).toContainEqual({
        method: 'downloadFile',
        args: [connection, '/app.conf'],
      });
      expect(createObjectURL).toHaveBeenCalledOnce();
    } finally {
      if (originalCreate) {
        Object.defineProperty(URL, 'createObjectURL', originalCreate);
      } else {
        Reflect.deleteProperty(URL, 'createObjectURL');
      }
      if (originalRevoke) {
        Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
      } else {
        Reflect.deleteProperty(URL, 'revokeObjectURL');
      }
    }
  });
});
