import {
  CoreErrorSchema,
  type CoreHealth,
  type Group,
  type GroupInput,
  type Server,
  type ServerCredentialInput,
  type ServerInput,
} from '@opspilot/contracts';
import { create } from 'zustand';

import type { CoreClient } from '../api/core';

export type CoreHealthState =
  | { status: 'loading' }
  | { status: 'ready'; health: CoreHealth }
  | { status: 'unavailable' };

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

export type ServerFormState =
  | { mode: 'create' }
  | { mode: 'edit'; serverId: string };

export interface CatalogSection {
  key: string;
  title: string;
  groupId: string | null;
  isFavorites: boolean;
  servers: Server[];
}

export interface HarborState {
  core: CoreClient | null;
  coreHealth: CoreHealthState;
  catalogStatus: CatalogStatus;
  catalogError: string | null;
  catalogBusy: boolean;
  groups: Group[];
  query: string;
  selectedServerId: string | null;
  servers: Server[];
  serverForm: ServerFormState | null;
  groupManagerOpen: boolean;
  commandPaletteOpen: boolean;
  configureCore: (core: CoreClient) => void;
  loadCatalog: () => Promise<void>;
  reset: () => void;
  setCoreHealth: (health: CoreHealthState) => void;
  setQuery: (query: string) => void;
  selectServer: (serverId: string | null) => void;
  markServerConnected: (serverId: string, connectedAt?: number) => void;
  toggleFavorite: (serverId: string) => Promise<void>;
  saveServer: (
    id: string | null | undefined,
    input: ServerInput,
    credential?: ServerCredentialInput,
  ) => Promise<Server | null>;
  deleteServer: (serverId: string) => Promise<boolean>;
  saveGroup: (id: string | null | undefined, input: GroupInput) => Promise<Group | null>;
  deleteGroup: (groupId: string) => Promise<boolean>;
  openServerForm: (mode: 'create' | 'edit', serverId?: string) => void;
  openAddServer: () => void;
  openEditServer: (serverId: string) => void;
  closeServerForm: () => void;
  openGroupManager: () => void;
  closeGroupManager: () => void;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
}

let catalogRequestSequence = 0;

export const useHarborStore = create<HarborState>((set, get) => ({
  ...initialState(),
  configureCore: (core) => set({ core }),
  loadCatalog: async () => {
    const core = get().core;
    if (!core) {
      set({
        catalogStatus: 'error',
        catalogError: 'Core 尚未连接，无法读取服务器目录',
      });
      return;
    }

    const request = ++catalogRequestSequence;
    set({ catalogStatus: 'loading', catalogError: null });
    try {
      const [groups, servers] = await Promise.all([
        core.listGroups(),
        core.listServers(),
      ]);
      if (request !== catalogRequestSequence) return;

      const selectedServerId = get().selectedServerId;
      set({
        groups: sortGroups(groups),
        servers: sortServers(servers),
        catalogStatus: 'ready',
        catalogError: null,
        selectedServerId: servers.some((server) => server.id === selectedServerId)
          ? selectedServerId
          : null,
      });
    } catch (error) {
      if (request !== catalogRequestSequence) return;
      set({
        catalogStatus: 'error',
        catalogError: catalogErrorMessage(error),
      });
    }
  },
  reset: () => {
    catalogRequestSequence += 1;
    set(initialState());
  },
  setCoreHealth: (coreHealth) => set({ coreHealth }),
  setQuery: (query) => set({ query }),
  selectServer: (serverId) => {
    if (
      serverId !== null
      && !get().servers.some((server) => server.id === serverId)
    ) {
      return;
    }
    set({ selectedServerId: serverId });
  },
  markServerConnected: (serverId, connectedAt = Math.floor(Date.now() / 1_000)) => {
    set((state) => ({
      servers: sortServers(state.servers.map((server) => (
        server.id === serverId
          ? { ...server, lastConnectedAt: connectedAt }
          : server
      ))),
    }));
  },
  toggleFavorite: async (serverId) => {
    const state = get();
    const core = state.core;
    const server = state.servers.find((candidate) => candidate.id === serverId);
    if (!core || !server) return;

    const favorite = !server.favorite;
    set({
      catalogBusy: true,
      catalogError: null,
      servers: replaceServer(state.servers, { ...server, favorite }),
    });
    try {
      const updated = await core.updateServer(serverId, serverInput(server, favorite));
      set((current) => ({
        catalogBusy: false,
        servers: sortServers(replaceServer(current.servers, updated)),
      }));
    } catch (error) {
      set((current) => ({
        catalogBusy: false,
        catalogError: catalogErrorMessage(error),
        servers: replaceServer(current.servers, server),
      }));
    }
  },
  saveServer: async (id, input, credential) => {
    const core = get().core;
    if (!core) {
      set({ catalogError: 'Core 尚未连接，无法保存服务器' });
      return null;
    }
    if (!id && !credential) {
      set({ catalogError: '密码或私钥不能为空' });
      return null;
    }

    set({ catalogBusy: true, catalogError: null });
    try {
      const saved = id
        ? await core.updateServer(id, input, credential)
        : await core.createServer(input, credential as ServerCredentialInput);
      set((current) => ({
        catalogBusy: false,
        catalogError: null,
        selectedServerId: saved.id,
        serverForm: null,
        servers: sortServers(
          current.servers.some((server) => server.id === saved.id)
            ? replaceServer(current.servers, saved)
            : [...current.servers, saved],
        ),
      }));
      return saved;
    } catch (error) {
      set({
        catalogBusy: false,
        catalogError: catalogErrorMessage(error),
      });
      return null;
    }
  },
  deleteServer: async (serverId) => {
    const core = get().core;
    if (!core) {
      set({ catalogError: 'Core 尚未连接，无法删除服务器' });
      return false;
    }

    set({ catalogBusy: true, catalogError: null });
    try {
      await core.deleteServer(serverId);
      set((current) => ({
        catalogBusy: false,
        selectedServerId: current.selectedServerId === serverId
          ? null
          : current.selectedServerId,
        serverForm: current.serverForm?.mode === 'edit'
          && current.serverForm.serverId === serverId
          ? null
          : current.serverForm,
        servers: current.servers.filter((server) => server.id !== serverId),
      }));
      return true;
    } catch (error) {
      set({
        catalogBusy: false,
        catalogError: catalogErrorMessage(error),
      });
      return false;
    }
  },
  saveGroup: async (id, input) => {
    const core = get().core;
    if (!core) {
      set({ catalogError: 'Core 尚未连接，无法保存分组' });
      return null;
    }

    set({ catalogBusy: true, catalogError: null });
    try {
      const saved = id
        ? await core.updateGroup(id, input)
        : await core.createGroup(input);
      set((current) => ({
        catalogBusy: false,
        catalogError: null,
        groups: sortGroups(
          current.groups.some((group) => group.id === saved.id)
            ? current.groups.map((group) => group.id === saved.id ? saved : group)
            : [...current.groups, saved],
        ),
      }));
      return saved;
    } catch (error) {
      set({
        catalogBusy: false,
        catalogError: catalogErrorMessage(error),
      });
      return null;
    }
  },
  deleteGroup: async (groupId) => {
    const core = get().core;
    if (!core) {
      set({ catalogError: 'Core 尚未连接，无法删除分组' });
      return false;
    }

    set({ catalogBusy: true, catalogError: null });
    try {
      await core.deleteGroup(groupId);
      set((current) => ({
        catalogBusy: false,
        groups: current.groups.filter((group) => group.id !== groupId),
        servers: current.servers.map((server) => (
          server.groupId === groupId ? { ...server, groupId: null } : server
        )),
      }));
      return true;
    } catch (error) {
      set({
        catalogBusy: false,
        catalogError: catalogErrorMessage(error),
      });
      return false;
    }
  },
  openServerForm: (mode, serverId) => {
    if (mode === 'edit' && !serverId) return;
    set({
      catalogError: null,
      commandPaletteOpen: false,
      serverForm: mode === 'edit'
        ? { mode, serverId: serverId as string }
        : { mode: 'create' },
    });
  },
  openAddServer: () => {
    set({
      catalogError: null,
      commandPaletteOpen: false,
      serverForm: { mode: 'create' },
    });
  },
  openEditServer: (serverId) => {
    set({
      catalogError: null,
      commandPaletteOpen: false,
      serverForm: { mode: 'edit', serverId },
    });
  },
  closeServerForm: () => set({ serverForm: null }),
  openGroupManager: () => set({ catalogError: null, groupManagerOpen: true }),
  closeGroupManager: () => set({ groupManagerOpen: false }),
  openCommandPalette: () => set({ commandPaletteOpen: true }),
  closeCommandPalette: () => set({ commandPaletteOpen: false }),
  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
}));

export function filterServers(servers: Server[], query: string): Server[] {
  const needle = query.trim().toLocaleLowerCase('zh-CN');
  const matching = needle.length === 0
    ? servers
    : servers.filter((server) => (
        [server.name, server.host, server.user].some((value) => (
          value.toLocaleLowerCase('zh-CN').includes(needle)
        ))
      ));

  return sortServers(matching);
}

export function buildCatalogSections(
  servers: Server[],
  groups: Group[],
  query: string,
): CatalogSection[] {
  const filtered = filterServers(servers, query);
  const favorites = filtered.filter((server) => server.favorite);
  const rest = filtered.filter((server) => !server.favorite);
  const orderedGroups = sortGroups(groups);
  const knownGroupIds = new Set(orderedGroups.map((group) => group.id));
  const sections: CatalogSection[] = [];
  if (favorites.length > 0) {
    sections.push({
      key: 'favorites',
      title: '收藏',
      groupId: null,
      isFavorites: true,
      servers: favorites,
    });
  }
  for (const group of orderedGroups) {
    const members = rest.filter((server) => server.groupId === group.id);
    if (members.length > 0) {
      sections.push({
        key: `group:${group.id}`,
        title: group.name,
        groupId: group.id,
        isFavorites: false,
        servers: members,
      });
    }
  }
  const ungrouped = rest.filter((server) => (
    server.groupId === null
    || server.groupId === undefined
    || !knownGroupIds.has(server.groupId)
  ));
  if (ungrouped.length > 0) {
    sections.push({
      key: 'ungrouped',
      title: '未分组',
      groupId: null,
      isFavorites: false,
      servers: ungrouped,
    });
  }

  return sections;
}

export function formatLastConnectedAt(
  lastConnectedAt: number | null | undefined,
  now = Math.floor(Date.now() / 1_000),
): string {
  if (lastConnectedAt === null || lastConnectedAt === undefined) {
    return '从未连接';
  }

  const elapsed = Math.max(0, now - lastConnectedAt);
  if (elapsed < 60) return '刚刚连接过';
  if (elapsed < 3_600) return `${Math.floor(elapsed / 60)} 分钟前连接过`;
  if (elapsed < 86_400) return `${Math.floor(elapsed / 3_600)} 小时前连接过`;
  return `${Math.floor(elapsed / 86_400)} 天前连接过`;
}

export function catalogErrorMessage(error: unknown): string {
  const coreError = CoreErrorSchema.safeParse(error);
  if (coreError.success) return coreError.data.message;
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return '操作失败，请重试';
}

function serverInput(server: Server, favorite: boolean): ServerInput {
  return {
    name: server.name,
    host: server.host,
    port: server.port,
    user: server.user,
    authType: server.authType,
    groupId: server.groupId ?? null,
    favorite,
  };
}

function replaceServer(servers: Server[], replacement: Server): Server[] {
  return servers.map((server) => (
    server.id === replacement.id ? replacement : server
  ));
}

function sortServers(servers: Server[]): Server[] {
  return [...servers].sort((left, right) => {
    if (left.favorite !== right.favorite) return left.favorite ? -1 : 1;
    const connectionOrder = (right.lastConnectedAt ?? 0) - (left.lastConnectedAt ?? 0);
    if (connectionOrder !== 0) return connectionOrder;
    const createdOrder = right.createdAt - left.createdAt;
    if (createdOrder !== 0) return createdOrder;
    return left.name.localeCompare(right.name, 'zh-CN');
  });
}

function sortGroups(groups: Group[]): Group[] {
  return [...groups].sort((left, right) => (
    left.sortOrder - right.sortOrder
    || left.name.localeCompare(right.name, 'zh-CN')
  ));
}

function initialState() {
  return {
    core: null as CoreClient | null,
    coreHealth: { status: 'loading' } satisfies CoreHealthState,
    catalogStatus: 'idle' as CatalogStatus,
    catalogError: null as string | null,
    catalogBusy: false,
    groups: [] as Group[],
    query: '',
    selectedServerId: null as string | null,
    servers: [] as Server[],
    serverForm: null as ServerFormState | null,
    groupManagerOpen: false,
    commandPaletteOpen: false,
  };
}
