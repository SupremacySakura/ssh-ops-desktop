import type {
  ConnectOutcome,
  ConnectionHandle,
  ConnectionStateEvent,
  CoreError,
  CoreErrorCode,
  CoreHealth,
  DockerAction,
  DockerContainer,
  DockerLogs,
  DockerShell,
  FileDeleteArgs,
  FileMkdirArgs,
  FileRenameArgs,
  FileUploadArgs,
  FileWriteArgs,
  Group,
  MonitorSnapshot,
  RemoteDirectoryPath,
  RemoteDownload,
  RemoteFileEntry,
  RemotePath,
  RemoteRenameResult,
  RemoteTextFile,
  RemoteUploadFile,
  Server,
  ServerCredentialInput,
  ServerDeleteOutcome,
  ServerSaveOutcome,
  SshConfigImportPreview,
  SshConfigImportResult,
  TerminalClosedEvent,
  TerminalDataEvent,
  TerminalGapEvent,
} from '@opspilot/contracts';
import {
  FileDeleteArgsSchema,
  FileMkdirArgsSchema,
  FileRenameArgsSchema,
  FileUploadArgsSchema,
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
  setRemoteDocument(path: string, text: string, sha256?: string): void;
}

export interface FakeCoreOptions {
  servers?: Server[];
  groups?: Group[];
  health?: CoreHealth;
  clipboardText?: string;
  terminalEcho?: boolean;
  terminalOsc7?: boolean;
  persistence?: FakeCorePersistence;
  dockerContainers?: DockerContainer[];
  dockerLogs?: Record<string, DockerLogs>;
  dockerStartedAtWarning?: string | null;
  connectOutcome?: ConnectOutcome | ((serverId: string) => ConnectOutcome);
  files?: FakeFileSystem;
  fileFaults?: FakeFileFaults;
  monitorSnapshots?: MonitorSnapshot[] | ((
    connection: ConnectionHandle,
    sequence: number,
  ) => MonitorSnapshot | Promise<MonitorSnapshot>);
  sshConfigImport?: SshConfigImportPreview;
  overrides?: Partial<CoreClient>;
}

export interface FakeCoreSnapshot {
  servers: Server[];
  groups: Group[];
}

export interface FakeCorePersistence {
  load(): FakeCoreSnapshot | null;
  save(snapshot: FakeCoreSnapshot): void;
}

export interface FakeFileSystem {
  entriesByDirectory?: Record<string, RemoteFileEntry[]>;
  documents?: Record<string, RemoteTextFile>;
  downloads?: Record<string, RemoteDownload>;
}

export interface FakeFileFaults {
  hardlinkUnsupported?: boolean;
  failCommitAt?: number;
  failRollback?: boolean;
  failRenameUnlink?: boolean;
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
  clipboardText = '',
  terminalEcho = false,
  terminalOsc7 = false,
  persistence,
  dockerContainers: initialDockerContainers = [],
  dockerLogs = {},
  dockerStartedAtWarning = null,
  connectOutcome,
  files,
  fileFaults = {},
  monitorSnapshots,
  sshConfigImport,
  overrides = {},
}: FakeCoreOptions = {}): FakeCoreClient {
  const calls: CoreCall[] = [];
  const persisted = persistence?.load() ?? null;
  let servers = (persisted?.servers ?? initialServers).map(cloneServer);
  let groups = (persisted?.groups ?? initialGroups).map((group) => ({ ...group }));
  const persist = () => {
    persistence?.save({
      servers: servers.map(cloneServer),
      groups: groups.map((group) => ({ ...group })),
    });
  };
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
  const terminalEchoSequences = new Map<string, number>();
  const terminalInputLines = new Map<string, string>();

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
    readClipboardText: async () => {
      remember(calls, 'readClipboardText', []);
      return clipboardText;
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
      persist();
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
      persist();
      return {
        server: cloneServer(updated),
        warning: null,
      } satisfies ServerSaveOutcome;
    },
    deleteServer: async (id) => {
      remember(calls, 'deleteServer', [id]);
      requireServer(servers, id);
      servers = servers.filter((server) => server.id !== id);
      persist();
      return { warning: null } satisfies ServerDeleteOutcome;
    },
    setServerCredential: async (id, input) => {
      remember(calls, 'setServerCredential', [id, input]);
      const existing = requireServer(servers, id);
      const updated = {
        ...existing,
        secretRef: secretReference(input),
      };
      servers = servers.map((server) => (server.id === id ? updated : server));
      persist();
      return {
        server: cloneServer(updated),
        warning: null,
      } satisfies ServerSaveOutcome;
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
      persist();
      return { ...created };
    },
    updateGroup: async (id, input) => {
      remember(calls, 'updateGroup', [id, input]);
      requireGroup(groups, id);
      const updated: Group = { id, ...input };
      groups = groups.map((group) => (group.id === id ? updated : group));
      persist();
      return { ...updated };
    },
    deleteGroup: async (id) => {
      remember(calls, 'deleteGroup', [id]);
      requireGroup(groups, id);
      groups = groups.filter((group) => group.id !== id);
      servers = servers.map((server) => (
        server.groupId === id ? { ...server, groupId: null } : server
      ));
      persist();
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
        persist();
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
    writeTerminal: async (connection, terminalSessionId, bytes) => {
      remember(calls, 'writeTerminal', [connection, terminalSessionId, Array.from(bytes)]);
      if (terminalEcho || terminalOsc7) {
        const sequence = (terminalEchoSequences.get(terminalSessionId) ?? 1) + 1;
        terminalEchoSequences.set(terminalSessionId, sequence);
        const text = new TextDecoder().decode(bytes);
        const completedLines = terminalOsc7
          ? takeCompletedLines(terminalInputLines, terminalSessionId, text)
          : [];
        const osc7 = completedLines
          .map(osc7ForDirectoryChange)
          .filter((directory): directory is string => directory !== null)
          .at(-1) ?? null;
        emitTerminalData({
          terminalSessionId,
          sequence,
          bytes: ptyEchoBytes(
            new TextEncoder().encode(
              osc7 ? `\u001b]7;file://fixture${osc7}\u0007${text}` : text,
            ),
          ),
        });
      }
    },
    resizeTerminal: async (connection, terminalSessionId, columns, rows) => {
      remember(calls, 'resizeTerminal', [
        connection,
        terminalSessionId,
        columns,
        rows,
      ]);
    },
    closeTerminal: async (connection, terminalSessionId) => {
      remember(calls, 'closeTerminal', [connection, terminalSessionId]);
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
    uploadFiles: async (connection, directory, uploads) => {
      remember(calls, 'uploadFiles', [connection, directory, uploads]);
      const args = parseUploadArgs(directory, uploads);
      if (!entriesByDirectory[args.directory]) {
        throw fakeError('NOT_FOUND', '上传目标目录不存在');
      }
      const existingNames = new Set(
        (entriesByDirectory[args.directory] ?? []).map((entry) => entry.name),
      );
      const conflict = args.files.find((file) => existingNames.has(file.name));
      if (conflict) {
        return {
          status: 'failed_rolled_back',
          committed: [],
          residual: [],
          error: fakeCoreError(
            'CONFLICT',
            `目标文件 ${joinRemotePath(args.directory, conflict.name)} 已存在，未覆盖`,
          ),
        };
      }
      if (fileFaults.hardlinkUnsupported) {
        return {
          status: 'failed_rolled_back',
          committed: [],
          residual: [],
          error: fakeCoreError(
            'CAPABILITY_UNAVAILABLE',
            'SFTP 服务器未启用 hardlink@openssh.com，无法安全提交上传',
          ),
        };
      }

      const committed: RemoteFileEntry[] = [];
      for (const [index, file] of args.files.entries()) {
        if (fileFaults.failCommitAt === index + 1) {
          const remaining = fileFaults.failRollback ? committed : [];
          if (!fileFaults.failRollback) {
            const rollbackPaths = new Set(committed.map((entry) => entry.path));
            entriesByDirectory = Object.fromEntries(
              Object.entries(entriesByDirectory).map(([path, entries]) => [
                path,
                entries.filter((entry) => !rollbackPaths.has(entry.path)),
              ]),
            );
          } else if (remaining.length > 0) {
            entriesByDirectory = {
              ...entriesByDirectory,
              [args.directory]: [
                ...(entriesByDirectory[args.directory] ?? []),
                ...remaining,
              ],
            };
          }
          const residual = remaining.map((entry) => entry.path);
          return {
            status: residual.length > 0
              ? 'failed_with_residue'
              : 'failed_rolled_back',
            committed: residual,
            residual,
            warning: residual.length > 0
              ? `回滚未完全完成，以下路径可能仍然存在：${residual.join('、')}`
              : undefined,
            error: fakeCoreError(
              'CONFLICT',
              `第 ${index + 1} 个文件提交失败`,
            ),
          };
        }
        committed.push(uploadedFileEntry(args.directory, file));
      }
      entriesByDirectory = {
        ...entriesByDirectory,
        [args.directory]: [
          ...(entriesByDirectory[args.directory] ?? []),
          ...committed,
        ],
      };
      return {
        status: 'succeeded',
        committed: committed.map((entry) => entry.path),
        residual: [],
      };
    },
    createDirectory: async (connection, path) => {
      remember(calls, 'createDirectory', [connection, path]);
      const args = parseMkdirArgs(path);
      const parent = remoteParent(args.path);
      const parentEntries = entriesByDirectory[parent];
      if (!parentEntries) {
        throw fakeError('NOT_FOUND', '新建目录的父目录不存在');
      }
      if (findFileEntry(entriesByDirectory, args.path)) {
        throw fakeError('CONFLICT', `目标 ${args.path} 已存在，未创建目录`);
      }
      entriesByDirectory = {
        ...entriesByDirectory,
        [parent]: [
          ...parentEntries,
          {
            name: remoteBasename(args.path),
            path: args.path,
            kind: 'directory',
            size: 0,
            modifiedAt: currentTimestamp(),
            permissions: 0o755,
          },
        ],
        [args.path]: [],
      };
      return { path: args.path };
    },
    renameFile: async (connection, sourcePath, targetPath) => {
      remember(calls, 'renameFile', [connection, sourcePath, targetPath]);
      const args = parseRenameArgs(sourcePath, targetPath);
      const source = findFileEntry(entriesByDirectory, args.sourcePath);
      if (!source) {
        throw fakeError('NOT_FOUND', '重命名源文件不存在');
      }
      if (source.kind === 'directory') {
        throw fakeError(
          'CAPABILITY_UNAVAILABLE',
          '当前 SFTP 服务器没有经过验证的原子 no-replace 目录重命名原语，已拒绝操作',
        );
      }
      if (source.kind !== 'file') {
        throw fakeError('VALIDATION', '重命名源不是普通文件，已拒绝');
      }
      if (findFileEntry(entriesByDirectory, args.targetPath)) {
        throw fakeError('CONFLICT', `目标文件 ${args.targetPath} 已存在，未覆盖`);
      }
      const renamed: RemoteFileEntry = {
        ...source,
        name: remoteBasename(args.targetPath),
        path: args.targetPath,
        modifiedAt: currentTimestamp(),
      };
      const targetParent = remoteParent(args.targetPath);
      entriesByDirectory = Object.fromEntries(
        Object.entries(entriesByDirectory).map(([path, entries]) => [
          path,
          fileFaults.failRenameUnlink
            ? [...entries, ...(path === targetParent ? [renamed] : [])]
            : path === targetParent
              ? [
                  ...entries.filter((entry) => entry.path !== source.path),
                  renamed,
                ]
              : entries.filter((entry) => entry.path !== source.path),
        ]),
      );
      if (!fileFaults.failRenameUnlink) {
        moveRecordKey(documents, args.sourcePath, args.targetPath);
        moveRecordKey(downloads, args.sourcePath, args.targetPath);
        return {
          status: 'renamed',
          sourcePath: args.sourcePath,
          targetPath: args.targetPath,
          targetCreated: true,
        };
      }
      copyRecordKey(documents, args.sourcePath, args.targetPath);
      copyRecordKey(downloads, args.sourcePath, args.targetPath);
      return {
        status: 'partial',
        sourcePath: args.sourcePath,
        targetPath: args.targetPath,
        targetCreated: true,
        warning: '目标文件已创建，但源文件删除失败或结果未知；请刷新目录核对后重试清理源文件。',
        error: fakeCoreError('INTERNAL', '源文件删除失败', true),
      } satisfies RemoteRenameResult;
    },
    deleteFile: async (connection, path) => {
      remember(calls, 'deleteFile', [connection, path]);
      const args = parseDeleteArgs(path);
      const entry = findFileEntry(entriesByDirectory, args.path);
      if (!entry) {
        throw fakeError('NOT_FOUND', '要删除的远程条目不存在');
      }
      if (entry.kind === 'other') {
        throw fakeError('VALIDATION', '该路径不是普通文件、符号链接或目录，已拒绝删除');
      }
      if (entry.kind === 'directory') {
        const hasChildren = (entriesByDirectory[args.path] ?? []).length > 0
          || Object.keys(entriesByDirectory).some(
            (path) => path !== args.path && path.startsWith(`${args.path}/`),
          );
        if (hasChildren) {
          throw fakeError(
            'CONFLICT',
            '目录非空；Harbor 不会递归删除，请先清空目录',
          );
        }
      }
      const parent = remoteParent(args.path);
      entriesByDirectory = Object.fromEntries(
        Object.entries(entriesByDirectory)
          .filter(([path]) => path !== args.path)
          .map(([path, entries]) => [
            path,
            path === parent
              ? entries.filter((candidate) => candidate.path !== args.path)
              : entries,
          ]),
      );
      delete documents[args.path];
      delete downloads[args.path];
      return { path: args.path };
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
      persist();
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
    setRemoteDocument: (
      path: string,
      text: string,
      sha256: string = fakeSha256(text),
    ) => {
      const remotePath = parseFilePath(path);
      const size = new TextEncoder().encode(text).byteLength;
      const modifiedAt = currentTimestamp();
      documents = {
        ...documents,
        [remotePath]: {
          path: remotePath,
          text,
          sha256,
          size,
          modifiedAt,
        },
      };
      entriesByDirectory = Object.fromEntries(
        Object.entries(entriesByDirectory).map(([directory, entries]) => [
          directory,
          entries.map((entry) => (
            entry.path === remotePath ? { ...entry, size, modifiedAt } : entry
          )),
        ]),
      );
    },
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

function fakeCoreError(
  code: CoreErrorCode,
  message: string,
  retryable = false,
): CoreError {
  return { code, message, retryable };
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

function parseUploadArgs(
  directory: RemoteDirectoryPath | string,
  files: RemoteUploadFile[],
): FileUploadArgs {
  const parsed = FileUploadArgsSchema.safeParse({ directory, files });
  if (!parsed.success) throw fakeError('VALIDATION', '上传文件或目录参数无效');
  return parsed.data;
}

function parseMkdirArgs(path: RemotePath | string): FileMkdirArgs {
  const parsed = FileMkdirArgsSchema.safeParse({ path });
  if (!parsed.success) throw fakeError('VALIDATION', '新建目录路径无效');
  return parsed.data;
}

function parseRenameArgs(
  sourcePath: RemotePath | string,
  targetPath: RemotePath | string,
): FileRenameArgs {
  const parsed = FileRenameArgsSchema.safeParse({ sourcePath, targetPath });
  if (!parsed.success) throw fakeError('VALIDATION', '重命名路径无效');
  return parsed.data;
}

function parseDeleteArgs(path: RemotePath | string): FileDeleteArgs {
  const parsed = FileDeleteArgsSchema.safeParse({ path });
  if (!parsed.success) throw fakeError('VALIDATION', '删除路径无效');
  return parsed.data;
}

function joinRemotePath(directory: string, name: string): string {
  return directory === '/' ? `/${name}` : `${directory}/${name}`;
}

function remoteParent(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

function remoteBasename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function uploadedFileEntry(
  directory: string,
  file: RemoteUploadFile,
): RemoteFileEntry {
  return {
    name: file.name,
    path: joinRemotePath(directory, file.name),
    kind: 'file',
    size: file.bytes.length,
    modifiedAt: currentTimestamp(),
    permissions: 0o644,
  };
}

function findFileEntry(
  entriesByDirectory: Record<string, RemoteFileEntry[]>,
  path: string,
): RemoteFileEntry | null {
  for (const entries of Object.values(entriesByDirectory)) {
    const entry = entries.find((candidate) => candidate.path === path);
    if (entry) return entry;
  }
  return null;
}

function moveRecordKey<T>(
  record: Record<string, T>,
  source: string,
  target: string,
): void {
  const value = record[source];
  if (value === undefined) return;
  delete record[source];
  record[target] = value;
}

function copyRecordKey<T>(
  record: Record<string, T>,
  source: string,
  target: string,
): void {
  const value = record[source];
  if (value === undefined) return;
  record[target] = value;
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

function ptyEchoBytes(bytes: Uint8Array): number[] {
  const normalized = new TextDecoder()
    .decode(bytes)
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\n', '\r\n');
  return Array.from(new TextEncoder().encode(normalized));
}

function osc7ForDirectoryChange(text: string): string | null {
  const match = /^\s*cd\s+(\/[^\s\r\n]*)\s*$/u.exec(text);
  return match?.[1] ?? null;
}

function takeCompletedLines(
  buffers: Map<string, string>,
  sessionId: string,
  text: string,
): string[] {
  const parts = `${buffers.get(sessionId) ?? ''}${text}`.split(/\r\n|\r|\n/u);
  buffers.set(sessionId, parts.pop() ?? '');
  return parts.filter((line) => line.trim().length > 0);
}
