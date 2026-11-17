// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import type {
  ConnectionHandle,
  RemoteDownload,
  RemoteFileEntry,
  RemoteRenameResult,
  RemoteTextFile,
  RemoteUploadOutcome,
} from '@opspilot/contracts';
import {
  act,
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

  it('loads ancestor directories when jumping to a deep path', async () => {
    const directory = (name: string, path: string): RemoteFileEntry => ({
      name,
      path,
      kind: 'directory',
      size: 0,
      modifiedAt: 1_700_000_000,
      permissions: 0o755,
    });
    const core = createFakeCoreClient({
      files: {
        entriesByDirectory: {
          '/': [directory('srv', '/srv')],
          '/srv': [directory('app', '/srv/app')],
          '/srv/app': [directory('releases', '/srv/app/releases')],
          '/srv/app/releases': [],
        },
      },
    });

    renderBrowser({
      core,
      jumpRequest: { nonce: 1, path: '/srv/app/releases' },
    });

    expect(await screen.findByRole('button', { name: '跳转到 /srv/app/releases' }))
      .toHaveAttribute('aria-current', 'page');
    expect(await screen.findByRole('button', { name: '目录 /srv' })).toBeVisible();
    expect(await screen.findByRole('button', { name: '目录 /srv/app' })).toBeVisible();
    expect(await screen.findByRole('button', { name: '目录 /srv/app/releases' }))
      .toHaveAttribute('aria-current', 'page');
    expect(core.calls.filter((call) => call.method === 'listFiles').map(
      (call) => call.args[1],
    )).toEqual(expect.arrayContaining(['/srv', '/srv/app', '/srv/app/releases']));
  });

  it('loads a tree directory only when it is expanded', async () => {
    const nginxDirectory: RemoteFileEntry = {
      name: 'nginx',
      path: '/etc/nginx',
      kind: 'directory',
      size: 0,
      modifiedAt: 1_700_000_300,
      permissions: 0o755,
    };
    const core = createFakeCoreClient({
      files: {
        entriesByDirectory: {
          '/': [etc],
          '/etc': [nginxDirectory],
        },
      },
    });
    renderBrowser({ core });

    expect(await screen.findByRole('button', { name: '目录 /etc' })).toBeVisible();
    expect(core.calls.some((call) => (
      call.method === 'listFiles' && call.args[1] === '/etc'
    ))).toBe(false);

    fireEvent.click(await screen.findByRole('button', { name: '展开目录 /etc' }));

    expect(await screen.findByRole('button', { name: '目录 /etc/nginx' })).toBeVisible();
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

  it('discards late read and download responses after the connection changes', async () => {
    let resolveRead!: (value: RemoteTextFile) => void;
    let resolveDownload!: (value: RemoteDownload) => void;
    const core = createFakeCoreClient({
      files: {
        entriesByDirectory: {
          '/': [config],
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
      overrides: {
        readFile: () => new Promise((resolve) => {
          resolveRead = resolve;
        }),
        downloadFile: () => new Promise((resolve) => {
          resolveDownload = resolve;
        }),
      },
    });
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    const createObjectURL = vi.fn(() => 'blob:stale-download');
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    try {
      const { rerender } = renderBrowser({ core });
      await screen.findByRole('table', { name: '目录内容' });
      fireEvent.doubleClick(screen.getByRole('button', { name: '打开文件 app.conf' }));
      fireEvent.click(screen.getByRole('button', { name: '下载 app.conf' }));

      const nextConnection: ConnectionHandle = {
        ...connection,
        connectionId: '019c62b2-2970-7000-8000-000000000011',
      };
      rerender(
        <FileBrowser
          active
          connection={nextConnection}
          connectionStatus="ready"
          core={core}
          jumpRequest={null}
          onReconnect={vi.fn()}
        />,
      );
      await screen.findByRole('table', { name: '目录内容' });

      await act(async () => {
        resolveRead({
          path: '/app.conf',
          text: 'hello\n',
          sha256: hash,
          size: 6,
          modifiedAt: 1_700_000_100,
        });
        resolveDownload({
          path: '/app.conf',
          bytes: [104, 101, 108, 108, 111, 10],
          sha256: hash,
        });
      });

      expect(screen.queryByRole('dialog', { name: '编辑 app.conf' }))
        .not.toBeInTheDocument();
      expect(createObjectURL).not.toHaveBeenCalled();
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

  it('uploads selected files after a batch review and refreshes the directory', async () => {
    const core = readyCore();
    renderBrowser({ core });
    await screen.findByRole('table', { name: '目录内容' });

    fireEvent.change(screen.getByLabelText('选择上传文件'), {
      target: {
        files: [
          new File(['one'], 'one.txt'),
          new File(['two'], 'two.txt'),
        ],
      },
    });

    const dialog = await screen.findByRole('dialog', { name: '上传文件到 /' });
    expect(within(dialog).getByText('one.txt')).toBeVisible();
    expect(within(dialog).getByText('two.txt')).toBeVisible();
    expect(within(dialog).getByText('2 个文件 · 6 B')).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认上传' }));

    expect(await screen.findByRole('status')).toHaveTextContent('已上传 2 个文件');
    expect(await screen.findByRole('button', { name: '打开文件 one.txt' })).toBeVisible();
    expect(core.calls).toContainEqual(expect.objectContaining({
      method: 'uploadFiles',
      args: [
        connection,
        '/',
        [
          { name: 'one.txt', bytes: [111, 110, 101] },
          { name: 'two.txt', bytes: [116, 119, 111] },
        ],
      ],
    }));
  });

  it('keeps the selected files but does not offer a pointless retry after a conflict', async () => {
    const core = createFakeCoreClient({
      files: {
        entriesByDirectory: {
          '/': [config],
        },
      },
    });
    renderBrowser({ core });
    await screen.findByRole('table', { name: '目录内容' });

    fireEvent.change(screen.getByLabelText('选择上传文件'), {
      target: { files: [new File(['replacement'], 'app.conf')] },
    });
    fireEvent.click(await screen.findByRole('button', { name: '确认上传' }));

    const dialog = await screen.findByRole('dialog', { name: '上传文件到 /' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('已存在');
    expect(within(dialog).getByText(/已回滚/)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: '关闭' })).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: '重试上传' }))
      .not.toBeInTheDocument();
    expect(within(dialog).getByText('app.conf')).toBeVisible();
  });

  it('rejects duplicate basenames before uploading a batch', async () => {
    const core = readyCore();
    renderBrowser({ core });
    await screen.findByRole('table', { name: '目录内容' });

    fireEvent.change(screen.getByLabelText('选择上传文件'), {
      target: {
        files: [
          new File(['one'], 'same.txt'),
          new File(['two'], 'same.txt'),
        ],
      },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('重复文件名 same.txt');
    expect(screen.queryByRole('dialog', { name: '上传文件到 /' })).not.toBeInTheDocument();
    expect(core.calls.some((call) => call.method === 'uploadFiles')).toBe(false);
  });

  it('shows residual upload paths without pretending rollback completed', async () => {
    const core = createFakeCoreClient({
      files: { entriesByDirectory: { '/': [] } },
      fileFaults: { failCommitAt: 2, failRollback: true },
    });
    renderBrowser({ core });
    await screen.findByRole('heading', { name: '目录为空' });

    fireEvent.change(screen.getByLabelText('选择上传文件'), {
      target: {
        files: [
          new File(['one'], 'one.txt'),
          new File(['two'], 'two.txt'),
        ],
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: '确认上传' }));

    const dialog = await screen.findByRole('dialog', { name: '上传文件到 /' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('回滚未完全完成');
    expect(within(dialog).getByText('/one.txt')).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: '重试上传' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '刷新目录' })).toBeVisible();
  });

  it('keeps residue visible when the follow-up directory refresh fails', async () => {
    let failList = false;
    const core = createFakeCoreClient({
      files: { entriesByDirectory: { '/': [] } },
      fileFaults: { failCommitAt: 2, failRollback: true },
      overrides: {
        listFiles: async () => {
          if (failList) throw new Error('injected list failure');
          return [];
        },
      },
    });
    renderBrowser({ core });
    await screen.findByRole('heading', { name: '目录为空' });

    fireEvent.change(screen.getByLabelText('选择上传文件'), {
      target: {
        files: [
          new File(['one'], 'one.txt'),
          new File(['two'], 'two.txt'),
        ],
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: '确认上传' }));
    const dialog = await screen.findByRole('dialog', { name: '上传文件到 /' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('回滚未完全完成');
    expect(within(dialog).getByText('/one.txt')).toBeVisible();

    failList = true;
    fireEvent.click(within(dialog).getByRole('button', { name: '刷新目录' }));
    expect(await screen.findByRole('heading', { name: '目录读取失败' })).toBeVisible();
    expect(screen.getByText('/one.txt')).toBeVisible();
    const notice = screen.getByText(/上传失败，回滚未完全完成/).closest('section');
    expect(notice).not.toBeNull();

    failList = false;
    fireEvent.click(within(notice as HTMLElement).getByRole('button', { name: '刷新目录' }));
    expect(await screen.findByRole('heading', { name: '目录为空' })).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByText(/上传失败，回滚未完全完成/)).not.toBeInTheDocument();
    });
  });

  it('warns when the upload batch total crosses 4 MiB without one large file', async () => {
    const core = readyCore();
    renderBrowser({ core });
    await screen.findByRole('table', { name: '目录内容' });

    const chunk = new Uint8Array(3 * 1024 * 1024);
    fireEvent.change(screen.getByLabelText('选择上传文件'), {
      target: {
        files: [
          new File([chunk], 'a.bin'),
          new File([chunk], 'b.bin'),
        ],
      },
    });

    const dialog = await screen.findByRole('dialog', { name: '上传文件到 /' });
    expect(within(dialog).getByText(/单文件或批次总计超过 4 MiB/)).toBeVisible();
  });

  it('shows rolled-back warnings and retries only retryable upload failures', async () => {
    let attempts = 0;
    const core = createFakeCoreClient({
      files: { entriesByDirectory: { '/': [] } },
      overrides: {
        uploadFiles: async (): Promise<RemoteUploadOutcome> => {
          attempts += 1;
          if (attempts === 1) {
            return {
              status: 'failed_rolled_back',
              committed: [],
              residual: [],
              warning: 'SFTP 会话清理失败',
              error: {
                code: 'INTERNAL',
                message: '写入中断',
                retryable: true,
              },
            };
          }
          return {
            status: 'failed_rolled_back',
            committed: [],
            residual: [],
            error: {
              code: 'CAPABILITY_UNAVAILABLE',
              message: '服务器不支持 hardlink',
              retryable: false,
            },
          };
        },
      },
    });
    renderBrowser({ core });
    await screen.findByRole('heading', { name: '目录为空' });

    fireEvent.change(screen.getByLabelText('选择上传文件'), {
      target: { files: [new File(['one'], 'one.txt')] },
    });
    fireEvent.click(await screen.findByRole('button', { name: '确认上传' }));

    const dialog = await screen.findByRole('dialog', { name: '上传文件到 /' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'SFTP 会话清理失败',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: '重试上传' }));

    await waitFor(() => expect(attempts).toBe(2));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '当前 SFTP 服务器不支持该文件操作',
    );
    expect(within(dialog).getByRole('alert')).toHaveTextContent('不可重试');
    expect(within(dialog).getByRole('alert')).not.toHaveTextContent('可重试。');
    expect(within(dialog).getByRole('button', { name: '关闭' })).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: '重试上传' }))
      .not.toBeInTheDocument();
  });

  it('retains a late upload residue after disconnect and refreshes after reconnect', async () => {
    let resolveUpload!: (value: RemoteUploadOutcome) => void;
    let uploadStarted = false;
    const core = createFakeCoreClient({
      files: { entriesByDirectory: { '/': [] } },
      overrides: {
        uploadFiles: () => new Promise<RemoteUploadOutcome>((resolve) => {
          uploadStarted = true;
          resolveUpload = resolve;
        }),
      },
    });
    const { rerender } = renderBrowser({ core });
    await screen.findByRole('heading', { name: '目录为空' });

    fireEvent.change(screen.getByLabelText('选择上传文件'), {
      target: {
        files: [
          new File(['one'], 'one.txt'),
          new File(['two'], 'two.txt'),
        ],
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: '确认上传' }));
    await waitFor(() => expect(uploadStarted).toBe(true));

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
    expect(await screen.findByRole('heading', { name: '服务器连接已断开' }))
      .toBeVisible();

    await act(async () => {
      resolveUpload({
        status: 'failed_with_residue',
        committed: ['/one.txt'],
        residual: ['/one.txt'],
        warning: '回滚未完全完成，以下路径可能仍然存在：/one.txt',
        error: {
          code: 'SSH_CONNECTION',
          message: '连接中断',
          retryable: true,
        },
      });
    });

    expect(await screen.findByText(/上一连接上传失败，回滚未完全完成/)).toBeVisible();
    expect(screen.getAllByText('/one.txt').length).toBeGreaterThan(0);
    const dialog = screen.getByRole('dialog', { name: '上传文件到 /' });
    expect(within(dialog).getByRole('button', { name: '重连后刷新' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog', { name: '上传文件到 /' }))
      .not.toBeInTheDocument();
    expect(screen.getByText(/上一连接上传失败/)).toBeVisible();

    const nextConnection: ConnectionHandle = {
      ...connection,
      connectionId: '019c62b2-2970-7000-8000-000000000011',
    };
    rerender(
      <FileBrowser
        active
        connection={nextConnection}
        connectionStatus="ready"
        core={core}
        jumpRequest={null}
        onReconnect={vi.fn()}
      />,
    );
    await screen.findByRole('heading', { name: '目录为空' });

    const notice = screen.getByText(/上一连接上传失败/).closest('section');
    expect(notice).not.toBeNull();
    const listCalls = core.calls.filter((call) => call.method === 'listFiles').length;
    fireEvent.click(within(notice as HTMLElement).getByRole('button', { name: '刷新目录' }));
    await waitFor(() => {
      expect(core.calls.filter((call) => call.method === 'listFiles').length)
        .toBeGreaterThan(listCalls);
    });
    await waitFor(() => {
      expect(screen.queryByText(/上一连接上传失败/)).not.toBeInTheDocument();
    });
  });

  it('retains a late partial rename and keeps source cleanup after reconnect', async () => {
    let resolveRename!: (value: RemoteRenameResult) => void;
    let renameStarted = false;
    const core = createFakeCoreClient({
      files: {
        entriesByDirectory: {
          '/': [config],
        },
      },
      overrides: {
        renameFile: () => new Promise<RemoteRenameResult>((resolve) => {
          renameStarted = true;
          resolveRename = resolve;
        }),
      },
    });
    const { rerender } = renderBrowser({ core });
    await screen.findByRole('table', { name: '目录内容' });

    fireEvent.click(screen.getByRole('button', { name: '重命名 app.conf' }));
    const dialog = await screen.findByRole('dialog', { name: '重命名 app.conf' });
    fireEvent.change(within(dialog).getByLabelText('新名称'), {
      target: { value: 'next.conf' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认重命名' }));
    await waitFor(() => expect(renameStarted).toBe(true));

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
    await act(async () => {
      resolveRename({
        status: 'partial',
        sourcePath: '/app.conf',
        targetPath: '/next.conf',
        targetCreated: true,
        warning: '目标文件已创建，但源文件删除失败或结果未知；请刷新目录核对后重试清理源文件。',
        error: {
          code: 'INTERNAL',
          message: '源文件删除失败或结果未知',
          retryable: true,
        },
      });
    });

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '源文件删除失败或结果未知',
    );
    expect(within(dialog).getByText('/next.conf')).toBeVisible();
    expect(screen.getByText(
      /上一连接已将 \/app.conf 重命名为 \/next.conf，但源文件可能仍然存在/,
    )).toBeVisible();
    expect(within(dialog).getByRole('button', { name: '重连后清理' })).toBeDisabled();

    const nextConnection: ConnectionHandle = {
      ...connection,
      connectionId: '019c62b2-2970-7000-8000-000000000012',
    };
    rerender(
      <FileBrowser
        active
        connection={nextConnection}
        connectionStatus="ready"
        core={core}
        jumpRequest={null}
        onReconnect={vi.fn()}
      />,
    );
    await screen.findByRole('table', { name: '目录内容' });
    expect(within(dialog).getByRole('button', { name: '删除源文件…' })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '删除源文件…' }));

    const cleanup = await screen.findByRole('alertdialog', { name: '删除文件' });
    expect(within(cleanup).getByText('/app.conf')).toBeVisible();
    fireEvent.click(within(cleanup).getByRole('button', { name: '取消' }));
  });

  it('retains a late delete success after disconnect', async () => {
    let resolveDelete!: (value: { path: string }) => void;
    let deleteStarted = false;
    const core = createFakeCoreClient({
      files: {
        entriesByDirectory: {
          '/': [config],
        },
      },
      overrides: {
        deleteFile: () => new Promise<{ path: string }>((resolve) => {
          deleteStarted = true;
          resolveDelete = resolve;
        }),
      },
    });
    const { rerender } = renderBrowser({ core });
    await screen.findByRole('table', { name: '目录内容' });

    fireEvent.click(screen.getByRole('button', { name: '删除 app.conf' }));
    const confirm = await screen.findByRole('alertdialog', { name: '删除文件' });
    fireEvent.click(within(confirm).getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(deleteStarted).toBe(true));

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
    await act(async () => {
      resolveDelete({ path: '/app.conf' });
    });

    expect(await screen.findByText('上一连接已删除 /app.conf。')).toBeVisible();
    expect(screen.queryByRole('alertdialog', { name: '删除文件' }))
      .not.toBeInTheDocument();
  });

  it('uploads to the directory captured when the upload dialog opened', async () => {
    const core = readyCore();
    const { rerender } = renderBrowser({ core });
    fireEvent.doubleClick(await screen.findByRole('button', { name: '打开目录 etc' }));
    await screen.findByRole('button', { name: '打开文件 nginx.conf' });

    fireEvent.change(screen.getByLabelText('选择上传文件'), {
      target: { files: [new File(['one'], 'one.txt')] },
    });
    expect(await screen.findByRole('dialog', { name: '上传文件到 /etc' })).toBeVisible();

    rerender(
      <FileBrowser
        active
        connection={connection}
        connectionStatus="ready"
        core={core}
        jumpRequest={{ nonce: 1, path: '/' }}
        onReconnect={vi.fn()}
      />,
    );
    expect(await screen.findByRole('button', { name: '打开文件 app.conf' })).toBeVisible();
    expect(screen.getByRole('dialog', { name: '上传文件到 /etc' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '确认上传' }));
    await waitFor(() => expect(core.calls).toContainEqual(expect.objectContaining({
      method: 'uploadFiles',
      args: [
        connection,
        '/etc',
        [{ name: 'one.txt', bytes: [111, 110, 101] }],
      ],
    })));
  });

  it('creates a folder in the directory captured when the dialog opened', async () => {
    const core = readyCore();
    const { rerender } = renderBrowser({ core });
    fireEvent.doubleClick(await screen.findByRole('button', { name: '打开目录 etc' }));
    await screen.findByRole('button', { name: '打开文件 nginx.conf' });

    fireEvent.click(screen.getByRole('button', { name: '新建文件夹' }));
    const dialog = await screen.findByRole('dialog', { name: '新建文件夹' });
    fireEvent.change(within(dialog).getByLabelText('文件夹名称'), {
      target: { value: 'release' },
    });

    rerender(
      <FileBrowser
        active
        connection={connection}
        connectionStatus="ready"
        core={core}
        jumpRequest={{ nonce: 1, path: '/' }}
        onReconnect={vi.fn()}
      />,
    );
    expect(await screen.findByRole('button', { name: '打开文件 app.conf' })).toBeVisible();
    expect(within(dialog).getByText(
      '将在 /etc 下创建单层目录；不会自动创建缺失的父目录。',
    )).toBeVisible();

    fireEvent.click(within(dialog).getByRole('button', { name: '创建文件夹' }));
    await waitFor(() => expect(core.calls).toContainEqual({
      method: 'createDirectory',
      args: [connection, '/etc/release'],
    }));
  });

  it('traps focus, inerts the background, and ignores Escape while hidden', async () => {
    const core = readyCore();
    const { rerender } = renderBrowser({ core });
    await screen.findByRole('table', { name: '目录内容' });

    fireEvent.change(screen.getByLabelText('选择上传文件'), {
      target: { files: [new File(['one'], 'one.txt')] },
    });
    const dialog = await screen.findByRole('dialog', { name: '上传文件到 /' });
    expect(screen.getByLabelText('选择上传文件')).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('table', { name: '目录内容' }).closest('[inert]'))
      .not.toBeNull();

    const closeButton = within(dialog).getByRole('button', { name: '关闭对话框' });
    const confirmButton = within(dialog).getByRole('button', { name: '确认上传' });
    confirmButton.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(closeButton).toHaveFocus();
    closeButton.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(confirmButton).toHaveFocus();

    rerender(
      <FileBrowser
        active={false}
        connection={connection}
        connectionStatus="ready"
        core={core}
        jumpRequest={null}
        onReconnect={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: '上传文件到 /' })).toBeInTheDocument();

    rerender(
      <FileBrowser
        active
        connection={connection}
        connectionStatus="ready"
        core={core}
        jumpRequest={null}
        onReconnect={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '上传文件到 /' }))
      .not.toBeInTheDocument();
    expect(screen.getByRole('table', { name: '目录内容' }).closest('[inert]'))
      .toBeNull();
  });

  it('does not dismiss a hidden delete confirmation with Escape', async () => {
    const core = readyCore();
    const { rerender } = renderBrowser({ core });
    await screen.findByRole('table', { name: '目录内容' });

    fireEvent.click(screen.getByRole('button', { name: '删除 app.conf' }));
    const confirm = await screen.findByRole('alertdialog', { name: '删除文件' });
    expect(within(confirm).getByRole('button', { name: '取消' })).toHaveFocus();

    rerender(
      <FileBrowser
        active={false}
        connection={connection}
        connectionStatus="ready"
        core={core}
        jumpRequest={null}
        onReconnect={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('alertdialog', { name: '删除文件' })).toBeInTheDocument();

    rerender(
      <FileBrowser
        active
        connection={connection}
        connectionStatus="ready"
        core={core}
        jumpRequest={null}
        onReconnect={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog', { name: '删除文件' }))
      .not.toBeInTheDocument();
  });

  it('returns focus to the trigger when a dialog closes', async () => {
    const core = readyCore();
    renderBrowser({ core });
    await screen.findByRole('table', { name: '目录内容' });

    const deleteButton = screen.getByRole('button', { name: '删除 app.conf' });
    deleteButton.focus();
    fireEvent.click(deleteButton);
    const confirm = await screen.findByRole('alertdialog', { name: '删除文件' });
    fireEvent.click(within(confirm).getByRole('button', { name: '取消' }));
    expect(deleteButton).toHaveFocus();
  });

  it('returns focus to the trigger after an autofocused dialog closes', async () => {
    const core = readyCore();
    renderBrowser({ core });
    await screen.findByRole('table', { name: '目录内容' });

    const mkdirButton = screen.getByRole('button', { name: '新建文件夹' });
    mkdirButton.focus();
    fireEvent.click(mkdirButton);
    const dialog = await screen.findByRole('dialog', { name: '新建文件夹' });
    expect(within(dialog).getByLabelText('文件夹名称')).toHaveFocus();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(mkdirButton).toHaveFocus();
  });

  it('creates folders and confirms deletion with cancel focused', async () => {
    const core = readyCore();
    renderBrowser({ core });
    await screen.findByRole('table', { name: '目录内容' });

    fireEvent.click(screen.getByRole('button', { name: '新建文件夹' }));
    const mkdir = await screen.findByRole('dialog', { name: '新建文件夹' });
    fireEvent.change(within(mkdir).getByLabelText('文件夹名称'), {
      target: { value: 'release' },
    });
    fireEvent.click(within(mkdir).getByRole('button', { name: '创建文件夹' }));
    expect(await screen.findByRole('status')).toHaveTextContent('已创建 /release');
    expect(await screen.findByRole('button', { name: '打开目录 release' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '删除 app.conf' }));
    const confirm = await screen.findByRole('alertdialog', { name: '删除文件' });
    expect(within(confirm).getByRole('button', { name: '取消' })).toHaveFocus();
    fireEvent.click(within(confirm).getByRole('button', { name: '确认删除' }));
    expect(await screen.findByRole('status')).toHaveTextContent('已删除 /app.conf');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '打开文件 app.conf' }))
        .not.toBeInTheDocument();
    });
  });

  it('surfaces partial rename and offers an explicit source cleanup confirmation', async () => {
    const core = createFakeCoreClient({
      files: {
        entriesByDirectory: {
          '/': [config],
        },
      },
      fileFaults: { failRenameUnlink: true },
    });
    renderBrowser({ core });
    await screen.findByRole('table', { name: '目录内容' });

    fireEvent.click(screen.getByRole('button', { name: '重命名 app.conf' }));
    const rename = await screen.findByRole('dialog', { name: '重命名 app.conf' });
    fireEvent.change(within(rename).getByLabelText('新名称'), {
      target: { value: 'next.conf' },
    });
    fireEvent.click(within(rename).getByRole('button', { name: '确认重命名' }));

    expect(await within(rename).findByRole('alert')).toHaveTextContent('源文件删除失败');
    expect(within(rename).getByText('/next.conf')).toBeVisible();
    expect(await screen.findByRole('button', { name: '打开文件 next.conf' })).toBeVisible();
    fireEvent.click(within(rename).getByRole('button', { name: '删除源文件…' }));

    const cleanup = await screen.findByRole('alertdialog', { name: '删除文件' });
    expect(within(cleanup).getByText('/app.conf')).toBeVisible();
    expect(within(cleanup).getByText(/本次清理来源/)).toBeVisible();
    expect(within(cleanup).getByRole('button', { name: '取消' })).toHaveFocus();
  });

  it('does not offer source deletion when the rename target is unconfirmed', async () => {
    const core = createFakeCoreClient({
      files: {
        entriesByDirectory: {
          '/': [config],
        },
      },
      overrides: {
        renameFile: async (): Promise<RemoteRenameResult> => ({
          status: 'partial',
          sourcePath: '/app.conf',
          targetPath: '/next.conf',
          targetCreated: false,
          warning: '无法确认目标文件是否已创建；源文件未删除，请刷新目录核对。',
          error: {
            code: 'INTERNAL',
            message: '重命名结果未知',
            retryable: true,
          },
        }),
      },
    });
    renderBrowser({ core });
    await screen.findByRole('table', { name: '目录内容' });

    fireEvent.click(screen.getByRole('button', { name: '重命名 app.conf' }));
    const rename = await screen.findByRole('dialog', { name: '重命名 app.conf' });
    fireEvent.change(within(rename).getByLabelText('新名称'), {
      target: { value: 'next.conf' },
    });
    fireEvent.click(within(rename).getByRole('button', { name: '确认重命名' }));

    expect(await within(rename).findByRole('alert')).toHaveTextContent(
      '无法确认目标文件是否已创建',
    );
    expect(within(rename).getByText('目标状态未确认')).toBeVisible();
    expect(within(rename).queryByRole('button', { name: '删除源文件…' }))
      .not.toBeInTheDocument();
    expect(within(rename).getByRole('button', { name: '刷新目录核对' })).toBeVisible();
    expect(core.calls.some((call) => call.method === 'deleteFile')).toBe(false);

    fireEvent.click(within(rename).getByRole('button', { name: '刷新目录核对' }));
    expect(await screen.findByText(/重命名 \/app\.conf 的结果不确定/)).toBeVisible();
    expect(screen.queryByRole('dialog', { name: '重命名 app.conf' }))
      .not.toBeInTheDocument();
    expect(core.calls.some((call) => call.method === 'deleteFile')).toBe(false);
  });

  it('keeps a partial rename visible after its dialog closes', async () => {
    const core = createFakeCoreClient({
      files: {
        entriesByDirectory: {
          '/': [config],
        },
      },
      fileFaults: { failRenameUnlink: true },
    });
    renderBrowser({ core });
    await screen.findByRole('table', { name: '目录内容' });

    fireEvent.click(screen.getByRole('button', { name: '重命名 app.conf' }));
    const rename = await screen.findByRole('dialog', { name: '重命名 app.conf' });
    fireEvent.change(within(rename).getByLabelText('新名称'), {
      target: { value: 'next.conf' },
    });
    fireEvent.click(within(rename).getByRole('button', { name: '确认重命名' }));
    expect(await within(rename).findByRole('alert')).toHaveTextContent('源文件删除失败');

    fireEvent.click(within(rename).getByRole('button', { name: '关闭对话框' }));
    expect(screen.queryByRole('dialog', { name: '重命名 app.conf' }))
      .not.toBeInTheDocument();
    expect(screen.getByText(/已将 \/app\.conf 重命名为 \/next\.conf，但源文件可能仍然存在/))
      .toBeVisible();
    expect(screen.getByText('/app.conf')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '清理源文件…' }));
    const cleanup = await screen.findByRole('alertdialog', { name: '删除文件' });
    expect(within(cleanup).getByText('/app.conf')).toBeVisible();
    fireEvent.click(within(cleanup).getByRole('button', { name: '确认删除' }));
    await waitFor(() => {
      expect(screen.queryByText(/但源文件可能仍然存在/)).not.toBeInTheDocument();
    });
  });

  it('rejects renaming a file to its current name before calling the core', async () => {
    const core = readyCore();
    renderBrowser({ core });
    await screen.findByRole('table', { name: '目录内容' });

    fireEvent.click(screen.getByRole('button', { name: '重命名 app.conf' }));
    const rename = await screen.findByRole('dialog', { name: '重命名 app.conf' });
    fireEvent.click(within(rename).getByRole('button', { name: '确认重命名' }));

    expect(await within(rename).findByRole('alert')).toHaveTextContent(
      '新名称必须与原名称不同',
    );
    expect(core.calls.some((call) => call.method === 'renameFile')).toBe(false);
  });
});
