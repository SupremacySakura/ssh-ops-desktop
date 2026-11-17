import type {
  ConnectOutcome,
  ConnectionHandle,
  ConnectionStateEvent,
  CoreHealth,
  DockerAction,
  DockerContainer,
  DockerLogs,
  DockerShell,
  FileWriteArgs,
  Group,
  MonitorSnapshot,
  RemoteDirectoryPath,
  RemoteDownload,
  RemoteFileEntry,
  RemotePath,
  RemoteTextFile,
  Server,
  ServerCredentialInput,
  SshConfigImportPreview,
  SshConfigImportResult,
  TerminalClosedEvent,
  TerminalDataEvent,
  TerminalGapEvent,
} from '@opspilot/contracts';
import {
  FileWriteArgsSchema,
  RemoteDirectoryPathSchema,
  RemotePathSchema,
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
  dockerContainers?: DockerContainer[];
  dockerLogs?: Record<string, DockerLogs>;
  dockerStartedAtWarning?: string | null;
  connectOutcome?: ConnectOutcome | ((serverId: string) => ConnectOutcome);
  files?: FakeFileSystem;
  monitorSnapshots?: MonitorSnapshot[] | ((
    connection: ConnectionHandle,
    sequence: number,
  ) => MonitorSnapshot | Promise<MonitorSnapshot>);
  sshConfigImport?: SshConfigImportPreview;
  overrides?: Partial<CoreClient>;
}

export interface FakeFileSystem {
  entriesByDirectory?: Record<string, RemoteFileEntry[]>;
  documents?: Record<string, RemoteTextFile>;
  downloads?: Record<string, RemoteDownload>;
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
  dockerContainers: initialDockerContainers = [],
  dockerLogs = {},
  dockerStartedAtWarning = null,
  connectOutcome,
  files,
  monitorSnapshots,
  sshConfigImport,
  overrides = {},
}: FakeCoreOptions = {}): FakeCoreClient {
  const calls: CoreCall[] = [];
  let servers = initialServers.map(cloneServer);
  let groups = initialGroups.map((group) => ({ ...group }));
  let entriesByDirectory = Object.fromEntries(
    Object.entries(files?.entriesByDirectory ?? {}).map(([path, entries]) => [
      path,
      entries.map(cloneFileEntry),
    ]),
  ) as Record<string, RemoteFileEntry[]>;
  let documents = Object.fromEntries(
    Object.entries(files?.documents ?? {}).map(([path, document]) => [
      path,
      { ...document },
    ]),
  ) as Record<string, RemoteTextFile>;
  const downloads = Object.fromEntries(
    Object.entries(files?.downloads ?? {}).map(([path, download]) => [
      path,
      cloneDownload(download),
    ]),
  ) as Record<string, RemoteDownload>;
  let containers = initialDockerContainers.map(cloneDockerContainer);
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
    listFiles: async (connection, path) => {
      remember(calls, 'listFiles', [connection, path]);
      const directory = parseDirectoryPath(path);
      return (entriesByDirectory[directory] ?? [])
        .map(cloneFileEntry)
        .sort(compareFileEntries);
    },
    readFile: async (connection, path) => {
      remember(calls, 'readFile', [connection, path]);
      const remotePath = parseFilePath(path);
      const document = documents[remotePath];
      if (!document) {
        throw fakeError('NOT_FOUND', '远程文件不存在');
      }
      return { ...document };
    },
    writeFile: async (connection, path, content, expectedSha256) => {
      remember(calls, 'writeFile', [connection, path, content, expectedSha256]);
      const args = parseWriteArgs(path, content, expectedSha256);
      const document = documents[args.path];
      if (!document) {
        throw fakeError('NOT_FOUND', '远程文件不存在');
      }
      if (document.sha256 !== args.expectedSha256) {
        throw fakeError('CONFLICT', '远程文件已在别处修改，草稿保留');
      }
      const modifiedAt = currentTimestamp();
      const sha256 = fakeSha256(args.content);
      documents = {
        ...documents,
        [args.path]: {
          ...document,
          text: args.content,
          sha256,
          size: new TextEncoder().encode(args.content).byteLength,
          modifiedAt,
        },
      };
      entriesByDirectory = Object.fromEntries(
        Object.entries(entriesByDirectory).map(([directory, entries]) => [
          directory,
          entries.map((entry) => (
            entry.path === args.path
              ? {
                  ...entry,
                  size: new TextEncoder().encode(args.content).byteLength,
                  modifiedAt,
                }
              : entry
          )),
        ]),
      );
      return {
        path: args.path,
        sha256,
        size: new TextEncoder().encode(args.content).byteLength,
        modifiedAt,
      };
    },
    downloadFile: async (connection, path) => {
      remember(calls, 'downloadFile', [connection, path]);
      const remotePath = parseFilePath(path);
      const configured = downloads[remotePath];
      if (configured) return cloneDownload(configured);
      const document = documents[remotePath];
      if (document) {
        return {
          path: remotePath,
          bytes: Array.from(new TextEncoder().encode(document.text)),
          sha256: document.sha256,
        };
      }
      throw fakeError('NOT_FOUND', '远程文件不存在');
    },
    listDockerContainers: async (connection) => {
      remember(calls, 'listDockerContainers', [connection]);
      return {
        containers: containers.map(cloneDockerContainer),
        startedAtWarning: dockerStartedAtWarning,
      };
    },
    getDockerLogs: async (connection, containerId, tail) => {
      remember(calls, 'getDockerLogs', [connection, containerId, tail]);
      requireContainer(containers, containerId);
      const fixture = dockerLogs[containerId];
      return fixture
        ? { ...fixture, tail }
        : {
            containerId,
            tail,
            stdout: 'harbor docker stdout fixture\n',
            stderr: 'harbor docker stderr fixture\n',
          };
    },
    runDockerAction: async (connection, containerId, action) => {
      remember(calls, 'runDockerAction', [connection, containerId, action]);
      const existing = requireContainer(containers, containerId);
      containers = containers.map((container) => (
        container.id === containerId
          ? applyDockerAction(container, action)
          : container
      ));
      if (action === 'restart') {
        containers = containers.map((container) => (
          container.id === existing.id
            ? { ...container, startedAt: new Date().toISOString() }
            : container
        ));
      }
    },
    execDockerContainer: async (
      connection,
      containerId,
      shell: DockerShell,
      columns,
      rows,
    ) => {
      remember(calls, 'execDockerContainer', [
        connection,
        containerId,
        shell,
        columns,
        rows,
      ]);
      const container = requireContainer(containers, containerId);
      if (container.state !== 'running') {
        throw fakeError('CONFLICT', '容器未运行，无法打开 exec 会话');
      }
      const session = {
        id: crypto.randomUUID(),
        connection,
      };
      emitTerminalData({
        terminalSessionId: session.id,
        sequence: 1,
        bytes: Array.from(new TextEncoder().encode(
          `docker exec ${container.names[0]} ${shell}\r\n`,
        )),
      });
      return session;
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

function requireContainer(containers: DockerContainer[], id: string): DockerContainer {
  const container = containers.find((candidate) => candidate.id === id);
  if (!container) {
    throw fakeError('DOCKER_CONTAINER_NOT_FOUND', '容器不存在，请刷新列表');
  }
  return container;
}

function applyDockerAction(
  container: DockerContainer,
  action: DockerAction,
): DockerContainer {
  switch (action) {
    case 'start':
      return {
        ...container,
        state: 'running',
        status: 'Up less than a second',
        startedAt: new Date().toISOString(),
      };
    case 'stop':
      return {
        ...container,
        state: 'exited',
        status: 'Exited (0)',
      };
    case 'restart':
      return {
        ...container,
        state: 'running',
        status: 'Up less than a second',
      };
  }
}

function cloneDockerContainer(container: DockerContainer): DockerContainer {
  return {
    ...container,
    names: [...container.names],
    ports: [...container.ports],
  };
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

function cloneFileEntry(entry: RemoteFileEntry): RemoteFileEntry {
  return { ...entry };
}

function cloneDownload(download: RemoteDownload): RemoteDownload {
  return {
    ...download,
    bytes: [...download.bytes],
  };
}

function compareFileEntries(left: RemoteFileEntry, right: RemoteFileEntry): number {
  const directoryOrder = Number(right.kind === 'directory') - Number(left.kind === 'directory');
  if (directoryOrder !== 0) return directoryOrder;
  return left.name.localeCompare(right.name, 'en-US', { sensitivity: 'base' })
    || left.name.localeCompare(right.name, 'en-US');
}

function parseDirectoryPath(path: RemoteDirectoryPath | string): RemoteDirectoryPath {
  const parsed = RemoteDirectoryPathSchema.safeParse(path);
  if (!parsed.success) throw fakeError('VALIDATION', '远程目录路径无效');
  return parsed.data;
}

function parseFilePath(path: RemotePath | string): RemotePath {
  const parsed = RemotePathSchema.safeParse(path);
  if (!parsed.success) throw fakeError('VALIDATION', '远程文件路径无效');
  return parsed.data;
}

function parseWriteArgs(
  path: RemotePath | string,
  content: string,
  expectedSha256: string,
): FileWriteArgs {
  const parsed = FileWriteArgsSchema.safeParse({
    path,
    content,
    expectedSha256,
  });
  if (!parsed.success) throw fakeError('VALIDATION', '保存内容或冲突校验值无效');
  return parsed.data;
}

function fakeSha256(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').repeat(8);
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
