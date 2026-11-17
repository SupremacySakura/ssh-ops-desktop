import { describe, expect, it } from 'vitest';

import {
  ConnectOutcomeSchema,
  ConnectionHandleSchema,
  ConnectionStateEventSchema,
  CoreHealthSchema,
  GroupSchema,
  GroupInputSchema,
  ServerCredentialInputSchema,
  ServerInputSchema,
  ServerSchema,
  TerminalClosedSchema,
  TerminalDataSchema,
  TerminalGapSchema,
  TerminalSessionSchema,
} from './index.js';

const server = {
  id: '019c62b2-2970-7000-8000-000000000003',
  name: 'prod-web-01',
  host: 'prod.example.com',
  port: 22,
  user: 'deploy',
  authType: 'key',
  secretRef: ['fixture', 'ref', '001'].join('-'),
  groupId: null,
  favorite: true,
  lastConnectedAt: 1_700_000_000,
  createdAt: 1_699_999_000,
} as const;

describe('Harbor catalog contracts', () => {
  it('accepts the minimal Harbor server and group shapes', () => {
    expect(ServerSchema.parse(server)).toEqual(server);
    expect(GroupSchema.parse({
      id: '019c62b2-2970-7000-8000-000000000004',
      name: '生产',
      sortOrder: 1,
    })).toEqual({
      id: '019c62b2-2970-7000-8000-000000000004',
      name: '生产',
      sortOrder: 1,
    });
  });

  it('normalizes catalog write inputs at the IPC boundary', () => {
    expect(ServerInputSchema.parse({
      name: '  prod-web-01 ',
      host: ' PROD.example.com ',
      port: 22,
      user: ' deploy ',
      authType: 'key',
      groupId: null,
      favorite: true,
    })).toEqual({
      name: 'prod-web-01',
      host: 'PROD.example.com',
      port: 22,
      user: 'deploy',
      authType: 'key',
      groupId: null,
      favorite: true,
    });
    expect(ServerCredentialInputSchema.parse({
      credential: 'credential-fixture-value',
    })).toEqual({
      credential: 'credential-fixture-value',
    });
    expect(GroupInputSchema.parse({
      name: ' 生产 ',
      sortOrder: 1,
    })).toEqual({
      name: '生产',
      sortOrder: 1,
    });
  });

  it('rejects invalid catalog write inputs with actionable constraints', () => {
    expect(ServerInputSchema.safeParse({
      name: 'server',
      host: 'prod.example.com',
      port: 0,
      user: 'deploy',
      authType: 'key',
      favorite: false,
    }).success).toBe(false);
    expect(ServerInputSchema.safeParse({
      name: 'server',
      host: 'https://prod.example.com',
      port: 22,
      user: 'deploy',
      authType: 'key',
      favorite: false,
    }).success).toBe(false);
    expect(ServerCredentialInputSchema.safeParse({ credential: '' }).success).toBe(false);
    expect(GroupInputSchema.safeParse({ name: ' ', sortOrder: 0 }).success).toBe(false);
  });

  it('rejects removed catalog concepts and unsupported authentication', () => {
    expect(ServerSchema.safeParse({ ...server, tags: [] }).success).toBe(false);
    expect(ServerSchema.safeParse({ ...server, username: 'deploy' }).success).toBe(false);
    expect(ServerSchema.safeParse({ ...server, authType: 'ssh_agent' }).success).toBe(false);
    expect(ServerSchema.safeParse({ ...server, port: 0 }).success).toBe(false);
  });
});

describe('Core health contract', () => {
  it('exposes the readiness returned by the Rust Core command', () => {
    expect(CoreHealthSchema.parse({
      version: '0.1.0',
      databaseReady: true,
      secretStoreReady: false,
    })).toEqual({
      version: '0.1.0',
      databaseReady: true,
      secretStoreReady: false,
    });
  });
});

describe('SSH connection and terminal contracts', () => {
  const serverId = '019c62b2-2970-7000-8000-000000000003';
  const connectionId = '019c62b2-2970-7000-8000-000000000010';
  const terminalSessionId = '019c62b2-2970-7000-8000-000000000011';
  const verificationId = '019c62b2-2970-7000-8000-000000000012';
  const connection = { serverId, connectionId };

  it('parses the three connection outcomes and keeps fingerprints intact', () => {
    expect(ConnectionHandleSchema.parse(connection)).toEqual(connection);
    expect(ConnectOutcomeSchema.parse({
      kind: 'ready',
      connection,
    })).toEqual({
      kind: 'ready',
      connection,
    });
    expect(ConnectOutcomeSchema.parse({
      kind: 'hostKeyRequired',
      prompt: {
        verificationId,
        algorithm: 'ssh-ed25519',
        sha256: 'SHA256:fixture',
        expiresAt: '2026-01-01T00:00:00.000Z',
      },
    })).toEqual({
      kind: 'hostKeyRequired',
      prompt: {
        verificationId,
        algorithm: 'ssh-ed25519',
        sha256: 'SHA256:fixture',
        expiresAt: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(ConnectOutcomeSchema.parse({
      kind: 'hostKeyChanged',
      expectedSha256: 'SHA256:expected',
      actualSha256: 'SHA256:actual',
    })).toEqual({
      kind: 'hostKeyChanged',
      expectedSha256: 'SHA256:expected',
      actualSha256: 'SHA256:actual',
    });
  });

  it('parses terminal session, data, gap, and close payloads', () => {
    expect(TerminalSessionSchema.parse({
      id: terminalSessionId,
      connection,
    })).toEqual({
      id: terminalSessionId,
      connection,
    });
    expect(TerminalDataSchema.parse({
      terminalSessionId,
      sequence: 1,
      bytes: [27, 91, 50, 74],
    })).toEqual({
      terminalSessionId,
      sequence: 1,
      bytes: [27, 91, 50, 74],
    });
    expect(TerminalGapSchema.parse({
      terminalSessionId,
      missed: 3,
    })).toEqual({
      terminalSessionId,
      missed: 3,
    });
    expect(TerminalClosedSchema.parse({
      terminalSessionId,
      reason: 'disconnected',
    })).toEqual({
      terminalSessionId,
      reason: 'disconnected',
    });
    expect(TerminalClosedSchema.parse({
      terminalSessionId,
      reason: 'remoteExit',
      exitStatus: 0,
    })).toEqual({
      terminalSessionId,
      reason: 'remoteExit',
      exitStatus: 0,
    });
  });

  it('parses sequenced connection state events without accepting stale shapes', () => {
    expect(ConnectionStateEventSchema.parse({
      serverId,
      connectionId,
      sequence: 2,
      state: { kind: 'ready' },
    })).toEqual({
      serverId,
      connectionId,
      sequence: 2,
      state: { kind: 'ready' },
    });
    expect(ConnectionStateEventSchema.parse({
      serverId,
      connectionId: null,
      sequence: 1,
      state: { kind: 'connecting' },
    })).toEqual({
      serverId,
      connectionId: null,
      sequence: 1,
      state: { kind: 'connecting' },
    });
    expect(ConnectionStateEventSchema.safeParse({
      serverId,
      connectionId,
      sequence: 0,
      state: { kind: 'closed' },
    }).success).toBe(false);
    expect(ConnectionStateEventSchema.safeParse({
      serverId,
      connectionId,
      sequence: 3,
      state: { kind: 'ready', connection_id: connectionId },
    }).success).toBe(false);
    expect(ConnectionStateEventSchema.safeParse({
      serverId,
      connectionId: null,
      sequence: 3,
      state: { kind: 'ready' },
    }).success).toBe(false);
    expect(ConnectionStateEventSchema.safeParse({
      serverId,
      connectionId: null,
      sequence: 3,
      state: { kind: 'closed' },
    }).success).toBe(false);
  });
});
