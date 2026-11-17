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

beforeEach(() => {
  invokeMock.mockReset();
});

describe('Tauri CoreClient catalog contract', () => {
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
      .mockResolvedValueOnce(server)
      .mockResolvedValueOnce(server)
      .mockResolvedValueOnce(undefined)
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
});
