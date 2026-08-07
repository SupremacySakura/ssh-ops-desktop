import { invoke } from '@tauri-apps/api/core';

export interface CoreHealth {
  version: string;
  databaseReady: boolean;
  secretStoreReady: boolean;
}

export interface CoreClient {
  health(): Promise<CoreHealth>;
}

export function createTauriCoreClient(): CoreClient {
  return {
    health: () => invoke<CoreHealth>('core_health'),
  };
}
