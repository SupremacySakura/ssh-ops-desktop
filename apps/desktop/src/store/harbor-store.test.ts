import {
  type Server,
  type ServerInput,
  type SshConfigImportPreview,
} from '@opspilot/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeCoreClient } from '../test/fake-core';
import {
  buildCatalogSections,
  filterServers,
  formatLastConnectedAt,
  useHarborStore,
} from './harbor-store';

const group = {
  id: '019c62b2-2970-7000-8000-000000000004',
  name: '生产',
  sortOrder: 10,
};
const laterGroup = {
  id: '019c62b2-2970-7000-8000-000000000005',
  name: '测试',
  sortOrder: 20,
};
const baseServer: Server = {
  id: '019c62b2-2970-7000-8000-000000000003',
  name: 'prod-web-01',
  host: 'prod.example.com',
  port: 22,
  user: 'deploy',
  authType: 'key',
  secretRef: 'secret-ref-fixture',
  groupId: group.id,
  favorite: false,
  lastConnectedAt: 1_700_000_000,
  createdAt: 1_699_000_000,
};
const importPreview: SshConfigImportPreview = {
  previewId: '019c62b2-2970-7000-8000-000000000010',
  sourcePath: '~/.ssh/config',
  items: [{
    id: '019c62b2-2970-7000-8000-000000000011',
    alias: 'imported-prod',
    host: 'imported.example.com',
    port: 2222,
    username: 'deploy',
    identityFile: '~/.ssh/id_ed25519',
    status: 'ready',
    unsupportedDirectives: [],
    warnings: [],
  }, {
    id: '019c62b2-2970-7000-8000-000000000012',
    alias: 'existing',
    host: baseServer.host,
    port: baseServer.port,
    username: baseServer.user,
    identityFile: null,
    status: 'existing',
    unsupportedDirectives: [],
    warnings: [],
  }, {
    id: '019c62b2-2970-7000-8000-000000000013',
    alias: 'proxied',
    host: 'proxied.example.com',
    port: 22,
    username: 'deploy',
    identityFile: null,
    status: 'unsupported',
    unsupportedDirectives: ['ProxyJump'],
    warnings: ['第 8 行：ProxyJump 暂不支持；该 Host 已停用，避免按错误路径直连。'],
  }],
  warnings: [],
  warningCount: 1,
  existingCount: 1,
  importableCount: 1,
};

beforeEach(() => {
  useHarborStore.getState().reset();
});

describe('Harbor catalog store', () => {
  it('loads servers and groups through the injected CoreClient', async () => {
    const core = createFakeCoreClient({
      servers: [baseServer],
      groups: [laterGroup, group],
    });
    const store = useHarborStore.getState();
    store.configureCore(core);

    await store.loadCatalog();

    const state = useHarborStore.getState();
    expect(state.catalogStatus).toBe('ready');
    expect(state.catalogError).toBeNull();
    expect(state.servers).toEqual([baseServer]);
    expect(state.groups).toEqual([group, laterGroup]);
  });

  it('surfaces a Core catalog failure without discarding the shell state', async () => {
    const core = createFakeCoreClient({
      overrides: {
        listServers: vi.fn().mockRejectedValue({
          code: 'INTERNAL',
          message: '数据库暂时不可用',
          retryable: true,
        }),
      },
    });
    const store = useHarborStore.getState();
    store.configureCore(core);

    await store.loadCatalog();

    expect(useHarborStore.getState().catalogStatus).toBe('error');
    expect(useHarborStore.getState().catalogError).toBe('数据库暂时不可用');
  });

  it('filters by name, host, or user and keeps favorites in one pinned section', () => {
    const favorite = {
      ...baseServer,
      id: '019c62b2-2970-7000-8000-000000000006',
      name: 'pinned-db',
      favorite: true,
    };
    const other = {
      ...baseServer,
      id: '019c62b2-2970-7000-8000-000000000007',
      name: 'staging-web',
      host: 'staging.example.com',
      groupId: laterGroup.id,
      lastConnectedAt: 1_700_000_300,
    };
    const ungrouped = {
      ...baseServer,
      id: '019c62b2-2970-7000-8000-000000000008',
      name: 'dev-box',
      host: 'dev.example.com',
      user: 'shi',
      groupId: null,
      lastConnectedAt: null,
    };
    const servers = [favorite, baseServer, ungrouped, other];

    const sections = buildCatalogSections(
      servers,
      [laterGroup, group],
      'staging',
    );

    expect(sections).toEqual([
      {
        key: `group:${laterGroup.id}`,
        title: '测试',
        groupId: laterGroup.id,
        isFavorites: false,
        servers: [other],
      },
    ]);
    expect(filterServers(servers, 'deploy').map((server) => server.id)).toEqual([
      favorite.id,
      other.id,
      baseServer.id,
    ]);
    expect(filterServers(servers, 'shi')).toEqual([ungrouped]);
    expect(buildCatalogSections(servers, [laterGroup, group], '').map((section) => section.key))
      .toEqual([
        'favorites',
        `group:${group.id}`,
        `group:${laterGroup.id}`,
        'ungrouped',
      ]);
  });

  it('toggles favorite through updateServer without re-sending a credential', async () => {
    const core = createFakeCoreClient({
      servers: [baseServer],
      groups: [group],
    });
    const store = useHarborStore.getState();
    store.configureCore(core);
    await store.loadCatalog();

    await store.toggleFavorite(baseServer.id);

    expect(core.calls).toContainEqual({
      method: 'updateServer',
      args: [
        baseServer.id,
        {
          name: baseServer.name,
          host: baseServer.host,
          port: baseServer.port,
          user: baseServer.user,
          authType: baseServer.authType,
          groupId: baseServer.groupId,
          favorite: true,
        },
        undefined,
      ],
    });
    expect(useHarborStore.getState().servers[0]?.favorite).toBe(true);
  });

  it('saves a server without keeping its credential in state', async () => {
    const credential = 'credential-fixture-value';
    const core = createFakeCoreClient({ groups: [group] });
    const store = useHarborStore.getState();
    store.configureCore(core);
    await store.loadCatalog();
    store.openServerForm('create');
    const input: ServerInput = {
      name: 'new-server',
      host: 'new.example.com',
      port: 2222,
      user: 'ops',
      authType: 'password',
      groupId: group.id,
      favorite: false,
    };

    const created = await store.saveServer(null, input, { credential });

    const state = useHarborStore.getState();
    expect(created).not.toBeNull();
    expect(state.selectedServerId).toBe(created?.id);
    expect(state.serverForm).toBeNull();
    expect(state.servers).toHaveLength(1);
    expect(JSON.stringify({ ...state, core: null })).not.toContain(credential);
  });

  it('keeps the form open and exposes a Chinese error when saving fails', async () => {
    const core = createFakeCoreClient({
      groups: [],
      overrides: {
        createServer: vi.fn().mockRejectedValue({
          code: 'CONFLICT',
          message: '主机、端口和用户名相同的服务器已存在',
          retryable: false,
        }),
      },
    });
    const store = useHarborStore.getState();
    store.configureCore(core);
    await store.loadCatalog();
    store.openServerForm('create');

    const created = await store.saveServer(null, {
      name: 'duplicate',
      host: 'prod.example.com',
      port: 22,
      user: 'deploy',
      authType: 'key',
      groupId: null,
      favorite: false,
    }, {
      credential: 'credential-fixture',
    });

    const state = useHarborStore.getState();
    expect(created).toBeNull();
    expect(state.serverForm).toEqual({ mode: 'create' });
    expect(state.catalogError).toBe('主机、端口和用户名相同的服务器已存在');
  });

  it('saves and deletes groups while ungrouping their servers locally', async () => {
    const core = createFakeCoreClient({
      servers: [baseServer],
      groups: [group],
    });
    const store = useHarborStore.getState();
    store.configureCore(core);
    await store.loadCatalog();

    const renamed = await store.saveGroup(group.id, {
      name: '核心生产',
      sortOrder: 5,
    });
    expect(renamed).toEqual({ ...group, name: '核心生产', sortOrder: 5 });
    expect(useHarborStore.getState().groups).toEqual([renamed]);

    await expect(store.deleteGroup(group.id)).resolves.toBe(true);
    expect(useHarborStore.getState().groups).toEqual([]);
    expect(useHarborStore.getState().servers[0]?.groupId).toBeNull();
  });

  it('deletes a server and clears its workspace selection', async () => {
    const core = createFakeCoreClient({
      servers: [baseServer],
      groups: [group],
    });
    const store = useHarborStore.getState();
    store.configureCore(core);
    await store.loadCatalog();
    store.selectServer(baseServer.id);

    await expect(store.deleteServer(baseServer.id)).resolves.toBe(true);

    expect(useHarborStore.getState().servers).toEqual([]);
    expect(useHarborStore.getState().selectedServerId).toBeNull();
  });

  it('formats the last connection fact from an absolute timestamp', () => {
    expect(formatLastConnectedAt(null, 1_700_000_000)).toBe('从未连接');
    expect(formatLastConnectedAt(1_700_000_000, 1_700_000_030)).toBe('刚刚连接过');
    expect(formatLastConnectedAt(1_700_000_000, 1_700_000_300)).toBe('5 分钟前连接过');
    expect(formatLastConnectedAt(1_700_000_000, 1_700_007_200)).toBe('2 小时前连接过');
  });

  it('loads and applies only selected SSH Config preview rows', async () => {
    const core = createFakeCoreClient({
      servers: [baseServer],
      groups: [group],
      sshConfigImport: importPreview,
    });
    const store = useHarborStore.getState();
    store.configureCore(core);
    await store.loadCatalog();

    await store.openSshConfigImport();

    let state = useHarborStore.getState();
    expect(state.sshConfigImportOpen).toBe(true);
    expect(state.sshConfigImportStatus).toBe('ready');
    expect(state.sshConfigImportPreview).toEqual(importPreview);
    expect(state.sshConfigImportError).toBeNull();

    const result = await store.applySshConfigImport([
      importPreview.items[0].id,
    ]);

    state = useHarborStore.getState();
    expect(result).toEqual({
      importedCount: 1,
      skippedCount: 0,
      servers: [expect.objectContaining({
        name: 'imported-prod',
        secretRef: null,
      })],
    });
    expect(state.sshConfigImportStatus).toBe('complete');
    expect(state.sshConfigImportResult?.importedCount).toBe(1);
    expect(state.servers).toHaveLength(2);
    expect(state.servers.find((server) => server.name === 'imported-prod')?.secretRef)
      .toBeNull();
    expect(core.calls).toContainEqual({
      method: 'applySshConfigImport',
      args: [{
        previewId: importPreview.previewId,
        selectedRowIds: [importPreview.items[0].id],
      }],
    });
  });

  it('surfaces a missing SSH Config error without closing the import dialog', async () => {
    const core = createFakeCoreClient({
      overrides: {
        previewSshConfigImport: vi.fn().mockRejectedValue({
          code: 'NOT_FOUND',
          message: '未找到 SSH Config 文件，请确认 ~/.ssh/config 存在',
          retryable: false,
        }),
      },
    });
    const store = useHarborStore.getState();
    store.configureCore(core);

    await store.openSshConfigImport();

    const state = useHarborStore.getState();
    expect(state.sshConfigImportOpen).toBe(true);
    expect(state.sshConfigImportStatus).toBe('error');
    expect(state.sshConfigImportError).toContain('~/.ssh/config');
  });
});
