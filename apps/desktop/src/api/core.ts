import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  ConnectOutcomeSchema,
  ConnectionStateEventSchema,
  CoreHealthSchema,
  GroupInputSchema,
  GroupSchema,
  ServerCredentialInputSchema,
  ServerInputSchema,
  ServerSchema,
  TerminalClosedSchema,
  TerminalDataSchema,
  TerminalGapSchema,
  TerminalSessionSchema,
  type ConnectOutcome,
  type ConnectionHandle,
  type ConnectionStateEvent,
  type CoreHealth,
  type Group,
  type GroupInput,
  type Server,
  type ServerCredentialInput,
  type ServerInput,
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
  subscribeConnectionState(handler: (event: ConnectionStateEvent) => void): Promise<UnlistenFn>;
  subscribeTerminalData(handler: (event: TerminalDataEvent) => void): Promise<UnlistenFn>;
  subscribeTerminalGap(handler: (event: TerminalGapEvent) => void): Promise<UnlistenFn>;
  subscribeTerminalClosed(handler: (event: TerminalClosedEvent) => void): Promise<UnlistenFn>;
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
  };
}
