import type {
  DockerContainer,
  DockerLogs,
} from '@opspilot/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import type { CoreClient } from '../api/core';
import { createFakeCoreClient } from '../test/fake-core';
import { dockerErrorMessage, useDockerStore } from './docker-store';

const serverId = '019c62b2-2970-7000-8000-000000000003';
const connection = {
  serverId,
  connectionId: '019c62b2-2970-7000-8000-000000000010',
};
const nextConnection = {
  serverId,
  connectionId: '019c62b2-2970-7000-8000-000000000011',
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

beforeEach(() => {
  useDockerStore.getState().reset();
});

describe('Docker store', () => {
  it('loads isolated container state per server and opens logs', async () => {
    const core = createFakeCoreClient({
      dockerContainers: [container],
      dockerLogs: { [containerId]: logs },
    });
    useDockerStore.getState().setCore(core);
    const otherServerId = '019c62b2-2970-7000-8000-000000000004';
    const otherConnection = {
      serverId: otherServerId,
      connectionId: '019c62b2-2970-7000-8000-000000000012',
    };

    await useDockerStore.getState().loadContainers(serverId, connection);
    await useDockerStore.getState().loadContainers(otherServerId, otherConnection);

    expect(useDockerStore.getState().states[serverId]).toMatchObject({
      connectionId: connection.connectionId,
      status: 'ready',
      containers: [container],
      error: null,
    });
    expect(useDockerStore.getState().states[otherServerId]).toMatchObject({
      connectionId: otherConnection.connectionId,
      status: 'ready',
      containers: [container],
    });

    await useDockerStore.getState().openLogs(
      serverId,
      connection,
      container,
      500,
    );
    expect(useDockerStore.getState().states[serverId]?.logs).toMatchObject({
      containerId,
      containerName: 'web',
      tail: 500,
      status: 'ready',
      stdout: logs.stdout,
      stderr: logs.stderr,
    });

    useDockerStore.getState().closeLogs(serverId);
    expect(useDockerStore.getState().states[serverId]?.logs).toBeNull();
  });

  it('drops a late response from an older connection', async () => {
    const oldList = deferred<Awaited<ReturnType<CoreClient['listDockerContainers']>>>();
    const newList = deferred<Awaited<ReturnType<CoreClient['listDockerContainers']>>>();
    const core = createFakeCoreClient({
      overrides: {
        listDockerContainers: (requestedConnection) => (
          requestedConnection.connectionId === connection.connectionId
            ? oldList.promise
            : newList.promise
        ),
      },
    });
    useDockerStore.getState().setCore(core);

    const older = useDockerStore.getState().loadContainers(serverId, connection);
    const newer = useDockerStore.getState().loadContainers(serverId, nextConnection);
    newList.resolve({
      containers: [{ ...container, names: ['new'], state: 'exited' }],
      startedAtWarning: null,
    });
    await newer;
    oldList.resolve({
      containers: [{ ...container, names: ['old'] }],
      startedAtWarning: null,
    });
    await older;

    expect(useDockerStore.getState().states[serverId]).toMatchObject({
      connectionId: nextConnection.connectionId,
      containers: [{ names: ['new'], state: 'exited' }],
    });
  });

  it('keeps a late response scoped to its own server after switching workspaces', async () => {
    const otherServerId = '019c62b2-2970-7000-8000-000000000005';
    const otherConnection = {
      serverId: otherServerId,
      connectionId: '019c62b2-2970-7000-8000-000000000013',
    };
    const firstList = deferred<Awaited<ReturnType<CoreClient['listDockerContainers']>>>();
    const secondList = deferred<Awaited<ReturnType<CoreClient['listDockerContainers']>>>();
    const core = createFakeCoreClient({
      overrides: {
        listDockerContainers: (requestedConnection) => (
          requestedConnection.serverId === serverId
            ? firstList.promise
            : secondList.promise
        ),
      },
    });
    useDockerStore.getState().setCore(core);

    const first = useDockerStore.getState().loadContainers(serverId, connection);
    const second = useDockerStore.getState().loadContainers(
      otherServerId,
      otherConnection,
    );
    secondList.resolve({
      containers: [{ ...container, names: ['second-server'] }],
      startedAtWarning: null,
    });
    await second;
    firstList.resolve({
      containers: [{ ...container, names: ['first-server'] }],
      startedAtWarning: null,
    });
    await first;

    expect(useDockerStore.getState().states[otherServerId]).toMatchObject({
      connectionId: otherConnection.connectionId,
      containers: [{ names: ['second-server'] }],
    });
    expect(useDockerStore.getState().states[serverId]).toMatchObject({
      connectionId: connection.connectionId,
      containers: [{ names: ['first-server'] }],
    });
  });

  it('keeps the previous list and reports a refresh failure after a successful action', async () => {
    let listCalls = 0;
    const core = createFakeCoreClient({
      dockerContainers: [container],
      overrides: {
        listDockerContainers: async () => {
          listCalls += 1;
          if (listCalls === 1) {
            return { containers: [container], startedAtWarning: null };
          }
          throw {
            code: 'SSH_CONNECTION',
            message: 'fixture connection lost',
            retryable: true,
          };
        },
      },
    });
    useDockerStore.getState().setCore(core);
    await useDockerStore.getState().loadContainers(serverId, connection);

    await useDockerStore.getState().runDockerAction(
      serverId,
      connection,
      container,
      'restart',
    );

    expect(useDockerStore.getState().states[serverId]).toMatchObject({
      status: 'ready',
      containers: [container],
      action: null,
      notice: '操作已完成、刷新失败',
      error: {
        code: 'SSH_CONNECTION',
      },
    });
    expect(core.calls).toContainEqual({
      method: 'runDockerAction',
      args: [connection, containerId, 'restart'],
    });
  });

  it('maps stable Docker error codes to actionable Chinese messages', () => {
    expect(dockerErrorMessage({
      code: 'DOCKER_NOT_INSTALLED',
      message: 'docker missing',
      retryable: false,
    })).toContain('未检测到 Docker CLI');
    expect(dockerErrorMessage({
      code: 'DOCKER_PERMISSION_DENIED',
      message: 'permission denied',
      retryable: false,
    })).toContain('Docker socket');
    expect(dockerErrorMessage({
      code: 'DOCKER_DAEMON_UNAVAILABLE',
      message: 'daemon unavailable',
      retryable: true,
    })).toContain('daemon 未运行');
    expect(dockerErrorMessage({
      code: 'DOCKER_SHELL_UNAVAILABLE',
      message: 'shell unavailable',
      retryable: false,
    })).toContain('sh、bash 或 ash');
    expect(dockerErrorMessage({
      code: 'REMOTE_COMMAND',
      message: 'Error response from daemon: container is not running',
      retryable: false,
    })).toBe('容器未运行，无法执行该操作');
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
