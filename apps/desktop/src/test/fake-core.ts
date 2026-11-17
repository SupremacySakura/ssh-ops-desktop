import type {
  CoreHealth,
  Group,
  Server,
  ServerCredentialInput,
} from '@opspilot/contracts';

import type { CoreClient } from '../api/core';

export interface CoreCall {
  method: keyof CoreClient;
  args: unknown[];
}

export interface FakeCoreClient extends CoreClient {
  readonly calls: CoreCall[];
}

export interface FakeCoreOptions {
  servers?: Server[];
  groups?: Group[];
  health?: CoreHealth;
  overrides?: Partial<CoreClient>;
}

const readyHealth: CoreHealth = {
  version: 'renderer-fixture',
  databaseReady: true,
  secretStoreReady: true,
};

export function createFakeCoreClient({
  servers: initialServers = [],
  groups: initialGroups = [],
  health = readyHealth,
  overrides = {},
}: FakeCoreOptions = {}): FakeCoreClient {
  const calls: CoreCall[] = [];
  let servers = initialServers.map(cloneServer);
  let groups = initialGroups.map((group) => ({ ...group }));

  const base: CoreClient = {
    health: async () => {
      remember(calls, 'health', []);
      return health;
    },
    listServers: async () => {
      remember(calls, 'listServers', []);
      return servers.map(cloneServer);
    },
    createServer: async (input, credential) => {
      remember(calls, 'createServer', [input, credential]);
      const created: Server = {
        ...input,
        id: crypto.randomUUID(),
        groupId: input.groupId ?? null,
        secretRef: secretReference(credential),
        lastConnectedAt: null,
        createdAt: currentTimestamp(),
      };
      servers = [...servers, created];
      return cloneServer(created);
    },
    updateServer: async (id, input, credential) => {
      remember(calls, 'updateServer', [id, input, credential]);
      const existing = requireServer(servers, id);
      const updated: Server = {
        ...existing,
        ...input,
        groupId: input.groupId ?? null,
        secretRef: credential === undefined
          ? existing.secretRef
          : secretReference(credential),
      };
      servers = servers.map((server) => (server.id === id ? updated : server));
      return cloneServer(updated);
    },
    deleteServer: async (id) => {
      remember(calls, 'deleteServer', [id]);
      requireServer(servers, id);
      servers = servers.filter((server) => server.id !== id);
    },
    setServerCredential: async (id, input) => {
      remember(calls, 'setServerCredential', [id, input]);
      const existing = requireServer(servers, id);
      const updated = {
        ...existing,
        secretRef: secretReference(input),
      };
      servers = servers.map((server) => (server.id === id ? updated : server));
      return cloneServer(updated);
    },
    listGroups: async () => {
      remember(calls, 'listGroups', []);
      return groups.map((group) => ({ ...group }));
    },
    createGroup: async (input) => {
      remember(calls, 'createGroup', [input]);
      const created: Group = {
        id: crypto.randomUUID(),
        name: input.name,
        sortOrder: input.sortOrder,
      };
      groups = [...groups, created];
      return { ...created };
    },
    updateGroup: async (id, input) => {
      remember(calls, 'updateGroup', [id, input]);
      requireGroup(groups, id);
      const updated: Group = { id, ...input };
      groups = groups.map((group) => (group.id === id ? updated : group));
      return { ...updated };
    },
    deleteGroup: async (id) => {
      remember(calls, 'deleteGroup', [id]);
      requireGroup(groups, id);
      groups = groups.filter((group) => group.id !== id);
      servers = servers.map((server) => (
        server.groupId === id ? { ...server, groupId: null } : server
      ));
    },
  };

  return Object.assign(base, { calls }, overrides);
}

function requireServer(servers: Server[], id: string): Server {
  const server = servers.find((candidate) => candidate.id === id);
  if (!server) {
    throw fakeError('NOT_FOUND', '服务器不存在');
  }
  return server;
}

function requireGroup(groups: Group[], id: string): Group {
  const group = groups.find((candidate) => candidate.id === id);
  if (!group) {
    throw fakeError('NOT_FOUND', '分组不存在');
  }
  return group;
}

function fakeError(code: string, message: string): Error {
  return Object.assign(new Error(message), {
    code,
    retryable: false,
  });
}

function remember(
  calls: CoreCall[],
  method: keyof CoreClient,
  args: unknown[],
): void {
  calls.push({
    method,
    args: args.map((argument) => (
      isCredentialInput(argument)
        ? { credential: '[REDACTED]' }
        : argument
    )),
  });
}

function isCredentialInput(value: unknown): value is ServerCredentialInput {
  return (
    typeof value === 'object'
    && value !== null
    && Object.keys(value).length === 1
    && 'credential' in value
  );
}

function cloneServer(server: Server): Server {
  return { ...server };
}

function secretReference(credential: ServerCredentialInput): string {
  return `fake-secret-${credential.credential.length}-${crypto.randomUUID()}`;
}

function currentTimestamp(): number {
  return Math.floor(Date.now() / 1_000);
}
