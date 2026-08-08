import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  ApprovalRequestSchema,
  type AuditRecord,
  type ApprovalProof,
  type ApprovalRequest,
  type ConnectOutcome,
  type ConnectionRequest,
  type ConnectionHandle,
  type FileListRequest,
  type FileDownloadRequest,
  type FileReadRequest,
  type DockerContainer,
  type DockerStats,
  type DockerVersion,
  AgentRunStartInput,
  AgentRunSummary,
  AgentThreadSummary,
  AgentToolDescriptor,
  ModelProfileInput,
  ModelProfileSummary,
  type LinuxMetrics,
  type ListeningPort,
  type OperationPrepareResult,
  type OperationTaskRef,
  ProjectSummary,
  type ProjectDetection,
  type ProjectInput,
  type RemoteFileContent,
  type RemoteFileDownload,
  type RemoteFileEntry,
  ServerSummary,
  type ServerCredentialSetRequest,
  type ServerDeleteRequest,
  type ServerGroup,
  type ServerGroupInput,
  type ServerImportApplyRequest,
  type ServerImportApplyResult,
  type ServerImportPreview,
  type ServerImportPreviewRequest,
  type ServerInput,
  TerminalDataEventSchema,
  type TerminalDataEvent,
  type TerminalSession,
  type TaskEvent,
  type SystemService,
  type OsRelease,
  ToolCall,
} from '@opspilot/contracts';

export interface CoreHealth {
  version: string;
  databaseReady: boolean;
  secretStoreReady: boolean;
}

export interface AgentAvailability {
  agentAvailable: boolean;
  reason?: string;
}

export interface CoreClient {
  health(): Promise<CoreHealth>;
  servers?(): Promise<ServerSummary[]>;
  createServer?(input: ServerInput): Promise<ServerSummary>;
  updateServer?(serverId: string, input: ServerInput): Promise<ServerSummary>;
  deleteServer?(request: ServerDeleteRequest): Promise<void>;
  setServerCredential?(request: ServerCredentialSetRequest): Promise<void>;
  serverGroups?(): Promise<ServerGroup[]>;
  createServerGroup?(input: ServerGroupInput): Promise<ServerGroup>;
  previewServerImport?(request: ServerImportPreviewRequest): Promise<ServerImportPreview>;
  applyServerImport?(request: ServerImportApplyRequest): Promise<ServerImportApplyResult>;
  connect?(request: ConnectionRequest): Promise<ConnectOutcome>;
  trustHostKey?(serverId: string, verificationId: string): Promise<void>;
  openTerminal?(connection: ConnectionHandle, columns: number, rows: number): Promise<TerminalSession>;
  writeTerminal?(terminalSessionId: string, bytes: number[]): Promise<void>;
  resizeTerminal?(terminalSessionId: string, columns: number, rows: number): Promise<void>;
  closeTerminal?(terminalSessionId: string): Promise<void>;
  subscribeTerminalData?(handler: (event: TerminalDataEvent) => void): Promise<() => void>;
  subscribeTerminalGap?(handler: (missed: number) => void): Promise<() => void>;
  listFiles?(request: FileListRequest): Promise<RemoteFileEntry[]>;
  readFile?(request: FileReadRequest): Promise<RemoteFileContent>;
  downloadFile?(request: FileDownloadRequest): Promise<RemoteFileDownload>;
  systemProbe?(connection: ConnectionHandle): Promise<OsRelease>;
  systemMetrics?(connection: ConnectionHandle): Promise<LinuxMetrics>;
  systemPorts?(connection: ConnectionHandle): Promise<ListeningPort[]>;
  systemServices?(connection: ConnectionHandle): Promise<SystemService[]>;
  dockerVersion?(connection: ConnectionHandle): Promise<DockerVersion>;
  dockerContainers?(connection: ConnectionHandle, includeStopped: boolean): Promise<DockerContainer[]>;
  dockerLogs?(connection: ConnectionHandle, container: string, tail: number): Promise<string>;
  dockerStats?(connection: ConnectionHandle, container: string): Promise<DockerStats>;
  openDockerExec?(connection: ConnectionHandle, container: string, columns: number, rows: number): Promise<TerminalSession>;
  nginxDiscover?(connection: ConnectionHandle): Promise<string>;
  nginxRead?(connection: ConnectionHandle, path: string): Promise<number[]>;
  detectProject?(connection: ConnectionHandle, rootPath: string): Promise<ProjectDetection>;
  createProject?(input: ProjectInput): Promise<ProjectSummary>;
  tasks?(limit?: number): Promise<TaskEvent[]>;
  audits?(limit?: number): Promise<AuditRecord[]>;
  projects?(serverId: string): Promise<ProjectSummary[]>;
  agentStatus?(): Promise<AgentAvailability>;
  agentThreads?(): Promise<AgentThreadSummary[]>;
  modelProfiles?(): Promise<ModelProfileSummary[]>;
  saveModelProfile?(input: ModelProfileInput): Promise<ModelProfileSummary>;
  deleteModelProfile?(profileId: string): Promise<void>;
  testModelProfile?(profileId: string): Promise<void>;
  agentCatalog?(): Promise<AgentToolDescriptor[]>;
  createAgentThread?(title: string): Promise<AgentThreadSummary>;
  startAgentRun?(input: AgentRunStartInput): Promise<AgentRunSummary>;
  subscribeAgentApproval?(handler: (request: ApprovalRequest) => void): Promise<() => void>;
  approveOperation?(proof: ApprovalProof): Promise<OperationTaskRef>;
  rejectOperation?(approvalId: string): Promise<void>;
  prepareOperation?(call: ToolCall): Promise<OperationPrepareResult>;
}

export function createTauriCoreClient(): CoreClient {
  return {
    health: () => invoke<CoreHealth>('core_health'),
    servers: () => invoke<ServerSummary[]>('server_list'),
    createServer: (input) => invoke<ServerSummary>('server_create', { input }),
    updateServer: (serverId, input) => invoke<ServerSummary>('server_update', { serverId, input }),
    deleteServer: (request) => invoke('server_delete', { request }),
    setServerCredential: (request) => invoke('server_credential_set', { request }),
    serverGroups: () => invoke<ServerGroup[]>('server_group_list'),
    createServerGroup: (input) => invoke<ServerGroup>('server_group_create', { input }),
    previewServerImport: (request) => invoke<ServerImportPreview>('server_import_preview', { request }),
    applyServerImport: (request) => invoke<ServerImportApplyResult>('server_import_apply', { request }),
    connect: (request) => invoke<ConnectOutcome>('connection_connect', { request }),
    trustHostKey: (serverId, verificationId) => invoke('connection_trust_host_key', {
      request: { serverId, verificationId },
    }),
    openTerminal: (connection, columns, rows) => invoke<TerminalSession>('terminal_open', {
      request: { connection, columns, rows },
    }),
    writeTerminal: (terminalSessionId, bytes) => invoke('terminal_write', {
      request: { terminalSessionId, bytes },
    }),
    resizeTerminal: (terminalSessionId, columns, rows) => invoke('terminal_resize', {
      request: { terminalSessionId, columns, rows },
    }),
    closeTerminal: (terminalSessionId) => invoke('terminal_close', { terminalSessionId }),
    subscribeTerminalData: async (handler) => listen('terminal:data', (event) => {
      const parsed = TerminalDataEventSchema.safeParse(event.payload);
      if (parsed.success) handler(parsed.data);
    }),
    subscribeTerminalGap: async (handler) => listen<{ missed: number }>('terminal:gap', (event) => {
      if (Number.isSafeInteger(event.payload?.missed) && event.payload.missed > 0) handler(event.payload.missed);
    }),
    listFiles: (request) => invoke<RemoteFileEntry[]>('file_list', { request }),
    readFile: (request) => invoke<RemoteFileContent>('file_read', { request }),
    downloadFile: (request) => invoke<RemoteFileDownload>('file_download', { request }),
    systemProbe: (connection) => invoke<OsRelease>('system_probe', { connection }),
    systemMetrics: (connection) => invoke<LinuxMetrics>('system_metrics', { connection }),
    systemPorts: (connection) => invoke<ListeningPort[]>('system_ports', { connection }),
    systemServices: (connection) => invoke<SystemService[]>('system_services', { connection }),
    dockerVersion: (connection) => invoke<DockerVersion>('docker_version', { connection }),
    dockerContainers: (connection, includeStopped) => invoke<DockerContainer[]>('docker_container_list', {
      request: { connection, includeStopped },
    }),
    dockerLogs: (connection, container, tail) => invoke<string>('docker_container_logs', {
      request: { connection, container, tail },
    }),
    dockerStats: (connection, container) => invoke<DockerStats>('docker_container_stats', {
      request: { connection, container },
    }),
    openDockerExec: (connection, container, columns, rows) => invoke<TerminalSession>('docker_container_exec', {
      request: { connection, container, columns, rows },
    }),
    nginxDiscover: (connection) => invoke<string>('nginx_discover', { connection }),
    nginxRead: (connection, path) => invoke<number[]>('nginx_read', { request: { connection, path } }),
    detectProject: (connection, rootPath) => invoke<ProjectDetection>('project_detect', {
      request: { connection, rootPath },
    }),
    createProject: (request) => invoke<ProjectSummary>('project_create', { request }),
    tasks: (limit) => invoke<TaskEvent[]>('task_list', { limit }),
    audits: (limit) => invoke<AuditRecord[]>('audit_list', { limit }),
    projects: (serverId) => invoke<ProjectSummary[]>('project_list', { serverId }),
    agentStatus: () => invoke<AgentAvailability>('agent_status'),
    agentThreads: () => invoke<AgentThreadSummary[]>('agent_thread_list'),
    modelProfiles: () => invoke<ModelProfileSummary[]>('model_profile_list'),
    saveModelProfile: (request) => invoke<ModelProfileSummary>('model_profile_save', { request }),
    deleteModelProfile: (profileId) => invoke('model_profile_delete', { profileId }),
    testModelProfile: (profileId) => invoke('model_profile_test_connection', { profileId }),
    agentCatalog: () => invoke<AgentToolDescriptor[]>('agent_catalog'),
    createAgentThread: (title) => invoke<AgentThreadSummary>('agent_thread_create', { title }),
    startAgentRun: (request) => invoke<AgentRunSummary>('agent_run_start', { request }),
    subscribeAgentApproval: async (handler) => listen('agent:approval_required', (event) => {
      const parsed = ApprovalRequestSchema.safeParse(event.payload);
      if (parsed.success) handler(parsed.data);
    }),
    approveOperation: (proof) => invoke<OperationTaskRef>('operation_approve', { proof }),
    rejectOperation: (approvalId) => invoke('operation_reject', { approvalId }),
    prepareOperation: (call) => invoke<OperationPrepareResult>('operation_prepare', { call }),
  };
}
