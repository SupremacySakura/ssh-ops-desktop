import { close, open } from 'node:fs';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { LibSQLStore } from '@mastra/libsql';

let workflowStorage: LibSQLStore | undefined;

export async function initializePrivateStorage(storagePath: string): Promise<void> {
  if (storagePath.trim().length === 0 || storagePath.includes('\0')) {
    throw new Error('invalid Agent storage path');
  }
  await mkdir(dirname(storagePath), { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    open(storagePath, 'a', 0o600, (openError, descriptor) => {
      if (openError !== null) {
        reject(openError);
        return;
      }
      close(descriptor, (closeError) => closeError === null ? resolve() : reject(closeError));
    });
  });
  workflowStorage = new LibSQLStore({
    id: 'opspilot-agent-workflows',
    url: `file:${storagePath}`,
  });
  await workflowStorage.init();
}

export function getWorkflowStorage(): LibSQLStore {
  if (!workflowStorage) throw new Error('Agent workflow storage is not initialized');
  return workflowStorage;
}
