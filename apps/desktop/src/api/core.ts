import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  ConnectOutcomeSchema,
  ConnectionHandleSchema,
  ConnectionStateEventSchema,
  CoreHealthSchema,
  DockerActionSchema,
  DockerContainerIdSchema,
  DockerContainerListSchema,
  DockerLogsSchema,
  DockerShellSchema,
  FileWriteArgsSchema,
  GroupInputSchema,
  GroupSchema,
  MonitorSnapshotSchema,
  RemoteDirectoryPathSchema,
  RemoteDownloadSchema,
  RemoteFileListSchema,
  RemoteFileWriteResultSchema,
  RemotePathSchema,
  RemoteTextFileSchema,
  ServerCredentialInputSchema,
  ServerInputSchema,
  ServerSchema,
  SshConfigImportApplyInputSchema,
  SshConfigImportPreviewSchema,
  SshConfigImportResultSchema,
  TerminalClosedSchema,
  TerminalDataSchema,
  TerminalGapSchema,
  TerminalSessionSchema,
  type ConnectOutcome,
  type ConnectionHandle,
  type ConnectionStateEvent,
  type CoreHealth,
  type DockerAction,
  type DockerContainerList,
  type DockerLogs,
  type DockerShell,
  type Group,
  type GroupInput,
  type MonitorSnapshot,
  type RemoteDownload,
  type RemoteDirectoryPath,
  type RemoteFileEntry,
  type RemoteFileWriteResult,
  type RemotePath,
  type RemoteTextFile,
  type Server,
  type ServerCredentialInput,
  type ServerInput,
  type SshConfigImportApplyInput,
  type SshConfigImportPreview,
  type SshConfigImportResult,
  type TerminalClosedEvent,
  type TerminalDataEvent,
  type TerminalGapEvent,
  type TerminalSession,
} from '@opspilot/contracts';

export interface CoreClient {
  health(): Promise<CoreHealth>;
  listServers(): Promise<Server[]>;
  createServer(input: ServerInput, credential: ServerCredentialInput): Promise<Server>;
  updateServer(
    id: string,
    input: ServerInput,
    credential?: ServerCredentialInput,
  ): Promise<Server>;
  deleteServer(id: string): Promise<void>;
  setServerCredential(id: string, input: ServerCredentialInput): Promise<Server>;
  listGroups(): Promise<Group[]>;
  createGroup(input: GroupInput): Promise<Group>;
  updateGroup(id: string, input: GroupInput): Promise<Group>;
  deleteGroup(id: string): Promise<void>;
  connect(serverId: string): Promise<ConnectOutcome>;
  trustHostKey(serverId: string, verificationId: string): Promise<void>;
  disconnect(connection: ConnectionHandle): Promise<void>;
  openTerminal(
    connection: ConnectionHandle,
    columns: number,
    rows: number,
  ): Promise<TerminalSession>;
  writeTerminal(terminalSessionId: string, bytes: Uint8Array): Promise<void>;
  resizeTerminal(terminalSessionId: string, columns: number, rows: number): Promise<void>;
  closeTerminal(terminalSessionId: string): Promise<void>;
  listFiles(
    connection: ConnectionHandle,
    path: RemoteDirectoryPath | string,
  ): Promise<RemoteFileEntry[]>;
  readFile(
    connection: ConnectionHandle,
    path: RemotePath | string,
  ): Promise<RemoteTextFile>;
  writeFile(
    connection: ConnectionHandle,
    path: RemotePath | string,
    content: string,
    expectedSha256: string,
  ): Promise<RemoteFileWriteResult>;
  downloadFile(
    connection: ConnectionHandle,
    path: RemotePath | string,
  ): Promise<RemoteDownload>;
  listDockerContainers(connection: ConnectionHandle): Promise<DockerContainerList>;
  getDockerLogs(
    connection: ConnectionHandle,
    containerId: string,
    tail: number,
  ): Promise<DockerLogs>;
  runDockerAction(
    connection: ConnectionHandle,
    containerId: string,
    action: DockerAction,
  ): Promise<void>;
  execDockerContainer(
    connection: ConnectionHandle,
    containerId: string,
    shell: DockerShell,
    columns: number,
    rows: number,
  ): Promise<TerminalSession>;
  monitorSnapshot(connection: ConnectionHandle): Promise<MonitorSnapshot>;
  subscribeConnectionState(handler: (event: ConnectionStateEvent) => void): Promise<UnlistenFn>;
  subscribeTerminalData(handler: (event: TerminalDataEvent) => void): Promise<UnlistenFn>;
  subscribeTerminalGap(handler: (event: TerminalGapEvent) => void): Promise<UnlistenFn>;
  subscribeTerminalClosed(handler: (event: TerminalClosedEvent) => void): Promise<UnlistenFn>;
  previewSshConfigImport(): Promise<SshConfigImportPreview>;
  applySshConfigImport(input: SshConfigImportApplyInput): Promise<SshConfigImportResult>;
}

export function createTauriCoreClient(): CoreClient {
  return {
    health: async () => CoreHealthSchema.parse(await invoke('core_health')),
    listServers: async () => (
      ServerSchema.array().parse(await invoke('server_list'))
    ),
    createServer: async (input, credential) => ServerSchema.parse(
      await invoke('server_create', {
        input: ServerInputSchema.parse(input),
        credential: ServerCredentialInputSchema.parse(credential),
      }),
    ),
    updateServer: async (id, input, credential) => ServerSchema.parse(
      await invoke('server_update', {
        id,
        input: ServerInputSchema.parse(input),
        credential: credential === undefined
          ? null
          : ServerCredentialInputSchema.parse(credential),
      }),
    ),
    deleteServer: async (id) => {
      await invoke('server_delete', { id });
    },
    setServerCredential: async (id, input) => ServerSchema.parse(
      await invoke('server_credential_set', {
        id,
        input: ServerCredentialInputSchema.parse(input),
      }),
    ),
    listGroups: async () => GroupSchema.array().parse(
      await invoke('server_group_list'),
    ),
    createGroup: async (input) => GroupSchema.parse(
      await invoke('server_group_create', {
        input: GroupInputSchema.parse(input),
      }),
    ),
    updateGroup: async (id, input) => GroupSchema.parse(
      await invoke('server_group_update', {
        id,
        input: GroupInputSchema.parse(input),
      }),
    ),
    deleteGroup: async (id) => {
      await invoke('server_group_delete', { id });
    },
    connect: async (serverId) => ConnectOutcomeSchema.parse(
      await invoke('connection_connect', { serverId }),
    ),
    trustHostKey: async (serverId, verificationId) => {
      await invoke('connection_trust_host_key', { serverId, verificationId });
    },
    disconnect: async (connection) => {
      await invoke('connection_disconnect', { connection });
    },
    openTerminal: async (connection, columns, rows) => TerminalSessionSchema.parse(
      await invoke('terminal_open', { connection, columns, rows }),
    ),
    writeTerminal: async (terminalSessionId, bytes) => {
      await invoke('terminal_write', {
        terminalSessionId,
        bytes: Array.from(bytes),
      });
    },
    resizeTerminal: async (terminalSessionId, columns, rows) => {
      await invoke('terminal_resize', { terminalSessionId, columns, rows });
    },
    closeTerminal: async (terminalSessionId) => {
      await invoke('terminal_close', { terminalSessionId });
    },
    listFiles: async (connection, path) => RemoteFileListSchema.parse(
      await invoke('file_list', {
        connection: ConnectionHandleSchema.parse(connection),
        path: RemoteDirectoryPathSchema.parse(path),
      }),
    ),
    readFile: async (connection, path) => RemoteTextFileSchema.parse(
      await invoke('file_read', {
        connection: ConnectionHandleSchema.parse(connection),
        path: RemotePathSchema.parse(path),
      }),
    ),
    writeFile: async (connection, path, content, expectedSha256) => {
      const args = FileWriteArgsSchema.parse({ path, content, expectedSha256 });
      return RemoteFileWriteResultSchema.parse(
        await invoke('file_write', {
          connection: ConnectionHandleSchema.parse(connection),
          ...args,
        }),
      );
    },
    downloadFile: async (connection, path) => RemoteDownloadSchema.parse(
      await invoke('file_download', {
        connection: ConnectionHandleSchema.parse(connection),
        path: RemotePathSchema.parse(path),
      }),
    ),
    listDockerContainers: async (connection) => DockerContainerListSchema.parse(
      await invoke('docker_list', { connection }),
    ),
    getDockerLogs: async (connection, containerId, tail) => DockerLogsSchema.parse(
      await invoke('docker_logs', {
        connection,
        containerId: DockerContainerIdSchema.parse(containerId),
        tail: DockerLogsSchema.shape.tail.parse(tail),
      }),
    ),
    runDockerAction: async (connection, containerId, action) => {
      await invoke('docker_action', {
        connection,
        containerId: DockerContainerIdSchema.parse(containerId),
        action: DockerActionSchema.parse(action),
      });
    },
    execDockerContainer: async (
      connection,
      containerId,
      shell,
      columns,
      rows,
    ) => TerminalSessionSchema.parse(
      await invoke('docker_exec', {
        connection,
        containerId: DockerContainerIdSchema.parse(containerId),
        shell: DockerShellSchema.parse(shell),
        columns,
        rows,
      }),
    ),
    monitorSnapshot: async (connection) => MonitorSnapshotSchema.parse(
      await invoke('monitor_snapshot', { connection }),
    ),
    subscribeConnectionState: async (handler) => listen('connection:state', (event) => {
      const parsed = ConnectionStateEventSchema.safeParse(event.payload);
      if (parsed.success) handler(parsed.data);
    }),
    subscribeTerminalData: async (handler) => listen('terminal:data', (event) => {
      const parsed = TerminalDataSchema.safeParse(event.payload);
      if (parsed.success) handler(parsed.data);
    }),
    subscribeTerminalGap: async (handler) => listen('terminal:gap', (event) => {
      const parsed = TerminalGapSchema.safeParse(event.payload);
      if (parsed.success) handler(parsed.data);
    }),
    subscribeTerminalClosed: async (handler) => listen('terminal:closed', (event) => {
      const parsed = TerminalClosedSchema.safeParse(event.payload);
      if (parsed.success) handler(parsed.data);
    }),
    previewSshConfigImport: async () => SshConfigImportPreviewSchema.parse(
      await invoke('ssh_config_import_preview'),
    ),
    applySshConfigImport: async (input) => SshConfigImportResultSchema.parse(
      await invoke('ssh_config_import_apply', {
        input: SshConfigImportApplyInputSchema.parse(input),
      }),
    ),
  };
}
