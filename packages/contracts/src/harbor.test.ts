import { describe, expect, it } from 'vitest';

import {
  CoreHealthSchema,
  GroupSchema,
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
