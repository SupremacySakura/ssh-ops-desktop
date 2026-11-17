import { invoke } from '@tauri-apps/api/core';
import {
  CoreHealthSchema,
  GroupInputSchema,
  GroupSchema,
  ServerCredentialInputSchema,
  ServerInputSchema,
  ServerSchema,
  SshConfigImportApplyInputSchema,
  SshConfigImportPreviewSchema,
  SshConfigImportResultSchema,
  type CoreHealth,
  type Group,
  type GroupInput,
  type Server,
  type ServerCredentialInput,
  type ServerInput,
  type SshConfigImportApplyInput,
  type SshConfigImportPreview,
  type SshConfigImportResult,
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
