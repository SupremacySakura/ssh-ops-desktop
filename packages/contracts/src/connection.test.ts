import { describe, expect, it } from 'vitest';

import {
  ConnectOutcomeSchema, ConnectionRequestSchema, ConnectionStateEventSchema,
  TerminalDataEventSchema,
} from './connection.js';

describe('connection state event contract', () => {
  it('requires a scoped monotonically countable event envelope', () => {
    expect(ConnectionStateEventSchema.parse({
      serverId: '019c62b2-2970-7000-8000-000000000003',
      connectionId: '019c62b2-2970-7000-8000-000000000004',
      sequence: 1,
      state: { kind: 'reconnecting', attempt: 2 },
    }).state).toEqual({ kind: 'reconnecting', attempt: 2 });
    expect(() => ConnectionStateEventSchema.parse({
      serverId: '019c62b2-2970-7000-8000-000000000003',
      connectionId: '019c62b2-2970-7000-8000-000000000004',
      sequence: 0,
      state: { kind: 'ready' },
    })).toThrow();
  });
});

describe('native SSH connection contracts', () => {
  const serverId = '019c62b2-2970-7000-8000-000000000003';

  it('lets Core select the server-owned secret reference and rejects plaintext', () => {
    expect(ConnectionRequestSchema.parse({
      serverId,
      auth: { kind: 'password' },
    }).auth.kind).toBe('password');
    expect(ConnectionRequestSchema.safeParse({
      serverId,
      auth: { kind: 'password', password: 'leak' },
    }).success).toBe(false);
  });

  it('models host verification separately from a ready connection', () => {
    expect(ConnectOutcomeSchema.parse({
      kind: 'host_key_required',
      prompt: {
        verificationId: serverId,
        algorithm: 'ssh-ed25519',
        sha256: 'SHA256:fixture',
        expiresAt: '2026-08-08T12:00:00.000Z',
      },
    }).kind).toBe('host_key_required');
  });

  it('keeps terminal output ordered and byte-oriented', () => {
    expect(TerminalDataEventSchema.parse({
      terminalSessionId: serverId,
      sequence: 1,
      bytes: [27, 91, 50, 74],
    }).bytes).toEqual([27, 91, 50, 74]);
  });
});
