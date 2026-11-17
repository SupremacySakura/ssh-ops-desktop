import type {
  DockerContainer,
  DockerLogs,
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
