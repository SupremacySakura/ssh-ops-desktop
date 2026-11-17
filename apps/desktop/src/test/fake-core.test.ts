import type {
  ConnectionHandle,
  DockerContainer,
  DockerLogs,
  MonitorSnapshot,
  RemoteFileEntry,
  Server,
  ServerInput,
} from '@opspilot/contracts';
import { describe, expect, it } from 'vitest';

import { createFakeCoreClient } from './fake-core';

const pendingServer: Server = {
  id: '019c62b2-2970-7000-8000-000000000050',
  name: 'pending',
  host: 'pending.example.com',
  port: 22,
  user: 'deploy',
  authType: 'key',
  secretRef: null,
  groupId: null,
  favorite: false,
  lastConnectedAt: null,
  createdAt: 1_700_000_000,
};

const input: ServerInput = {
  name: pendingServer.name,
  host: pendingServer.host,
  port: pendingServer.port,
  user: pendingServer.user,
  authType: 'password',
  groupId: null,
  favorite: false,
};
const connection: ConnectionHandle = {
  serverId: pendingServer.id,
  connectionId: '019c62b2-2970-7000-8000-000000000051',
};
const fileHash = '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03';
const fileEntry: RemoteFileEntry = {
  name: 'app.conf',
  path: '/srv/app.conf',
  kind: 'file',
  size: 6,
  modifiedAt: 42,
  permissions: 0o640,
};

const monitorSnapshot: MonitorSnapshot = {
  timestamp: '2026-11-17T12:34:56.789Z',
  cpuPercent: 42.5,
  memory: {
    totalBytes: 8_000,
    availableBytes: 3_000,
    usedBytes: 5_000,
  },
  disk: {
    filesystem: '/dev/vda1',
    totalBytes: 100_000,
    usedBytes: 40_000,
    availableBytes: 60_000,
    mountPoint: '/',
  },
  load: { one: 0.25, five: 0.5, fifteen: 0.75 },
  uptimeSeconds: 123_456,
  topProcesses: [],
  unavailable: [],
};

describe('FakeCoreClient security parity', () => {
  it('fails closed when a pending credential is connected', async () => {
    const core = createFakeCoreClient({ servers: [pendingServer] });

    await expect(core.connect(pendingServer.id)).rejects.toMatchObject({
      code: 'SECRET_UNAVAILABLE',
    });
  });

  it('requires a new credential when the authentication type changes', async () => {
    const core = createFakeCoreClient({
      servers: [{ ...pendingServer, secretRef: 'secret-ref-fixture' }],
    });

    await expect(core.updateServer(pendingServer.id, input)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('provides a conflict-safe in-memory file surface for UI tests', async () => {
    const core = createFakeCoreClient({
      files: {
        entriesByDirectory: {
          '/': [fileEntry],
        },
        documents: {
          [fileEntry.path]: {
            path: fileEntry.path,
            text: 'hello\n',
            sha256: fileHash,
            size: 6,
            modifiedAt: 42,
          },
        },
        downloads: {
          [fileEntry.path]: {
            path: fileEntry.path,
            bytes: [104, 101, 108, 108, 111, 10],
            sha256: fileHash,
          },
        },
      },
    });

    await expect(core.listFiles(connection, '/')).resolves.toEqual([fileEntry]);
    await expect(core.readFile(connection, fileEntry.path)).resolves.toMatchObject({
      text: 'hello\n',
      sha256: fileHash,
    });
    await expect(core.writeFile(
      connection,
      fileEntry.path,
      'draft\n',
      'a'.repeat(64),
    )).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(core.readFile(connection, fileEntry.path)).resolves.toMatchObject({
      text: 'hello\n',
    });

    const saved = await core.writeFile(
      connection,
      fileEntry.path,
      'next\n',
      fileHash,
    );
    await expect(core.readFile(connection, fileEntry.path)).resolves.toMatchObject({
      text: 'next\n',
      sha256: saved.sha256,
    });
    await expect(core.downloadFile(connection, fileEntry.path)).resolves.toMatchObject({
      bytes: [104, 101, 108, 108, 111, 10],
    });
  });

  it('serves monitor snapshots in order and records the active connection', async () => {
    const next = {
      ...monitorSnapshot,
      timestamp: '2026-11-17T12:34:58.789Z',
      cpuPercent: 50,
    };
    const core = createFakeCoreClient({
      monitorSnapshots: [monitorSnapshot, next],
    });

    await expect(core.monitorSnapshot(connection)).resolves.toEqual(monitorSnapshot);
    await expect(core.monitorSnapshot(connection)).resolves.toEqual(next);
    await expect(core.monitorSnapshot(connection)).resolves.toEqual(next);

    expect(core.calls.filter((call) => call.method === 'monitorSnapshot')).toHaveLength(3);
    expect(core.calls[0]).toEqual({
      method: 'monitorSnapshot',
      args: [connection],
    });
  });
});

describe('FakeCoreClient Docker parity', () => {
  const serverId = '019c62b2-2970-7000-8000-000000000003';
  const connection = {
    serverId,
    connectionId: '019c62b2-2970-7000-8000-000000000010',
  };
  const containerId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const container: DockerContainer = {
    id: containerId,
    names: ['web'],
    image: 'nginx:alpine',
    state: 'running',
    status: 'Up 3 hours',
    ports: ['8080->80/tcp'],
    startedAt: '2026-11-17T12:00:00Z',
  };
  const logs: DockerLogs = {
    containerId,
    tail: 500,
    stdout: 'request\n',
    stderr: 'warning\n',
  };

  it('lists, mutates, logs, and execs containers through the shared client', async () => {
    const core = createFakeCoreClient({
      dockerContainers: [container],
      dockerLogs: { [containerId]: logs },
    });

    await expect(core.listDockerContainers(connection)).resolves.toMatchObject({
      containers: [container],
      startedAtWarning: null,
    });
    await expect(core.getDockerLogs(connection, containerId, 500)).resolves.toEqual(logs);
    const session = await core.execDockerContainer(
      connection,
      containerId,
      'sh',
      120,
      40,
    );

    expect(session.connection).toEqual(connection);
    await core.runDockerAction(connection, containerId, 'stop');
    await expect(core.listDockerContainers(connection)).resolves.toMatchObject({
      containers: [{
        id: containerId,
        state: 'exited',
      }],
    });
    expect(core.calls).toContainEqual({
      method: 'runDockerAction',
      args: [connection, containerId, 'stop'],
    });
    expect(core.calls).toContainEqual({
      method: 'execDockerContainer',
      args: [connection, containerId, 'sh', 120, 40],
    });
  });

  it('reports a missing container instead of silently succeeding', async () => {
    const core = createFakeCoreClient({ dockerContainers: [] });

    await expect(core.runDockerAction(
      connection,
      containerId,
      'restart',
    )).rejects.toMatchObject({ code: 'DOCKER_CONTAINER_NOT_FOUND' });
    await expect(core.getDockerLogs(
      connection,
      containerId,
      500,
    )).rejects.toMatchObject({ code: 'DOCKER_CONTAINER_NOT_FOUND' });
  });
});

describe('FakeCoreClient file mutation parity', () => {
  it('uploads, creates directories, renames files, and deletes entries in memory', async () => {
    const core = createFakeCoreClient({
      files: {
        entriesByDirectory: {
          '/': [fileEntry],
        },
      },
    });

    const uploaded = await core.uploadFiles(connection, '/', [
      { name: 'one.txt', bytes: [111, 110, 101] },
      { name: 'two.txt', bytes: [116, 119, 111] },
    ]);
    expect(uploaded).toMatchObject({
      status: 'succeeded',
      committed: ['/one.txt', '/two.txt'],
      residual: [],
    });

    await expect(core.createDirectory(connection, '/new-folder')).resolves.toEqual({
      path: '/new-folder',
    });
    const renamed = await core.renameFile(
      connection,
      '/one.txt',
      '/renamed.txt',
    );
    expect(renamed).toEqual({
      status: 'renamed',
      sourcePath: '/one.txt',
      targetPath: '/renamed.txt',
    });
    await expect(core.deleteFile(connection, '/two.txt')).resolves.toEqual({
      path: '/two.txt',
    });

    const entries = await core.listFiles(connection, '/');
    expect(entries.map((entry) => entry.name)).toEqual([
      'new-folder',
      'app.conf',
      'renamed.txt',
    ]);
  });

  it('rejects an existing upload target without overwriting it', async () => {
    const core = createFakeCoreClient({
      files: {
        entriesByDirectory: {
          '/': [fileEntry],
        },
      },
    });

    const outcome = await core.uploadFiles(connection, '/', [
      { name: 'app.conf', bytes: [114, 101, 112, 108, 97, 99, 101, 109, 101, 110, 116] },
    ]);

    expect(outcome).toMatchObject({
      status: 'failed_rolled_back',
      committed: [],
      residual: [],
      error: { code: 'CONFLICT' },
    });
    await expect(core.listFiles(connection, '/')).resolves.toEqual([fileEntry]);
  });

  it('injects unsupported hardlinks, a kth commit failure, and rollback residue', async () => {
    const unsupported = createFakeCoreClient({
      files: { entriesByDirectory: { '/': [] } },
      fileFaults: { hardlinkUnsupported: true },
    });
    await expect(unsupported.uploadFiles(connection, '/', [
      { name: 'one.txt', bytes: [1] },
    ])).resolves.toMatchObject({
      status: 'failed_rolled_back',
      committed: [],
      residual: [],
      error: { code: 'CAPABILITY_UNAVAILABLE' },
    });

    const rolledBack = createFakeCoreClient({
      files: { entriesByDirectory: { '/': [] } },
      fileFaults: { failCommitAt: 2 },
    });
    await expect(rolledBack.uploadFiles(connection, '/', [
      { name: 'one.txt', bytes: [1] },
      { name: 'two.txt', bytes: [2] },
      { name: 'three.txt', bytes: [3] },
    ])).resolves.toMatchObject({
      status: 'failed_rolled_back',
      committed: [],
      residual: [],
      error: { code: 'CONFLICT' },
    });
    await expect(rolledBack.listFiles(connection, '/')).resolves.toEqual([]);

    const residue = createFakeCoreClient({
      files: { entriesByDirectory: { '/': [] } },
      fileFaults: { failCommitAt: 2, failRollback: true },
    });
    await expect(residue.uploadFiles(connection, '/', [
      { name: 'one.txt', bytes: [1] },
      { name: 'two.txt', bytes: [2] },
    ])).resolves.toMatchObject({
      status: 'failed_with_residue',
      committed: ['/one.txt'],
      residual: ['/one.txt'],
      error: { code: 'CONFLICT' },
    });
    await expect(residue.listFiles(connection, '/')).resolves.toMatchObject([
      { name: 'one.txt' },
    ]);
  });
});
