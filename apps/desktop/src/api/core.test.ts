import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTauriCoreClient } from './core';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const server = {
  id: '019c62b2-2970-7000-8000-000000000003',
  name: 'prod-web-01',
  host: 'prod.example.com',
  port: 22,
  user: 'deploy',
  authType: 'key',
  secretRef: 'secret-ref-fixture',
  groupId: null,
  favorite: false,
  lastConnectedAt: null,
  createdAt: 1_700_000_000,
} as const;
const group = {
  id: '019c62b2-2970-7000-8000-000000000004',
  name: '生产',
  sortOrder: 1,
} as const;
const importPreview = {
  previewId: '019c62b2-2970-7000-8000-000000000010',
  sourcePath: '~/.ssh/config',
  items: [{
    id: '019c62b2-2970-7000-8000-000000000011',
    alias: 'imported',
    host: 'imported.example.com',
    port: 22,
    username: 'deploy',
    identityFile: null,
    status: 'ready',
    unsupportedDirectives: [],
    warnings: [],
  }],
  warnings: [],
  warningCount: 0,
  existingCount: 0,
  importableCount: 1,
} as const;
const connection = {
  serverId: '019c62b2-2970-7000-8000-000000000003',
  connectionId: '019c62b2-2970-7000-8000-000000000010',
} as const;
const fileHash = '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03';
const fileEntry = {
  name: 'app.conf',
  path: '/srv/app/app.conf',
  kind: 'file',
  size: 6,
  modifiedAt: 42,
  permissions: 0o640,
} as const;
const monitorSnapshot = {
  timestamp: '2026-11-17T12:34:56.789Z',
  cpuPercent: 42.5,
  memory: {
    totalBytes: 8_000,
    availableBytes: 3_000,
    usedBytes: 5_000,
  },
  disk: {
    filesystem: '/dev/vda1',
    totalBytes: 100_000,
    usedBytes: 40_000,
    availableBytes: 60_000,
    mountPoint: '/',
  },
  load: {
    one: 0.25,
    five: 0.5,
    fifteen: 0.75,
  },
  uptimeSeconds: 123_456,
  topProcesses: [{
    pid: 42,
    user: 'deploy',
    name: 'nginx worker',
    cpuPercent: 125.5,
    memoryPercent: 3.25,
  }],
  unavailable: ['processes_partial'],
} as const;

beforeEach(() => {
  invokeMock.mockReset();
});

describe('Tauri CoreClient catalog contract', () => {
  it('reads the native clipboard through the typed command', async () => {
    const client = createTauriCoreClient();
    invokeMock
      .mockResolvedValueOnce('echo harbor')
      .mockResolvedValueOnce(42);

    await expect(client.readClipboardText()).resolves.toBe('echo harbor');
    await expect(client.readClipboardText()).rejects.toThrow();

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'clipboard_read_text');
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'clipboard_read_text');
  });

  it('parses server and group responses from their command boundaries', async () => {
    const client = createTauriCoreClient();
    invokeMock
      .mockResolvedValueOnce([server])
      .mockResolvedValueOnce([group]);

    await expect(client.listServers()).resolves.toEqual([server]);
    await expect(client.listGroups()).resolves.toEqual([group]);

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'server_list');
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'server_group_list');
  });

  it('normalizes write inputs before invoking create commands', async () => {
    const client = createTauriCoreClient();
    invokeMock
      .mockResolvedValueOnce(server)
      .mockResolvedValueOnce(group);

    await client.createServer({
      name: '  prod-web-01 ',
      host: ' prod.example.com ',
      port: 22,
      user: ' deploy ',
      authType: 'key',
      groupId: null,
      favorite: false,
    }, {
      credential: 'credential-fixture',
    });
    await client.createGroup({
      name: ' 生产 ',
      sortOrder: 1,
    });

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'server_create', {
      input: {
        name: 'prod-web-01',
        host: 'prod.example.com',
        port: 22,
        user: 'deploy',
        authType: 'key',
        groupId: null,
        favorite: false,
      },
      credential: {
        credential: 'credential-fixture',
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'server_group_create', {
      input: {
        name: '生产',
        sortOrder: 1,
      },
    });
  });

  it('uses the server command names and nullable credential semantics', async () => {
    const client = createTauriCoreClient();
    invokeMock
      .mockResolvedValueOnce({ server, warning: null })
      .mockResolvedValueOnce({ server, warning: null })
      .mockResolvedValueOnce({ warning: null })
      .mockResolvedValueOnce(group)
      .mockResolvedValueOnce(undefined);
    const input = {
      name: 'prod-web-01',
      host: 'prod.example.com',
      port: 22,
      user: 'deploy',
      authType: 'key' as const,
      groupId: null,
      favorite: true,
    };

    await client.updateServer(server.id, input);
    await client.setServerCredential(server.id, { credential: 'credential-fixture' });
    await client.deleteServer(server.id);
    await client.updateGroup(group.id, { name: '生产', sortOrder: 2 });
    await client.deleteGroup(group.id);

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'server_update', {
      id: server.id,
      input,
      credential: null,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'server_credential_set', {
      id: server.id,
      input: { credential: 'credential-fixture' },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'server_delete', { id: server.id });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'server_group_update', {
      id: group.id,
      input: { name: '生产', sortOrder: 2 },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(5, 'server_group_delete', {
      id: group.id,
    });
  });

  it('fails closed when Rust returns a shape outside the shared contract', async () => {
    const client = createTauriCoreClient();
    invokeMock.mockResolvedValueOnce({
      ...server,
      favorite: 'yes',
    });

    await expect(client.listServers()).rejects.toThrow();
  });

  it('uses server-side preview ids for SSH Config import and parses the result', async () => {
    const client = createTauriCoreClient();
    const imported = { ...server, secretRef: null };
    invokeMock
      .mockResolvedValueOnce(importPreview)
      .mockResolvedValueOnce({
        importedCount: 1,
        skippedCount: 0,
        servers: [imported],
      });

    await expect(client.previewSshConfigImport()).resolves.toEqual(importPreview);
    await expect(client.applySshConfigImport({
      previewId: importPreview.previewId,
      selectedRowIds: [importPreview.items[0].id],
    })).resolves.toEqual({
      importedCount: 1,
      skippedCount: 0,
      servers: [imported],
    });

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'ssh_config_import_preview');
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'ssh_config_import_apply', {
      input: {
        previewId: importPreview.previewId,
        selectedRowIds: [importPreview.items[0].id],
      },
    });
  });

  it('samples monitoring through the active connection and rejects drifted snapshots', async () => {
    const client = createTauriCoreClient();
    const connection = {
      serverId: '019c62b2-2970-7000-8000-000000000003',
      connectionId: '019c62b2-2970-7000-8000-000000000020',
    };
    invokeMock
      .mockResolvedValueOnce(monitorSnapshot)
      .mockResolvedValueOnce({
        ...monitorSnapshot,
        unavailable: ['cpu_from_the_future'],
      });

    await expect(client.monitorSnapshot(connection)).resolves.toEqual(monitorSnapshot);
    await expect(client.monitorSnapshot(connection)).rejects.toThrow();

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'monitor_snapshot', { connection });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'monitor_snapshot', { connection });
  });
});

describe('Tauri CoreClient file contract', () => {
  it('invokes validated directory and file commands with camelCase arguments', async () => {
    const client = createTauriCoreClient();
    const document = {
      path: fileEntry.path,
      text: 'hello\n',
      sha256: fileHash,
      size: 6,
      modifiedAt: 42,
    };
    invokeMock
      .mockResolvedValueOnce([fileEntry])
      .mockResolvedValueOnce(document)
      .mockResolvedValueOnce({
        path: fileEntry.path,
        sha256: fileHash,
        size: 6,
        modifiedAt: 43,
      })
      .mockResolvedValueOnce({
        path: '/srv/app/bundle.tar',
        bytes: [1, 2, 255],
        sha256: fileHash,
      });

    await expect(client.listFiles(connection, '//srv/./app/')).resolves.toEqual([fileEntry]);
    await expect(client.readFile(connection, '/srv/app/app.conf')).resolves.toEqual(document);
    await expect(client.writeFile(
      connection,
      '/srv/app/app.conf',
      'hello\n',
      fileHash,
    )).resolves.toEqual({
      path: fileEntry.path,
      sha256: fileHash,
      size: 6,
      modifiedAt: 43,
    });
    await expect(client.downloadFile(connection, '/srv/app/bundle.tar')).resolves.toEqual({
      path: '/srv/app/bundle.tar',
      bytes: [1, 2, 255],
      sha256: fileHash,
    });

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'file_list', {
      connection,
      path: '/srv/app',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'file_read', {
      connection,
      path: '/srv/app/app.conf',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'file_write', {
      connection,
      path: '/srv/app/app.conf',
      content: 'hello\n',
      expectedSha256: fileHash,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'file_download', {
      connection,
      path: '/srv/app/bundle.tar',
    });
  });

  it('rejects unsafe paths, missing hashes, and malformed responses before use', async () => {
    const client = createTauriCoreClient();

    await expect(client.listFiles(connection, '/srv/../etc')).rejects.toThrow();
    await expect(client.readFile(connection, '/')).rejects.toThrow();
    await expect(client.writeFile(
      connection,
      '/srv/app/app.conf',
      'hello',
      'not-a-hash',
    )).rejects.toThrow();
    expect(invokeMock).not.toHaveBeenCalled();

    invokeMock.mockResolvedValueOnce([{
      ...fileEntry,
      permissions: 0o100_640,
    }]);
    await expect(client.listFiles(connection, '/srv/app')).rejects.toThrow();
  });

  it('invokes upload, mkdir, rename, and delete with validated mutation arguments', async () => {
    const client = createTauriCoreClient();
    const uploadOutcome = {
      status: 'failed_with_residue',
      committed: ['/srv/app/one.txt'],
      residual: ['/srv/app/one.txt'],
      warning: '回滚未完全完成',
      error: {
        code: 'CONFLICT',
        message: '目标文件已存在',
        retryable: false,
      },
    } as const;
    const mutation = {
      path: '/srv/app/new-folder',
      warning: '会话清理失败',
    } as const;
    const rename = {
      status: 'partial',
      sourcePath: '/srv/app/old.txt',
      targetPath: '/srv/app/new.txt',
      targetCreated: true,
      warning: '源文件未删除',
      error: {
        code: 'INTERNAL',
        message: '源文件删除失败',
        retryable: true,
      },
    } as const;
    invokeMock
      .mockResolvedValueOnce(uploadOutcome)
      .mockResolvedValueOnce(mutation)
      .mockResolvedValueOnce(rename)
      .mockResolvedValueOnce({ path: '/srv/app/old.txt' });

    await expect(client.uploadFiles(
      connection,
      '//srv/./app/',
      [{ name: 'one.txt', bytes: [1, 2, 3] }],
    )).resolves.toEqual(uploadOutcome);
    await expect(client.createDirectory(
      connection,
      '//srv/./app/new-folder',
    )).resolves.toEqual(mutation);
    await expect(client.renameFile(
      connection,
      '//srv/./app/old.txt',
      '/srv/app/new.txt',
    )).resolves.toEqual(rename);
    await expect(client.deleteFile(
      connection,
      '/srv/app/old.txt',
    )).resolves.toEqual({ path: '/srv/app/old.txt' });

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'file_upload', {
      connection,
      directory: '/srv/app',
      files: [{ name: 'one.txt', bytes: [1, 2, 3] }],
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'file_mkdir', {
      connection,
      path: '/srv/app/new-folder',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'file_rename', {
      connection,
      sourcePath: '/srv/app/old.txt',
      targetPath: '/srv/app/new.txt',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'file_delete', {
      connection,
      path: '/srv/app/old.txt',
    });
  });

  it('fails closed before invoke for unsafe or inconsistent mutations', async () => {
    const client = createTauriCoreClient();

    await expect(client.uploadFiles(connection, '/srv/app', [
      { name: '../escape', bytes: [1] },
    ])).rejects.toThrow();
    await expect(client.createDirectory(connection, '/')).rejects.toThrow();
    await expect(client.renameFile(
      connection,
      '/srv/app/one.txt',
      '/srv/other/two.txt',
    )).rejects.toThrow();
    await expect(client.deleteFile(connection, '/srv/../etc/passwd')).rejects.toThrow();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe('Tauri CoreClient Docker contract', () => {
  const connection = {
    serverId: '019c62b2-2970-7000-8000-000000000003',
    connectionId: '019c62b2-2970-7000-8000-000000000010',
  };
  const containerId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const terminalSessionId = '019c62b2-2970-7000-8000-000000000011';
  const list = {
    containers: [{
      id: containerId,
      names: ['web'],
      image: 'nginx:alpine',
      state: 'running',
      status: 'Up 3 hours',
      ports: ['8080->80/tcp'],
      startedAt: '2026-11-17T12:00:00Z',
    }],
    startedAtWarning: null,
  };
  const logs = {
    containerId,
    tail: 500,
    stdout: 'request\n',
    stderr: 'warning\n',
  };

  it('invokes list, logs, action, and exec with camelCase parameters', async () => {
    const client = createTauriCoreClient();
    invokeMock
      .mockResolvedValueOnce(list)
      .mockResolvedValueOnce(logs)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: terminalSessionId, connection });

    await expect(client.listDockerContainers(connection)).resolves.toEqual(list);
    await expect(client.getDockerLogs(connection, containerId, 500)).resolves.toEqual(logs);
    await expect(client.runDockerAction(connection, containerId, 'restart')).resolves.toBeUndefined();
    await expect(client.execDockerContainer(
      connection,
      containerId,
      'bash',
      120,
      40,
    )).resolves.toEqual({ id: terminalSessionId, connection });

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'docker_list', { connection });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'docker_logs', {
      connection,
      containerId,
      tail: 500,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'docker_action', {
      connection,
      containerId,
      action: 'restart',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'docker_exec', {
      connection,
      containerId,
      shell: 'bash',
      columns: 120,
      rows: 40,
    });
  });

  it('fails closed before invoke for removed actions and non-whitelisted shells', async () => {
    const client = createTauriCoreClient();

    await expect(client.runDockerAction(
      connection,
      containerId,
      'rm' as 'restart',
    )).rejects.toThrow();
    await expect(client.execDockerContainer(
      connection,
      containerId,
      'zsh; id' as 'sh',
      80,
      24,
    )).rejects.toThrow();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
