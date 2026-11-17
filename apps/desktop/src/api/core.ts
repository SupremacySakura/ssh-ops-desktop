import { invoke } from '@tauri-apps/api/core';
import { CoreHealthSchema, type CoreHealth } from '@opspilot/contracts';

export interface CoreClient {
  health(): Promise<CoreHealth>;
}

export function createTauriCoreClient(): CoreClient {
  return {
    health: async () => CoreHealthSchema.parse(await invoke('core_health')),
  };
}
