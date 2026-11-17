import type {
  ConnectOutcome,
  ConnectionHandle,
  ConnectionStateEvent,
  Server,
} from '@opspilot/contracts';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFakeCoreClient } from '../test/fake-core';
import { parseOsc7WorkingDirectory } from '../features/terminal/terminal-cwd';
import {
  attachTerminalEvents,
  countOpenSessions,
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

  it('records validated OSC 7 cwd per live terminal session', async () => {
    const core = createFakeCoreClient({ servers: [server] });
    unlisten = await attachTerminalEvents(core);
    await useTerminalStore.getState().connectServer(server.id);
    const session = useTerminalStore.getState().runtimes[server.id]?.sessions[0];

    useTerminalStore.getState().setWorkingDirectory(
      session?.id as string,
      parseOsc7WorkingDirectory('file://prod-web-01/srv/My%20App'),
    );
    expect(
      useTerminalStore.getState().runtimes[server.id]?.sessions[0]?.cwd,
    ).toBe('/srv/My App');

    useTerminalStore.getState().setWorkingDirectory(
      session?.id as string,
      '/srv/../etc',
    );
    expect(
      useTerminalStore.getState().runtimes[server.id]?.sessions[0]?.cwd,
    ).toBe('/srv/My App');

    core.emitTerminalClosed({
      terminalSessionId: session?.id as string,
      reason: 'disconnected',
    });
    useTerminalStore.getState().setWorkingDirectory(
      session?.id as string,
      '/etc',
    );
    expect(
      useTerminalStore.getState().runtimes[server.id]?.sessions[0]?.cwd,
    ).toBe('/srv/My App');
  });

  it('treats an already-lost transport as disconnected', async () => {
    const core = createFakeCoreClient({
      servers: [server],
      overrides: {
        disconnect: async () => {
          throw {
            code: 'SSH_CONNECTION',
            message: 'transport already closed',
            retryable: true,
          };
        },
      },
    });
    unlisten = await attachTerminalEvents(core);
    await useTerminalStore.getState().connectServer(server.id);

    await useTerminalStore.getState().disconnectServer(server.id);

    expect(useTerminalStore.getState().runtimes[server.id]).toMatchObject({
      status: 'closed',
      connection: null,
    });
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

  it('counts only live sessions toward the eight-session budget', async () => {
    const core = createFakeCoreClient({ servers: [server] });
    unlisten = await attachTerminalEvents(core);
    await useTerminalStore.getState().connectServer(server.id);
    const first = useTerminalStore.getState().runtimes[server.id]?.sessions[0];
    core.emitTerminalClosed({
      terminalSessionId: first?.id as string,
      reason: 'remoteExit',
      exitStatus: 0,
    });

    for (let index = 0; index < MAX_TERMINAL_SESSIONS; index += 1) {
      await expect(useTerminalStore.getState().openSession(server.id)).resolves.not.toBeNull();
    }

    const runtime = useTerminalStore.getState().runtimes[server.id];
    expect(runtime?.sessions).toHaveLength(MAX_TERMINAL_SESSIONS + 1);
    expect(runtime && countOpenSessions(runtime)).toBe(MAX_TERMINAL_SESSIONS);
  });

  it('closes the old transport before connecting an edited server identity', async () => {
    const core = createFakeCoreClient({ servers: [server] });
    unlisten = await attachTerminalEvents(core);
    await useTerminalStore.getState().ensureConnected(server);
    const original = useTerminalStore.getState().runtimes[server.id];
    const oldSessionId = original?.sessions[0]?.id;

    await useTerminalStore.getState().ensureConnected({
      ...server,
      host: 'replacement.example.com',
      user: 'replacement',
    });

    const current = useTerminalStore.getState().runtimes[server.id];
    expect(core.calls).toContainEqual({
      method: 'disconnect',
      args: [original?.connection],
    });
    expect(
      core.calls.filter((call) => call.method === 'connect'),
    ).toHaveLength(2);
    expect(current?.sessions).toHaveLength(1);
    expect(current?.sessions[0]?.id).not.toBe(oldSessionId);
    expect(current?.connectionIdentity).toContain('replacement.example.com');
  });

  it('coalesces concurrent reconnects into one replacement session', async () => {
    const core = createFakeCoreClient({ servers: [server] });
    unlisten = await attachTerminalEvents(core);
    await useTerminalStore.getState().connectServer(server.id);
    const original = useTerminalStore.getState().runtimes[server.id]?.sessions[0];
    core.emitTerminalClosed({
      terminalSessionId: original?.id as string,
      reason: 'disconnected',
    });
    let resolveOpen!: (session: { id: string; connection: ConnectionHandle }) => void;
    let opened = 0;
    let orphanId = '';
    core.openTerminal = async (connection) => {
      opened += 1;
      return new Promise((resolve) => {
        resolveOpen = (session) => {
          orphanId = session.id;
          resolve(session);
        };
        void connection;
      });
    };

    const first = useTerminalStore.getState().reconnectSession(
      server.id,
      original?.id as string,
    );
    const second = useTerminalStore.getState().reconnectSession(
      server.id,
      original?.id as string,
    );
    resolveOpen({
      id: '019c62b2-2970-7000-8000-000000000099',
      connection: original?.connection as ConnectionHandle,
    });
    await Promise.all([first, second]);

    expect(opened).toBe(1);
    expect(
      useTerminalStore.getState().runtimes[server.id]?.sessions,
    ).toHaveLength(1);
    expect(
      useTerminalStore.getState().runtimes[server.id]?.sessions[0]?.id,
    ).toBe(orphanId);
  });

  it('does not open an extra session when reconnect rebuilds the transport', async () => {
    const core = createFakeCoreClient({ servers: [server] });
    unlisten = await attachTerminalEvents(core);
    await useTerminalStore.getState().connectServer(server.id);
    const original = useTerminalStore.getState().runtimes[server.id]?.sessions[0];
    core.emitTerminalClosed({
      terminalSessionId: original?.id as string,
      reason: 'disconnected',
    });
    const openTerminal = core.openTerminal;
    let openAttempts = 0;
    core.openTerminal = async (connection, columns, rows) => {
      openAttempts += 1;
      if (openAttempts === 1) throw new Error('stale transport');
      return openTerminal(connection, columns, rows);
    };

    await useTerminalStore.getState().reconnectSession(
      server.id,
      original?.id as string,
    );

    const runtime = useTerminalStore.getState().runtimes[server.id];
    expect(openAttempts).toBe(2);
    expect(runtime?.sessions).toHaveLength(1);
    expect(runtime?.sessions[0]?.id).not.toBe(original?.id);
    expect(runtime && countOpenSessions(runtime)).toBe(1);
  });

  it('releases a rebuilt connection when the original tab closes during connect', async () => {
    const core = createFakeCoreClient({ servers: [server] });
    unlisten = await attachTerminalEvents(core);
    await useTerminalStore.getState().connectServer(server.id);
    const original = useTerminalStore.getState().runtimes[server.id]?.sessions[0];
    core.emitTerminalClosed({
      terminalSessionId: original?.id as string,
      reason: 'disconnected',
    });
    core.openTerminal = async () => {
      throw new Error('stale transport');
    };
    let markConnectStarted!: () => void;
    const connectStarted = new Promise<void>((resolve) => {
      markConnectStarted = resolve;
    });
    let releaseConnect!: () => void;
    const blockedConnect = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const rebuiltConnection: ConnectionHandle = {
      serverId: server.id,
      connectionId: '019c62b2-2970-7000-8000-000000000097',
    };
    core.connect = async () => {
      markConnectStarted();
      await blockedConnect;
      return { kind: 'ready', connection: rebuiltConnection };
    };

    const reconnecting = useTerminalStore.getState().reconnectSession(
      server.id,
      original?.id as string,
    );
    await connectStarted;
    await useTerminalStore.getState().closeSession(
      server.id,
      original?.id as string,
    );
    releaseConnect();
    await reconnecting;

    const runtime = useTerminalStore.getState().runtimes[server.id];
    expect(runtime?.sessions).toHaveLength(0);
    expect(runtime?.connection).toBeNull();
    expect(core.calls).toContainEqual({
      method: 'disconnect',
      args: [rebuiltConnection],
    });
  });

  it('does not replace a tab while its close request is still in flight', async () => {
    const core = createFakeCoreClient({ servers: [server] });
    unlisten = await attachTerminalEvents(core);
    await useTerminalStore.getState().connectServer(server.id);
    const original = useTerminalStore.getState().runtimes[server.id]?.sessions[0];
    core.emitTerminalClosed({
      terminalSessionId: original?.id as string,
      reason: 'disconnected',
    });
    let openAttempts = 0;
    core.openTerminal = async () => {
      openAttempts += 1;
      throw new Error('stale transport');
    };
    const disconnect = core.disconnect;
    let disconnectCalls = 0;
    let markFallbackDisconnectStarted!: () => void;
    const fallbackDisconnectStarted = new Promise<void>((resolve) => {
      markFallbackDisconnectStarted = resolve;
    });
    let releaseFallbackDisconnect!: () => void;
    const blockedFallbackDisconnect = new Promise<void>((resolve) => {
      releaseFallbackDisconnect = resolve;
    });
    core.disconnect = async (connection) => {
      disconnectCalls += 1;
      if (disconnectCalls === 1) {
        markFallbackDisconnectStarted();
        await blockedFallbackDisconnect;
      }
      await disconnect(connection);
    };
    const closeTerminal = core.closeTerminal;
    let markCloseStarted!: () => void;
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve;
    });
    let releaseClose!: () => void;
    const blockedClose = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    core.closeTerminal = async (sessionId) => {
      if (sessionId === original?.id) {
        markCloseStarted();
        await blockedClose;
      }
      await closeTerminal(sessionId);
    };

    const reconnecting = useTerminalStore.getState().reconnectSession(
      server.id,
      original?.id as string,
    );
    await fallbackDisconnectStarted;
    const closing = useTerminalStore.getState().closeSession(
      server.id,
      original?.id as string,
    );
    await closeStarted;
    releaseFallbackDisconnect();
    await reconnecting;

    const duringClose = useTerminalStore.getState().runtimes[server.id];
    expect(openAttempts).toBe(1);
    expect(duringClose?.sessions.map((session) => session.id)).toEqual([
      original?.id,
    ]);
    expect(duringClose?.connection).toBeNull();

    releaseClose();
    await closing;
    const afterClose = useTerminalStore.getState().runtimes[server.id];
    expect(afterClose?.sessions).toHaveLength(0);
    expect(afterClose?.connection).toBeNull();
  });

  it('releases a rebuilt connection when close starts during replacement open', async () => {
    const core = createFakeCoreClient({ servers: [server] });
    unlisten = await attachTerminalEvents(core);
    await useTerminalStore.getState().connectServer(server.id);
    const original = useTerminalStore.getState().runtimes[server.id]?.sessions[0];
    core.emitTerminalClosed({
      terminalSessionId: original?.id as string,
      reason: 'disconnected',
    });
    let openAttempts = 0;
    let markReplacementOpenStarted!: () => void;
    const replacementOpenStarted = new Promise<void>((resolve) => {
      markReplacementOpenStarted = resolve;
    });
    let releaseReplacementOpen!: () => void;
    const blockedReplacementOpen = new Promise<void>((resolve) => {
      releaseReplacementOpen = resolve;
    });
    const replacementId = '019c62b2-2970-7000-8000-000000000096';
    core.openTerminal = async (connection) => {
      openAttempts += 1;
      if (openAttempts === 1) throw new Error('stale transport');
      markReplacementOpenStarted();
      await blockedReplacementOpen;
      return { id: replacementId, connection };
    };
    const closeTerminal = core.closeTerminal;
    let markCloseStarted!: () => void;
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve;
    });
    let releaseClose!: () => void;
    const blockedClose = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    core.closeTerminal = async (sessionId) => {
      if (sessionId === original?.id) {
        markCloseStarted();
        await blockedClose;
      }
      await closeTerminal(sessionId);
    };

    const reconnecting = useTerminalStore.getState().reconnectSession(
      server.id,
      original?.id as string,
    );
    await replacementOpenStarted;
    const closing = useTerminalStore.getState().closeSession(
      server.id,
      original?.id as string,
    );
    await closeStarted;
    releaseReplacementOpen();
    await reconnecting;

    const duringClose = useTerminalStore.getState().runtimes[server.id];
    expect(openAttempts).toBe(2);
    expect(duringClose?.sessions.map((session) => session.id)).toEqual([
      original?.id,
    ]);
    expect(duringClose?.connection).toBeNull();
    expect(core.calls).toContainEqual({
      method: 'closeTerminal',
      args: [replacementId],
    });

    releaseClose();
    await closing;
    const afterClose = useTerminalStore.getState().runtimes[server.id];
    expect(afterClose?.sessions).toHaveLength(0);
    expect(afterClose?.connection).toBeNull();
  });

  it('releases a rebuilt connection when replacement open rejects during close', async () => {
    const core = createFakeCoreClient({ servers: [server] });
    unlisten = await attachTerminalEvents(core);
    await useTerminalStore.getState().connectServer(server.id);
    const original = useTerminalStore.getState().runtimes[server.id]?.sessions[0];
    core.emitTerminalClosed({
      terminalSessionId: original?.id as string,
      reason: 'disconnected',
    });
    let openAttempts = 0;
    let markReplacementOpenStarted!: () => void;
    const replacementOpenStarted = new Promise<void>((resolve) => {
      markReplacementOpenStarted = resolve;
    });
    let rejectReplacementOpen!: () => void;
    const blockedReplacementOpen = new Promise<void>((_resolve, reject) => {
      rejectReplacementOpen = () => reject(new Error('replacement failed'));
    });
    core.openTerminal = async () => {
      openAttempts += 1;
      if (openAttempts === 1) throw new Error('stale transport');
      markReplacementOpenStarted();
      await blockedReplacementOpen;
      throw new Error('unreachable');
    };
    const closeTerminal = core.closeTerminal;
    let markCloseStarted!: () => void;
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve;
    });
    let releaseClose!: () => void;
    const blockedClose = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    core.closeTerminal = async (sessionId) => {
      if (sessionId === original?.id) {
        markCloseStarted();
        await blockedClose;
      }
      await closeTerminal(sessionId);
    };

    const reconnecting = useTerminalStore.getState().reconnectSession(
      server.id,
      original?.id as string,
    );
    await replacementOpenStarted;
    const closing = useTerminalStore.getState().closeSession(
      server.id,
      original?.id as string,
    );
    await closeStarted;
    rejectReplacementOpen();
    await reconnecting;

    const duringClose = useTerminalStore.getState().runtimes[server.id];
    expect(openAttempts).toBe(2);
    expect(duringClose?.sessions.map((session) => session.id)).toEqual([
      original?.id,
    ]);
    expect(duringClose?.connection).toBeNull();

    releaseClose();
    await closing;
    const afterClose = useTerminalStore.getState().runtimes[server.id];
    expect(afterClose?.sessions).toHaveLength(0);
    expect(afterClose?.connection).toBeNull();
  });

  it('closes a reconnected channel when its original tab was removed mid-flight', async () => {
    const core = createFakeCoreClient({ servers: [server] });
    unlisten = await attachTerminalEvents(core);
    await useTerminalStore.getState().connectServer(server.id);
    const original = useTerminalStore.getState().runtimes[server.id]?.sessions[0];
    core.emitTerminalClosed({
      terminalSessionId: original?.id as string,
      reason: 'disconnected',
    });
    let resolveOpen!: (session: { id: string; connection: ConnectionHandle }) => void;
    core.openTerminal = async () => new Promise((resolve) => {
      resolveOpen = resolve;
    });

    const reconnecting = useTerminalStore.getState().reconnectSession(
      server.id,
      original?.id as string,
    );
    await useTerminalStore.getState().closeSession(
      server.id,
      original?.id as string,
    );
    const replacementId = '019c62b2-2970-7000-8000-000000000098';
    resolveOpen({
      id: replacementId,
      connection: original?.connection as ConnectionHandle,
    });
    await reconnecting;

    expect(
      useTerminalStore.getState().runtimes[server.id]?.sessions,
    ).toHaveLength(0);
    expect(core.calls).toContainEqual({
      method: 'closeTerminal',
      args: [replacementId],
    });
  });

  it('does not resurrect a server disposed during reconnect fallback', async () => {
    const core = createFakeCoreClient({ servers: [server] });
    unlisten = await attachTerminalEvents(core);
    await useTerminalStore.getState().connectServer(server.id);
    const original = useTerminalStore.getState().runtimes[server.id]?.sessions[0];
    core.emitTerminalClosed({
      terminalSessionId: original?.id as string,
      reason: 'disconnected',
    });
    core.openTerminal = async () => {
      throw new Error('stale transport');
    };
    let markDisconnectStarted!: () => void;
    const disconnectStarted = new Promise<void>((resolve) => {
      markDisconnectStarted = resolve;
    });
    let releaseDisconnect!: () => void;
    const blockedDisconnect = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });
    let disconnectCalls = 0;
    core.disconnect = async () => {
      disconnectCalls += 1;
      if (disconnectCalls === 1) {
        markDisconnectStarted();
        await blockedDisconnect;
      }
    };

    const reconnecting = useTerminalStore.getState().reconnectSession(
      server.id,
      original?.id as string,
    );
    await disconnectStarted;
    await useTerminalStore.getState().disposeServer(server.id);
    releaseDisconnect();
    await reconnecting;

    expect(useTerminalStore.getState().runtimes[server.id]).toBeUndefined();
    expect(
      core.calls.filter((call) => call.method === 'connect'),
    ).toHaveLength(1);
  });

  it('does not reconnect after the original tab closes during fallback disconnect', async () => {
    const core = createFakeCoreClient({ servers: [server] });
    unlisten = await attachTerminalEvents(core);
    await useTerminalStore.getState().connectServer(server.id);
    const original = useTerminalStore.getState().runtimes[server.id]?.sessions[0];
    core.emitTerminalClosed({
      terminalSessionId: original?.id as string,
      reason: 'disconnected',
    });
    core.openTerminal = async () => {
      throw new Error('stale transport');
    };
    let markDisconnectStarted!: () => void;
    const disconnectStarted = new Promise<void>((resolve) => {
      markDisconnectStarted = resolve;
    });
    let releaseDisconnect!: () => void;
    const blockedDisconnect = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });
    core.disconnect = async () => {
      markDisconnectStarted();
      await blockedDisconnect;
    };

    const reconnecting = useTerminalStore.getState().reconnectSession(
      server.id,
      original?.id as string,
    );
    await disconnectStarted;
    await useTerminalStore.getState().closeSession(
      server.id,
      original?.id as string,
    );
    releaseDisconnect();
    await reconnecting;

    const runtime = useTerminalStore.getState().runtimes[server.id];
    expect(runtime?.connection).toBeNull();
    expect(runtime?.status).toBe('closed');
    expect(
      core.calls.filter((call) => call.method === 'connect'),
    ).toHaveLength(1);
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

  it('blocks a changed host key until the user explicitly confirms replacement', async () => {
    let attempt = 0;
    const core = createFakeCoreClient({
      servers: [server],
      connectOutcome: () => {
        attempt += 1;
        if (attempt === 1) {
          return {
            kind: 'hostKeyChanged',
            prompt: {
              verificationId: '019c62b2-2970-7000-8000-000000000022',
              expectedSha256: 'SHA256:expected',
              actualSha256: 'SHA256:actual',
              expiresAt: '2026-01-01T00:00:00.000Z',
            },
          } satisfies ConnectOutcome;
        }
        return {
          kind: 'ready',
          connection: {
            serverId: server.id,
            connectionId: '019c62b2-2970-7000-8000-000000000023',
          },
        } satisfies ConnectOutcome;
      },
    });
    unlisten = await attachTerminalEvents(core);

    await useTerminalStore.getState().connectServer(server.id);

    const blocked = useTerminalStore.getState().runtimes[server.id];
    expect(blocked?.status).toBe('host-key');
    expect(blocked?.hostKeyPrompt).toBeNull();
    expect(blocked?.hostKeyChangedPrompt?.actualSha256).toBe('SHA256:actual');
    expect(blocked?.sessions).toHaveLength(0);
    expect(core.calls).not.toContainEqual(expect.objectContaining({
      method: 'trustHostKey',
    }));

    await useTerminalStore.getState().trustHostKey(server.id);

    expect(core.calls).toContainEqual({
      method: 'trustHostKey',
      args: [server.id, '019c62b2-2970-7000-8000-000000000022'],
    });
    expect(useTerminalStore.getState().runtimes[server.id]?.status).toBe('ready');
    expect(useTerminalStore.getState().runtimes[server.id]?.sessions).toHaveLength(1);
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

  it('ignores an uncorrelated ready event instead of replacing the local connection', async () => {
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
    expect(after?.status).toBe('ready');
    expect(after?.connection).toEqual(before?.connection);
    expect(after?.error).toBeNull();
  });

  it('closes sessions only for the matching connection-state event', async () => {
    const core = createFakeCoreClient({ servers: [server] });
    unlisten = await attachTerminalEvents(core);
    await useTerminalStore.getState().connectServer(server.id);
    const before = useTerminalStore.getState().runtimes[server.id];

    core.emitConnectionState({
      serverId: server.id,
      connectionId: '019c62b2-2970-7000-8000-000000000099',
      sequence: (before?.lastConnectionSequence ?? 0) + 1,
      state: { kind: 'closed' },
    });
    expect(
      useTerminalStore.getState().runtimes[server.id]?.sessions[0]?.status,
    ).toBe('open');

    core.emitConnectionState({
      serverId: server.id,
      connectionId: before?.connection?.connectionId as string,
      sequence: (before?.lastConnectionSequence ?? 0) + 2,
      state: { kind: 'closed' },
    });
    const after = useTerminalStore.getState().runtimes[server.id];
    expect(after?.status).toBe('closed');
    expect(after?.connection).toBeNull();
    expect(after?.sessions[0]?.status).toBe('closed');
    expect(after?.sessions[0]?.closeReason).toBe('connectionClosed');
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
