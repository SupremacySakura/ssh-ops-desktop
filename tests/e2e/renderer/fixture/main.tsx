import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from '../../../../apps/desktop/src/App';
import '../../../../apps/desktop/src/styles.css';
import { createFakeCoreClient } from '../../../../apps/desktop/src/test/fake-core';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing #root element');
}

const core = createFakeCoreClient({
  health: {
    version: 'renderer-fixture',
    databaseReady: true,
    secretStoreReady: true,
  },
  sshConfigImport: {
    previewId: '019c62b2-2970-7000-8000-000000000010',
    sourcePath: '~/.ssh/config',
    items: [{
      id: '019c62b2-2970-7000-8000-000000000011',
      alias: 'imported-prod',
      host: 'imported.example.com',
      port: 2222,
      username: 'deploy',
      identityFile: '~/.ssh/id_ed25519',
      status: 'ready',
      unsupportedDirectives: [],
      warnings: [],
    }, {
      id: '019c62b2-2970-7000-8000-000000000012',
      alias: 'existing',
      host: 'existing.example.com',
      port: 22,
      username: 'deploy',
      identityFile: null,
      status: 'existing',
      unsupportedDirectives: [],
      warnings: [],
    }, {
      id: '019c62b2-2970-7000-8000-000000000013',
      alias: 'imported-copy',
      host: 'imported.example.com',
      port: 2222,
      username: 'deploy',
      identityFile: null,
      status: 'duplicateInBatch',
      unsupportedDirectives: [],
      warnings: [],
    }, {
      id: '019c62b2-2970-7000-8000-000000000014',
      alias: 'proxied',
      host: 'proxied.example.com',
      port: 22,
      username: 'deploy',
      identityFile: null,
      status: 'unsupported',
      unsupportedDirectives: ['ProxyJump'],
      warnings: ['第 8 行：ProxyJump 暂不支持；该 Host 已停用，避免按错误路径直连。'],
    }],
    warnings: [],
    warningCount: 0,
    existingCount: 1,
    importableCount: 1,
  },
});

createRoot(root).render(
  <StrictMode>
    <App core={core} />
  </StrictMode>,
);
