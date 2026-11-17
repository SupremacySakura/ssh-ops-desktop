import type {
  ConnectOutcome,
  DockerContainer,
  DockerLogs,
  Group,
  MonitorSnapshot,
  Server,
  SshConfigImportPreview,
} from '@opspilot/contracts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from '../../../../apps/desktop/src/App';
import '../../../../apps/desktop/src/styles.css';
import { useHarborStore } from '../../../../apps/desktop/src/store/harbor-store';
import { useTerminalStore } from '../../../../apps/desktop/src/store/terminal-store';
import {
  createFakeCoreClient,
  type FakeCoreClient,
  type FakeCorePersistence,
  type FakeFileSystem,
} from '../../../../apps/desktop/src/test/fake-core';
import { FIXTURE_METADATA_KEY } from './scenario-keys';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing #root element');
}

const dockerContainerId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

interface FixtureScenario {
  servers: Server[];
  groups: Group[];
  terminalEcho: boolean;
  terminalOsc7?: boolean;
  persistence?: FakeCorePersistence;
  dockerContainers: DockerContainer[];
  dockerLogs: Record<string, DockerLogs>;
  files?: FakeFileSystem;
  sshConfigImport?: SshConfigImportPreview;
  monitorSnapshots?: (
    connection: { serverId: string; connectionId: string },
    sequence: number,
  ) => MonitorSnapshot | Promise<MonitorSnapshot>;
  connectOutcome?: (serverId: string, attempt: number) => ConnectOutcome;
  overrides?: Partial<FakeCoreClient>;
}

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

const fixtureFiles: FakeFileSystem = {
  entriesByDirectory: {
    '/': [{
      name: 'etc',
      path: '/etc',
      kind: 'directory' as const,
      size: 0,
      modifiedAt: 1_700_000_000,
      permissions: 0o755,
    }, {
      name: 'app.conf',
      path: '/app.conf',
      kind: 'file' as const,
      size: 6,
      modifiedAt: 1_700_000_100,
      permissions: 0o640,
    }],
    '/etc': [{
      name: 'nginx.conf',
      path: '/etc/nginx.conf',
      kind: 'file' as const,
      size: 11,
      modifiedAt: 1_700_000_200,
      permissions: 0o644,
    }],
  },
  documents: {
    '/app.conf': {
      path: '/app.conf',
      text: 'hello\n',
      sha256: '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
      size: 6,
      modifiedAt: 1_700_000_100,
    },
  },
};

const fixtureContainers: DockerContainer[] = [{
  id: dockerContainerId,
  names: ['web'],
  image: 'nginx:alpine',
  state: 'running',
  status: 'Up 3 hours',
  ports: ['0.0.0.0:8080->80/tcp'],
  startedAt: '2026-11-17T12:00:00Z',
}];

const fixtureLogs: Record<string, DockerLogs> = {
  [dockerContainerId]: {
    containerId: dockerContainerId,
    tail: 500,
    stdout: 'request completed\n',
    stderr: 'warning from stderr\n',
  },
};

const importPreview: SshConfigImportPreview = {
  previewId: '019c62b2-2970-7000-8000-000000000150',
  sourcePath: '~/.ssh/config',
  items: [{
    id: '019c62b2-2970-7000-8000-000000000151',
    alias: 'imported-prod',
    host: 'imported.example.com',
    port: 2222,
    username: 'deploy',
    identityFile: '~/.ssh/id_ed25519',
    status: 'ready',
    unsupportedDirectives: [],
    warnings: [],
  }, {
    id: '019c62b2-2970-7000-8000-000000000152',
    alias: 'imported-staging',
    host: 'staging.example.com',
    port: 22,
    username: 'deploy',
    identityFile: null,
    status: 'ready',
    unsupportedDirectives: [],
    warnings: [],
  }, {
    id: '019c62b2-2970-7000-8000-000000000153',
    alias: 'imported-db',
    host: 'db.example.com',
    port: 22,
    username: 'dba',
    identityFile: null,
    status: 'ready',
    unsupportedDirectives: [],
    warnings: [],
  }, {
    id: '019c62b2-2970-7000-8000-000000000154',
    alias: 'race-existing',
    host: 'race-existing.example.com',
    port: 22,
    username: 'deploy',
    identityFile: null,
    status: 'ready',
    unsupportedDirectives: [],
    warnings: [],
  }, {
    id: '019c62b2-2970-7000-8000-000000000155',
    alias: 'already-here',
    host: 'already.example.com',
    port: 22,
    username: 'deploy',
    identityFile: null,
    status: 'existing',
    unsupportedDirectives: [],
    warnings: [],
  }],
  warnings: [],
  warningCount: 0,
  existingCount: 1,
  importableCount: 4,
};

const SCENARIOS: Record<string, FixtureScenario> = {
  default: scenarioDefaults(),
  terminal: {
    ...scenarioDefaults(),
    servers: terminalServers,
    terminalEcho: true,
  },
  files: {
    ...scenarioDefaults(),
    servers: terminalServers,
    files: fixtureFiles,
  },
  docker: {
    ...scenarioDefaults(),
    servers: terminalServers,
    dockerContainers: fixtureContainers,
    dockerLogs: fixtureLogs,
  },
  integration: {
    ...scenarioDefaults(),
    terminalEcho: true,
    terminalOsc7: true,
    files: fixtureFiles,
    dockerContainers: fixtureContainers,
    dockerLogs: fixtureLogs,
    monitorSnapshots: deterministicMonitorSnapshot,
  },
  keepalive: {
    ...scenarioDefaults(),
    servers: terminalServers,
    terminalEcho: true,
    files: fixtureFiles,
    dockerContainers: fixtureContainers,
    dockerLogs: fixtureLogs,
    monitorSnapshots: deterministicMonitorSnapshot,
  },
  'monitor-failure': {
    ...scenarioDefaults(),
    servers: terminalServers,
    monitorSnapshots: monitorFailureSnapshot,
  },
  'monitor-late': {
    ...scenarioDefaults(),
    servers: terminalServers,
    monitorSnapshots: lateMonitorSnapshot,
  },
  'files-conflict': {
    ...scenarioDefaults(),
    servers: terminalServers,
    files: fixtureFiles,
    overrides: {
      writeFile: async () => {
        throw {
          code: 'CONFLICT',
          message: '远程文件已在别处修改',
          retryable: false,
        };
      },
    },
  },
  import: {
    ...scenarioDefaults(),
    servers: [fixtureServer(
      '019c62b2-2970-7000-8000-000000000121',
      'race-existing',
      'race-existing.example.com',
    )],
    sshConfigImport: importPreview,
  },
  offline: {
    ...scenarioDefaults(),
    servers: [fixtureServer(
      '019c62b2-2970-7000-8000-000000000131',
      'offline-box',
      'offline-box.example.com',
    )],
    connectOutcome: () => {
      throw {
        code: 'SSH_CONNECTION',
        message: 'fixture offline',
        retryable: true,
      };
    },
  },
  empty: {
    ...scenarioDefaults(),
    servers: terminalServers,
    files: { entriesByDirectory: { '/': [] } },
  },
  persistence: {
    ...scenarioDefaults(),
    servers: terminalServers,
    groups: [{
      id: '019c62b2-2970-7000-8000-000000000141',
      name: '生产',
      sortOrder: 10,
    }],
    persistence: localStoragePersistence(),
  },
  'host-key': {
    ...scenarioDefaults(),
    servers: terminalServers,
    connectOutcome: hostKeyOutcome('hostKeyRequired'),
  },
  'host-key-changed': {
    ...scenarioDefaults(),
    servers: terminalServers,
    connectOutcome: hostKeyOutcome('hostKeyChanged'),
  },
};

function scenarioDefaults(): FixtureScenario {
  return {
    servers: [],
    groups: [],
    terminalEcho: false,
    dockerContainers: [],
    dockerLogs: {},
  };
}

function fixtureServer(id: string, name: string, host: string): Server {
  return {
    id,
    name,
    host,
    port: 22,
    user: 'deploy',
    authType: 'key',
    secretRef: 'secret-ref-fixture',
    groupId: null,
    favorite: false,
    lastConnectedAt: null,
    createdAt: 1_699_000_000,
  };
}

function hostKeyOutcome(kind: 'hostKeyRequired' | 'hostKeyChanged') {
  return (serverId: string, attempt: number): ConnectOutcome => {
    if (attempt === 1) {
      if (kind === 'hostKeyChanged') {
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
  };
}

function deterministicMonitorSnapshot(
  connection: { serverId: string; connectionId: string },
  sequence: number,
): MonitorSnapshot {
  const devBox = connection.serverId.endsWith('102');
  const cpuPercent = devBox ? 90 + (sequence % 3) : 24 + (sequence % 5) * 3;
  const usedBytes = devBox
    ? (12 + (sequence % 4) * 0.5) * 1024 ** 3
    : (8 + (sequence % 4) * 0.5) * 1024 ** 3;
  return {
    timestamp: new Date(Date.now() + sequence * 1_000).toISOString(),
    cpuPercent,
    memory: {
      totalBytes: 16 * 1024 ** 3,
      usedBytes,
      availableBytes: 8 * 1024 ** 3,
    },
    disk: {
      filesystem: '/dev/vda1',
      totalBytes: 100 * 1024 ** 3,
      usedBytes: 48 * 1024 ** 3,
      availableBytes: 52 * 1024 ** 3,
      mountPoint: '/',
    },
    load: { one: 0.42, five: 0.38, fifteen: 0.41 },
    uptimeSeconds: 2_004_000,
    topProcesses: [
      { pid: 101, user: 'deploy', name: 'cpu-heavy', cpuPercent: 64, memoryPercent: 4 },
      { pid: 102, user: 'postgres', name: 'mem-heavy', cpuPercent: 6, memoryPercent: 58 },
      { pid: 103, user: 'root', name: 'nginx', cpuPercent: 22, memoryPercent: 8 },
      { pid: 104, user: 'root', name: 'systemd', cpuPercent: 1, memoryPercent: 2 },
      { pid: 105, user: 'deploy', name: 'node', cpuPercent: 12, memoryPercent: 14 },
      { pid: 106, user: 'deploy', name: 'worker-1', cpuPercent: 3, memoryPercent: 6 },
      { pid: 107, user: 'deploy', name: 'worker-2', cpuPercent: 2, memoryPercent: 5 },
      { pid: 108, user: 'root', name: 'sshd', cpuPercent: 0.5, memoryPercent: 1 },
      { pid: 109, user: 'root', name: 'journald', cpuPercent: 0.4, memoryPercent: 1.5 },
      { pid: 110, user: 'deploy', name: 'cron', cpuPercent: 0.2, memoryPercent: 0.4 },
      { pid: 111, user: 'root', name: 'dockerd', cpuPercent: 0.8, memoryPercent: 3 },
      { pid: 112, user: 'root', name: 'containerd', cpuPercent: 0.6, memoryPercent: 2.5 },
    ],
    unavailable: [],
  };
}

function monitorFailureSnapshot(
  connection: { serverId: string; connectionId: string },
  sequence: number,
): MonitorSnapshot {
  if (sequence === 0) {
    throw {
      code: 'REMOTE_PERMISSION',
      message: 'fixture permission denied',
      retryable: false,
    };
  }
  return deterministicMonitorSnapshot(connection, sequence);
}

async function lateMonitorSnapshot(
  connection: { serverId: string; connectionId: string },
  sequence: number,
): Promise<MonitorSnapshot> {
  if (connection.serverId.endsWith('101') && sequence === 0) {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    return {
      ...deterministicMonitorSnapshot(connection, sequence),
      cpuPercent: 77,
    };
  }
  if (connection.serverId.endsWith('102')) {
    return {
      ...deterministicMonitorSnapshot(connection, sequence),
      cpuPercent: 91,
    };
  }
  return {
    ...deterministicMonitorSnapshot(connection, sequence),
    cpuPercent: 31,
  };
}

function localStoragePersistence(): FakeCorePersistence {
  const key = FIXTURE_METADATA_KEY;
  return {
    load: () => {
      try {
        const raw = window.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    save: (snapshot) => {
      window.localStorage.setItem(key, JSON.stringify(snapshot));
    },
  };
}

function boot() {
  const scenarioName = new URLSearchParams(window.location.search).get('scenario');
  const scenario = SCENARIOS[scenarioName ?? 'default'] ?? SCENARIOS.default;
  let attempts = 0;
  const core = createFakeCoreClient({
    health: {
      version: 'renderer-fixture',
      databaseReady: true,
      secretStoreReady: true,
    },
    servers: scenario.servers,
    groups: scenario.groups,
    terminalEcho: scenario.terminalEcho,
    terminalOsc7: scenario.terminalOsc7,
    persistence: scenario.persistence,
    dockerContainers: scenario.dockerContainers,
    dockerLogs: scenario.dockerLogs,
    files: scenario.files,
    sshConfigImport: scenario.sshConfigImport,
    monitorSnapshots: scenario.monitorSnapshots,
    overrides: scenario.overrides,
    connectOutcome: scenario.connectOutcome
      ? (serverId) => {
          attempts += 1;
          return scenario.connectOutcome!(serverId, attempts);
        }
      : undefined,
  });

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

  createRoot(root!).render(
    <StrictMode>
      <App core={core} />
    </StrictMode>,
  );
}

boot();
