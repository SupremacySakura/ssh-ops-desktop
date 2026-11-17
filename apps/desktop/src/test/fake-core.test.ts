import type {
  ConnectionHandle,
  DockerContainer,
  DockerLogs,
  MonitorSnapshot,
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
