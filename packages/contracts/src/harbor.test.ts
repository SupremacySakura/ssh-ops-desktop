import { describe, expect, it } from 'vitest';

import {
  CoreHealthSchema,
  GroupSchema,
  GroupInputSchema,
  ServerCredentialInputSchema,
  ServerInputSchema,
  ServerSchema,
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
