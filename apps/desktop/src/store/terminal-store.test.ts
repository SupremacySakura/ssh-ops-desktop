import type {
  ConnectOutcome,
  ConnectionStateEvent,
  Server,
} from '@opspilot/contracts';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFakeCoreClient } from '../test/fake-core';
import {
  attachTerminalEvents,
  connectionErrorMessage,
  MAX_TERMINAL_SESSIONS,
  subscribeTerminalOutput,
  useTerminalStore,
} from './terminal-store';

const server: Server = {
  id: '019c62b2-2970-7000-8000-000000000003',
  name: 'prod-web-01',
  host: 'prod.example.com',
  port: 22,
  user: 'deploy',
  authType: 'key',
  secretRef: 'secret-ref-fixture',
  groupId: null,
  favorite: false,
  lastConnectedAt: null,
  createdAt: 1_700_000_000,
};

let unlisten: UnlistenFn | null = null;

beforeEach(() => {
  useTerminalStore.getState().reset();
});

afterEach(() => {
  unlisten?.();
  unlisten = null;
  useTerminalStore.getState().reset();
});

describe('terminal workspace store', () => {
  it('subscribes before opening and delivers terminal data that races the open response', async () => {
    const core = createFakeCoreClient({ servers: [server] });
    unlisten = await attachTerminalEvents(core);
    expect(useTerminalStore.getState().eventBridgeStatus).toBe('ready');

    await useTerminalStore.getState().connectServer(server.id);

    const runtime = useTerminalStore.getState().runtimes[server.id];
    expect(runtime?.status).toBe('ready');
    expect(runtime?.sessions).toHaveLength(1);
    const session = runtime?.sessions[0];
    expect(session?.lastSequence).toBe(1);
    expect(session?.gap).toBe(false);

    const chunks: Uint8Array[] = [];
    const unsubscribe = subscribeTerminalOutput(session?.id as string, (chunk) => {
      chunks.push(chunk);
    });
    expect(new TextDecoder().decode(chunks[0])).toBe('harbor renderer fixture\r\n');
    unsubscribe();
  });

  it('replays retained output when an xterm viewport remounts in Strict Mode', async () => {
    const core = createFakeCoreClient({ servers: [server] });
    unlisten = await attachTerminalEvents(core);
    await useTerminalStore.getState().connectServer(server.id);
    const session = useTerminalStore.getState().runtimes[server.id]?.sessions[0];

    const firstMount: Uint8Array[] = [];
    const unsubscribeFirst = subscribeTerminalOutput(
      session?.id as string,
      (chunk) => firstMount.push(chunk),
    );
    unsubscribeFirst();
    const secondMount: Uint8Array[] = [];
    const unsubscribeSecond = subscribeTerminalOutput(
      session?.id as string,
      (chunk) => secondMount.push(chunk),
    );

    expect(new TextDecoder().decode(firstMount[0])).toBe(
      'harbor renderer fixture\r\n',
    );
    expect(new TextDecoder().decode(secondMount[0])).toBe(
      'harbor renderer fixture\r\n',
    );
    unsubscribeSecond();
  });

  it('isolates sequences and gap state per terminal session', async () => {
    const core = createFakeCoreClient({ servers: [server] });
    unlisten = await attachTerminalEvents(core);
    await useTerminalStore.getState().connectServer(server.id);
    const first = useTerminalStore.getState().runtimes[server.id]?.sessions[0];
    const second = await useTerminalStore.getState().openSession(server.id);

    core.emitTerminalData({
      terminalSessionId: first?.id as string,
      sequence: 2,
      bytes: [65],
    });
    core.emitTerminalGap({
      terminalSessionId: second?.id as string,
      missed: 2,
    });
    core.emitTerminalData({
      terminalSessionId: second?.id as string,
      sequence: 2,
      bytes: [66],
    });
    core.emitTerminalData({
      terminalSessionId: second?.id as string,
      sequence: 1,
      bytes: [67],
    });

    const runtime = useTerminalStore.getState().runtimes[server.id];
    const firstAfter = runtime?.sessions.find((session) => session.id === first?.id);
    const secondAfter = runtime?.sessions.find((session) => session.id === second?.id);
    expect(firstAfter?.lastSequence).toBe(2);
    expect(firstAfter?.gap).toBe(false);
    expect(secondAfter?.lastSequence).toBe(2);
    expect(secondAfter?.gap).toBe(true);
  });

  it('enforces the eight-session limit before asking Core for another channel', async () => {
    const core = createFakeCoreClient({ servers: [server] });
    unlisten = await attachTerminalEvents(core);
    await useTerminalStore.getState().connectServer(server.id);

    for (let index = 1; index < MAX_TERMINAL_SESSIONS; index += 1) {
      await expect(useTerminalStore.getState().openSession(server.id)).resolves.not.toBeNull();
    }
    const extra = await useTerminalStore.getState().openSession(server.id);

    expect(extra).toBeNull();
    expect(
      useTerminalStore.getState().runtimes[server.id]?.sessions,
    ).toHaveLength(MAX_TERMINAL_SESSIONS);
    expect(
      core.calls.filter((call) => call.method === 'openTerminal'),
    ).toHaveLength(MAX_TERMINAL_SESSIONS);
    expect(useTerminalStore.getState().runtimes[server.id]?.error).toContain('最多');
  });

  it('blocks on an unknown host key until explicit trust and then retries', async () => {
    let attempt = 0;
    const outcomes: ConnectOutcome[] = [
      {
        kind: 'hostKeyRequired',
        prompt: {
          verificationId: '019c62b2-2970-7000-8000-000000000020',
          algorithm: 'ssh-ed25519',
          sha256: 'SHA256:fixture',
          expiresAt: '2026-01-01T00:00:00.000Z',
        },
      },
      {
        kind: 'ready',
        connection: {
          serverId: server.id,
          connectionId: '019c62b2-2970-7000-8000-000000000021',
        },
      },
    ];
    const core = createFakeCoreClient({
      servers: [server],
      connectOutcome: () => outcomes[attempt++] as ConnectOutcome,
    });
    unlisten = await attachTerminalEvents(core);

    await useTerminalStore.getState().connectServer(server.id);
    const blocked = useTerminalStore.getState().runtimes[server.id];
    expect(blocked?.status).toBe('host-key');
    expect(blocked?.hostKeyPrompt?.sha256).toBe('SHA256:fixture');
    expect(blocked?.sessions).toHaveLength(0);

    await useTerminalStore.getState().trustHostKey(server.id);

    const connected = useTerminalStore.getState().runtimes[server.id];
    expect(connected?.status).toBe('ready');
    expect(connected?.sessions).toHaveLength(1);
    expect(core.calls).toContainEqual({
      method: 'trustHostKey',
      args: [server.id, '019c62b2-2970-7000-8000-000000000020'],
    });
  });

  it('turns a dismissed host-key prompt into a retryable stopped connection', async () => {
    let attempt = 0;
    const core = createFakeCoreClient({
      servers: [server],
      connectOutcome: () => {
        attempt += 1;
        if (attempt === 1) {
          return {
            kind: 'hostKeyRequired',
            prompt: {
              verificationId: '019c62b2-2970-7000-8000-000000000020',
              algorithm: 'ssh-ed25519',
              sha256: 'SHA256:fixture',
              expiresAt: '2026-01-01T00:00:00.000Z',
            },
          };
        }
        return {
          kind: 'ready',
          connection: {
            serverId: server.id,
            connectionId: '019c62b2-2970-7000-8000-000000000021',
          },
        };
      },
    });
    unlisten = await attachTerminalEvents(core);

    await useTerminalStore.getState().connectServer(server.id);
    useTerminalStore.getState().dismissHostKey(server.id);

    const stopped = useTerminalStore.getState().runtimes[server.id];
    expect(stopped?.status).toBe('closed');
    expect(stopped?.hostKeyPrompt).toBeNull();
    expect(stopped?.error).toContain('主机指纹');

    await useTerminalStore.getState().retryServer(server.id);
    expect(useTerminalStore.getState().runtimes[server.id]?.sessions).toHaveLength(1);
  });

  it('blocks a changed host key without offering a trust path', async () => {
    const core = createFakeCoreClient({
      servers: [server],
      connectOutcome: {
        kind: 'hostKeyChanged',
        expectedSha256: 'SHA256:expected',
        actualSha256: 'SHA256:actual',
      },
    });
    unlisten = await attachTerminalEvents(core);

    await useTerminalStore.getState().connectServer(server.id);

    const blocked = useTerminalStore.getState().runtimes[server.id];
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.hostKeyPrompt).toBeNull();
    expect(blocked?.error).toContain('服务器主机指纹已变化');
    expect(blocked?.sessions).toHaveLength(0);
    expect(core.calls).not.toContainEqual(
      expect.objectContaining({ method: 'trustHostKey' }),
    );
  });

  it('shows a Chinese authentication failure and a disconnected session state', async () => {
    const core = createFakeCoreClient({
      servers: [server],
      overrides: {
        connect: async () => {
          throw {
            code: 'SSH_AUTHENTICATION',
            message: 'authentication failed',
            retryable: false,
          };
        },
      },
    });
    unlisten = await attachTerminalEvents(core);

    await useTerminalStore.getState().connectServer(server.id);

    const failed = useTerminalStore.getState().runtimes[server.id];
    expect(failed?.status).toBe('error');
    expect(failed?.error).toBe('SSH 认证失败，请检查系统凭据库中的密码或私钥');

    const readyCore = createFakeCoreClient({ servers: [server] });
    unlisten?.();
    unlisten = await attachTerminalEvents(readyCore);
    await useTerminalStore.getState().connectServer(server.id);
    const session = useTerminalStore.getState().runtimes[server.id]?.sessions[0];
    readyCore.emitTerminalClosed({
      terminalSessionId: session?.id as string,
      reason: 'disconnected',
    });

    const disconnected = useTerminalStore.getState().runtimes[server.id]?.sessions[0];
    expect(disconnected?.status).toBe('closed');
    expect(disconnected?.closeReason).toBe('disconnected');
  });

  it('drains data, gap, and close events that arrive before the open response', async () => {
    const sessionId = '019c62b2-2970-7000-8000-000000000030';
    const core = createFakeCoreClient({
      servers: [server],
      overrides: {
        openTerminal: async (connection) => {
          core.emitTerminalData({
            terminalSessionId: sessionId,
            sequence: 1,
            bytes: Array.from(new TextEncoder().encode('first prompt')),
          });
          core.emitTerminalGap({
            terminalSessionId: sessionId,
            missed: 2,
          });
          core.emitTerminalClosed({
            terminalSessionId: sessionId,
            reason: 'remoteExit',
            exitStatus: 127,
          });
          return { id: sessionId, connection };
        },
      },
    });
    unlisten = await attachTerminalEvents(core);

    await useTerminalStore.getState().connectServer(server.id);

    const buffered = useTerminalStore.getState().runtimes[server.id]?.sessions[0];
    expect(buffered?.lastSequence).toBe(1);
    expect(buffered?.gap).toBe(true);
    expect(buffered?.status).toBe('closed');
    expect(buffered?.exitStatus).toBe(127);
  });

  it('does not resurrect a server that is disposed while its connection is in flight', async () => {
    let resolveConnect!: (outcome: ConnectOutcome) => void;
    const connection = new Promise<ConnectOutcome>((resolve) => {
      resolveConnect = resolve;
    });
    const core = createFakeCoreClient({
      servers: [server],
      overrides: {
        connect: async () => connection,
      },
    });
    unlisten = await attachTerminalEvents(core);

    const connecting = useTerminalStore.getState().connectServer(server.id);
    await Promise.resolve();
    await useTerminalStore.getState().disposeServer(server.id);
    resolveConnect({
      kind: 'ready',
      connection: {
        serverId: server.id,
        connectionId: '019c62b2-2970-7000-8000-000000000031',
      },
    });
    await connecting;

    expect(useTerminalStore.getState().runtimes[server.id]).toBeUndefined();
    expect(
      core.calls.filter((call) => call.method === 'openTerminal'),
    ).toHaveLength(0);
    expect(core.calls).toContainEqual({
      method: 'disconnect',
      args: [{
        serverId: server.id,
        connectionId: '019c62b2-2970-7000-8000-000000000031',
      }],
    });
  });

  it('ignores stale connection-state sequences for the same server', async () => {
    const core = createFakeCoreClient({ servers: [server] });
    unlisten = await attachTerminalEvents(core);
    await useTerminalStore.getState().connectServer(server.id);
    const before = useTerminalStore.getState().runtimes[server.id];

    core.emitConnectionState({
      serverId: server.id,
      connectionId: null,
      sequence: before?.lastConnectionSequence ?? 0,
      state: {
        kind: 'error',
        code: 'SSH_CONNECTION',
        message: 'stale failure',
        retryable: true,
      },
    });

    const after = useTerminalStore.getState().runtimes[server.id];
    expect(after?.status).toBe('ready');
    expect(after?.error).toBeNull();
  });

  it('fails closed when a ready connection-state event has no connection id', async () => {
    const core = createFakeCoreClient({ servers: [server] });
    unlisten = await attachTerminalEvents(core);
    await useTerminalStore.getState().connectServer(server.id);
    const before = useTerminalStore.getState().runtimes[server.id];

    core.emitConnectionState({
      serverId: server.id,
      connectionId: null,
      sequence: (before?.lastConnectionSequence ?? 0) + 1,
      state: { kind: 'ready' },
    } as unknown as ConnectionStateEvent);

    const after = useTerminalStore.getState().runtimes[server.id];
    expect(after?.status).toBe('error');
    expect(after?.connection).toBeNull();
    expect(after?.error).toContain('连接状态无效');
  });

  it('keeps a server runtime when disconnect fails so deletion cannot leak Core state', async () => {
    const core = createFakeCoreClient({
      servers: [server],
      overrides: {
        disconnect: async () => {
          throw Object.assign(new Error('fixture transport failure'), {
            code: 'SSH_CONNECTION',
            retryable: true,
          });
        },
      },
    });
    unlisten = await attachTerminalEvents(core);
    await useTerminalStore.getState().connectServer(server.id);

    await expect(
      useTerminalStore.getState().disposeServer(server.id),
    ).rejects.toThrow('fixture transport failure');

    expect(useTerminalStore.getState().runtimes[server.id]).toBeDefined();
    expect(
      useTerminalStore.getState().runtimes[server.id]?.sessions,
    ).toHaveLength(1);
  });

  it('uses the shared Chinese message for a server whose credential is not configured', () => {
    expect(connectionErrorMessage({
      code: 'SECRET_UNAVAILABLE',
      message: 'credential missing',
      retryable: false,
    })).toBe('该服务器的凭据尚未配置，请先补充密码或私钥');
  });
});
