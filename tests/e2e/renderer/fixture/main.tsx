import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from '../../../../apps/desktop/src/App';
import '../../../../apps/desktop/src/styles.css';
import { useHarborStore } from '../../../../apps/desktop/src/store/harbor-store';
import { useTerminalStore } from '../../../../apps/desktop/src/store/terminal-store';
import {
  createFakeCoreClient,
  type FakeCoreClient,
} from '../../../../apps/desktop/src/test/fake-core';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing #root element');
}

const scenario = new URLSearchParams(window.location.search).get('scenario');
const terminalServers = [
  fixtureServer(
    '019c62b2-2970-7000-8000-000000000101',
    'prod-web-01',
    'prod-web-01.example.com',
  ),
  fixtureServer(
    '019c62b2-2970-7000-8000-000000000102',
    'dev-box',
    'dev-box.example.com',
  ),
];
let attempts = 0;
let emitTerminalData: FakeCoreClient['emitTerminalData'] | null = null;
const terminalSequences = new Map<string, number>();
const core = createFakeCoreClient({
  health: {
    version: 'renderer-fixture',
    databaseReady: true,
    secretStoreReady: true,
  },
  servers: scenario === 'terminal'
    || scenario === 'host-key'
    || scenario === 'host-key-changed'
    ? terminalServers
    : [],
  connectOutcome: scenario === 'host-key' || scenario === 'host-key-changed'
    ? (serverId) => {
        attempts += 1;
        if (attempts === 1) {
          if (scenario === 'host-key-changed') {
            return {
              kind: 'hostKeyChanged',
              prompt: {
                verificationId: '019c62b2-2970-7000-8000-000000000203',
                expectedSha256: 'SHA256:rendererFixtureOldHostKey',
                actualSha256: 'SHA256:rendererFixtureNewHostKey',
                expiresAt: '2026-11-17T13:05:00.000Z',
              },
            };
          }
          return {
            kind: 'hostKeyRequired',
            prompt: {
              verificationId: '019c62b2-2970-7000-8000-000000000201',
              algorithm: 'ssh-ed25519',
              sha256: 'SHA256:rendererFixtureHostKey',
              expiresAt: '2026-11-17T13:05:00.000Z',
            },
          };
        }
        return {
          kind: 'ready',
          connection: {
            serverId,
            connectionId: '019c62b2-2970-7000-8000-000000000202',
          },
        };
      }
    : undefined,
  overrides: scenario === 'terminal'
    ? {
        writeTerminal: async (terminalSessionId, bytes) => {
          const sequence = (terminalSequences.get(terminalSessionId) ?? 1) + 1;
          terminalSequences.set(terminalSessionId, sequence);
          emitTerminalData?.({
            terminalSessionId,
            sequence,
            bytes: ptyEchoBytes(bytes),
          });
        },
      }
    : undefined,
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
emitTerminalData = core.emitTerminalData;

(window as unknown as {
  __harborRuntime: {
    core: FakeCoreClient;
    terminalStore: typeof useTerminalStore;
    harborStore: typeof useHarborStore;
    disconnectFirstSession(): void;
  };
}).__harborRuntime = {
  core,
  terminalStore: useTerminalStore,
  harborStore: useHarborStore,
  disconnectFirstSession: () => {
    const session = Object.values(useTerminalStore.getState().runtimes)
      .flatMap((runtime) => runtime.sessions)
      .find((candidate) => candidate.status === 'open');
    if (!session) return;
    core.emitTerminalClosed({
      terminalSessionId: session.id,
      reason: 'disconnected',
    });
  },
};

createRoot(root).render(
  <StrictMode>
    <App core={core} />
  </StrictMode>,
);

function fixtureServer(id: string, name: string, host: string) {
  return {
    id,
    name,
    host,
    port: 22,
    user: 'deploy',
    authType: 'key' as const,
    secretRef: 'secret-ref-fixture',
    groupId: null,
    favorite: false,
    lastConnectedAt: null,
    createdAt: 1_699_000_000,
  };
}

function ptyEchoBytes(bytes: Uint8Array): number[] {
  const normalized = new TextDecoder()
    .decode(bytes)
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\n', '\r\n');
  return Array.from(new TextEncoder().encode(normalized));
}
