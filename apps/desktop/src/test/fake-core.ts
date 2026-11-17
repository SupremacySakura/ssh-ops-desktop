import type {
  ConnectOutcome,
  ConnectionHandle,
  ConnectionStateEvent,
  CoreHealth,
  Group,
  MonitorSnapshot,
  Server,
  ServerCredentialInput,
  SshConfigImportPreview,
  SshConfigImportResult,
  TerminalClosedEvent,
  TerminalDataEvent,
  TerminalGapEvent,
} from '@opspilot/contracts';

import type { CoreClient } from '../api/core';

export interface CoreCall {
  method: keyof CoreClient;
  args: unknown[];
}

export interface FakeCoreClient extends CoreClient {
  readonly calls: CoreCall[];
  emitConnectionState(event: ConnectionStateEvent): void;
  emitTerminalData(event: TerminalDataEvent): void;
  emitTerminalGap(event: TerminalGapEvent): void;
  emitTerminalClosed(event: TerminalClosedEvent): void;
}

export interface FakeCoreOptions {
  servers?: Server[];
  groups?: Group[];
  health?: CoreHealth;
  connectOutcome?: ConnectOutcome | ((serverId: string) => ConnectOutcome);
  monitorSnapshots?: MonitorSnapshot[] | ((
    connection: ConnectionHandle,
    sequence: number,
  ) => MonitorSnapshot | Promise<MonitorSnapshot>);
  sshConfigImport?: SshConfigImportPreview;
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
  connectOutcome,
  monitorSnapshots,
  sshConfigImport,
  overrides = {},
}: FakeCoreOptions = {}): FakeCoreClient {
  const calls: CoreCall[] = [];
  let servers = initialServers.map(cloneServer);
  let groups = initialGroups.map((group) => ({ ...group }));
  const connectionStateHandlers = new Set<(event: ConnectionStateEvent) => void>();
  const terminalDataHandlers = new Set<(event: TerminalDataEvent) => void>();
  const terminalGapHandlers = new Set<(event: TerminalGapEvent) => void>();
  const terminalClosedHandlers = new Set<(event: TerminalClosedEvent) => void>();
  let connectionSequence = 0;
  let monitorSequence = 0;

  const emitConnectionState = (event: ConnectionStateEvent) => {
    for (const handler of connectionStateHandlers) handler(event);
  };
  const emitTerminalData = (event: TerminalDataEvent) => {
    for (const handler of terminalDataHandlers) handler(event);
  };
  const emitTerminalGap = (event: TerminalGapEvent) => {
    for (const handler of terminalGapHandlers) handler(event);
  };
  const emitTerminalClosed = (event: TerminalClosedEvent) => {
    for (const handler of terminalClosedHandlers) handler(event);
  };
  const importPreview = sshConfigImport
    ? cloneSshConfigImportPreview(sshConfigImport)
    : null;

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
      if (credential === undefined && input.authType !== existing.authType) {
        throw fakeError('VALIDATION', '更改认证方式时必须提供新凭据');
      }
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
    connect: async (serverId) => {
      remember(calls, 'connect', [serverId]);
      const server = requireServer(servers, serverId);
      if (server.secretRef === null) {
        throw fakeError('SECRET_UNAVAILABLE', '该服务器的凭据尚未配置');
      }
      const outcome = typeof connectOutcome === 'function'
        ? connectOutcome(serverId)
        : connectOutcome ?? {
            kind: 'ready' as const,
            connection: {
              serverId,
              connectionId: crypto.randomUUID(),
            },
          };
      if (outcome.kind === 'ready') {
        servers = servers.map((candidate) => (
          candidate.id === serverId
            ? { ...candidate, lastConnectedAt: currentTimestamp() }
            : candidate
        ));
        connectionSequence += 1;
        emitConnectionState({
          serverId,
          connectionId: outcome.connection.connectionId,
          sequence: connectionSequence,
          state: { kind: 'ready' },
        });
      }
      return outcome;
    },
    trustHostKey: async (serverId, verificationId) => {
      remember(calls, 'trustHostKey', [serverId, verificationId]);
    },
    disconnect: async (connection) => {
      remember(calls, 'disconnect', [connection]);
      connectionSequence += 1;
      emitConnectionState({
        serverId: connection.serverId,
        connectionId: connection.connectionId,
        sequence: connectionSequence,
        state: { kind: 'closed' },
      });
    },
    openTerminal: async (connection, columns, rows) => {
      remember(calls, 'openTerminal', [connection, columns, rows]);
      const session = {
        id: crypto.randomUUID(),
        connection,
      };
      emitTerminalData({
        terminalSessionId: session.id,
        sequence: 1,
        bytes: Array.from(new TextEncoder().encode('harbor renderer fixture\r\n')),
      });
      return session;
    },
    writeTerminal: async (terminalSessionId, bytes) => {
      remember(calls, 'writeTerminal', [terminalSessionId, Array.from(bytes)]);
    },
    resizeTerminal: async (terminalSessionId, columns, rows) => {
      remember(calls, 'resizeTerminal', [terminalSessionId, columns, rows]);
    },
    closeTerminal: async (terminalSessionId) => {
      remember(calls, 'closeTerminal', [terminalSessionId]);
      emitTerminalClosed({
        terminalSessionId,
        reason: 'closed',
      });
    },
    monitorSnapshot: async (connection) => {
      remember(calls, 'monitorSnapshot', [connection]);
      const sequence = monitorSequence;
      monitorSequence += 1;
      const snapshot = typeof monitorSnapshots === 'function'
        ? await monitorSnapshots(connection, sequence)
        : monitorSnapshots && monitorSnapshots.length > 0
          ? monitorSnapshots[Math.min(sequence, monitorSnapshots.length - 1)]
          : defaultMonitorSnapshot();
      return cloneMonitorSnapshot(snapshot);
    },
    subscribeConnectionState: async (handler) => {
      connectionStateHandlers.add(handler);
      return () => connectionStateHandlers.delete(handler);
    },
    subscribeTerminalData: async (handler) => {
      terminalDataHandlers.add(handler);
      return () => terminalDataHandlers.delete(handler);
    },
    subscribeTerminalGap: async (handler) => {
      terminalGapHandlers.add(handler);
      return () => terminalGapHandlers.delete(handler);
    },
    subscribeTerminalClosed: async (handler) => {
      terminalClosedHandlers.add(handler);
      return () => terminalClosedHandlers.delete(handler);
    },
    previewSshConfigImport: async () => {
      remember(calls, 'previewSshConfigImport', []);
      if (!importPreview) {
        throw fakeError(
          'NOT_FOUND',
          '未找到 SSH Config 文件，请确认 ~/.ssh/config 存在',
        );
      }
      return cloneSshConfigImportPreview(importPreview);
    },
    applySshConfigImport: async (input) => {
      remember(calls, 'applySshConfigImport', [input]);
      if (!importPreview || input.previewId !== importPreview.previewId) {
        throw fakeError('NOT_FOUND', 'SSH Config 导入预览不存在或已过期，请重新预览');
      }

      const rows = input.selectedRowIds.map((rowId) => {
        const row = importPreview.items.find((item) => item.id === rowId);
        if (!row) {
          throw fakeError('VALIDATION', '所选条目不属于当前 SSH Config 预览');
        }
        return row;
      });
      const identities = new Set(
        servers.map((server) => (
          `${server.host.toLocaleLowerCase('en-US')}\0${server.port}\0${server.user}`
        )),
      );
      const created: Server[] = [];
      for (const row of rows) {
        const identity = `${row.host.toLocaleLowerCase('en-US')}\0${row.port}\0${row.username}`;
        if (row.status !== 'ready' || identities.has(identity)) {
          continue;
        }
        identities.add(identity);
        const server: Server = {
          id: crypto.randomUUID(),
          name: row.alias,
          host: row.host,
          port: row.port,
          user: row.username,
          authType: 'key',
          secretRef: null,
          groupId: null,
          favorite: false,
          lastConnectedAt: null,
          createdAt: currentTimestamp(),
        };
        created.push(server);
      }
      servers = [...servers, ...created.map(cloneServer)];
      const result: SshConfigImportResult = {
        importedCount: created.length,
        skippedCount: rows.length - created.length,
        servers: created.map(cloneServer),
      };
      return result;
    },
  };

  return Object.assign(base, {
    calls,
    emitConnectionState,
    emitTerminalData,
    emitTerminalGap,
    emitTerminalClosed,
  }, overrides);
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

function cloneSshConfigImportPreview(
  preview: SshConfigImportPreview,
): SshConfigImportPreview {
  return {
    ...preview,
    items: preview.items.map((item) => ({
      ...item,
      unsupportedDirectives: [...item.unsupportedDirectives],
      warnings: [...item.warnings],
    })),
    warnings: preview.warnings.map((warning) => ({ ...warning })),
  };
}

function defaultMonitorSnapshot(): MonitorSnapshot {
  return {
    timestamp: new Date().toISOString(),
    cpuPercent: 34,
    memory: {
      totalBytes: 8 * 1024 * 1024 * 1024,
      availableBytes: Math.floor(8 * 1024 * 1024 * 1024 * 0.38),
      usedBytes: Math.floor(8 * 1024 * 1024 * 1024 * 0.62),
    },
    disk: {
      filesystem: '/dev/vda1',
      totalBytes: 80 * 1024 * 1024 * 1024,
      usedBytes: Math.floor(80 * 1024 * 1024 * 1024 * 0.48),
      availableBytes: Math.floor(80 * 1024 * 1024 * 1024 * 0.52),
      mountPoint: '/',
    },
    load: { one: 0.42, five: 0.38, fifteen: 0.41 },
    uptimeSeconds: 2_004_000,
    topProcesses: [{
      pid: 4242,
      user: 'deploy',
      name: 'nginx worker',
      cpuPercent: 12.5,
      memoryPercent: 3.25,
    }, {
      pid: 5151,
      user: 'postgres',
      name: 'postgres',
      cpuPercent: 2.5,
      memoryPercent: 18.75,
    }],
    unavailable: [],
  };
}

function cloneMonitorSnapshot(snapshot: MonitorSnapshot): MonitorSnapshot {
  return {
    ...snapshot,
    memory: snapshot.memory ? { ...snapshot.memory } : undefined,
    disk: snapshot.disk ? { ...snapshot.disk } : undefined,
    load: snapshot.load ? { ...snapshot.load } : undefined,
    topProcesses: snapshot.topProcesses.map((process) => ({ ...process })),
    unavailable: [...snapshot.unavailable],
  };
}

function secretReference(credential: ServerCredentialInput): string {
  return `fake-secret-${credential.credential.length}-${crypto.randomUUID()}`;
}

function currentTimestamp(): number {
  return Math.floor(Date.now() / 1_000);
}
