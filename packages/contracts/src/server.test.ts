import { describe, expect, it } from 'vitest';

import {
  ServerDeleteRequestSchema,
  ServerGroupInputSchema,
  ServerInputSchema,
  ServerTagInputSchema,
} from './server.js';
import {
  ServerImportApplyRequestSchema,
  ServerImportPreviewSchema,
} from './server-import.js';

const validInput = {
  name: 'Production API',
  host: 'api.example.com',
  port: 22,
  username: 'deploy',
  environment: 'production',
  authType: 'ssh_agent',
  tagIds: [],
} as const;

describe('server input contract', () => {
  it('normalizes user-entered names, hosts, and usernames', () => {
    const parsed = ServerInputSchema.parse({
      ...validInput,
      name: '  Production API  ',
      host: '  API.Example.COM  ',
      username: '  deploy  ',
    });

    expect(parsed).toEqual(validInput);
  });

  it.each([0, 65_536, 22.5])('rejects invalid SSH port %s', (port) => {
    expect(ServerInputSchema.safeParse({ ...validInput, port }).success).toBe(false);
  });

  it.each(['', '   ', 'https://api.example.com', 'api.example.com\nspoofed'])(
    'rejects unsafe host %j',
    (host) => {
      expect(ServerInputSchema.safeParse({ ...validInput, host }).success).toBe(false);
    },
  );

  it('requires an explicit deployment environment so production stays identifiable', () => {
    const missingEnvironment = {
      name: validInput.name,
      host: validInput.host,
      port: validInput.port,
      username: validInput.username,
      authType: validInput.authType,
      tagIds: validInput.tagIds,
    };

    expect(ServerInputSchema.safeParse(missingEnvironment).success).toBe(false);
    expect(ServerInputSchema.parse(validInput).environment).toBe('production');
  });

  it('requires explicit confirmation for a server delete request', () => {
    const serverId = '019c62b2-2970-7000-8000-000000000105';

    expect(ServerDeleteRequestSchema.parse({ serverId, confirmed: true })).toEqual({
      serverId,
      confirmed: true,
    });
    expect(ServerDeleteRequestSchema.safeParse({ serverId }).success).toBe(false);
    expect(ServerDeleteRequestSchema.safeParse({ serverId, confirmed: false }).success)
      .toBe(false);
  });

  it('normalizes group and tag mutation inputs', () => {
    expect(ServerGroupInputSchema.parse({ name: '  Primary  ', sortOrder: 10 }))
      .toEqual({ name: 'Primary', sortOrder: 10 });
    expect(ServerTagInputSchema.parse({ name: '  edge  ' }))
      .toEqual({ name: 'edge' });
  });
});

describe('server import contract', () => {
  it('represents valid, duplicate, and rejected preview rows without secret fields', () => {
    const preview = ServerImportPreviewSchema.parse({
      importId: '019c62b2-2970-7000-8000-000000000101',
      sourceSha256: 'a'.repeat(64),
      rows: [
        {
          rowId: '019c62b2-2970-7000-8000-000000000102',
          status: 'valid',
          server: validInput,
        },
        {
          rowId: '019c62b2-2970-7000-8000-000000000103',
          status: 'duplicate',
          server: { ...validInput, host: 'duplicate.example.com' },
        },
        {
          rowId: '019c62b2-2970-7000-8000-000000000104',
          status: 'error',
          error: 'port must be between 1 and 65535',
        },
      ],
    });

    expect(preview.rows.map((row) => row.status)).toEqual([
      'valid',
      'duplicate',
      'error',
    ]);
    expect(JSON.stringify(preview)).not.toContain('passwordValue');
  });

  it('allows apply to send only an import id and selected row ids', () => {
    const request = {
      importId: '019c62b2-2970-7000-8000-000000000101',
      rowIds: ['019c62b2-2970-7000-8000-000000000102'],
    };

    expect(ServerImportApplyRequestSchema.parse(request)).toEqual(request);
    expect(ServerImportApplyRequestSchema.safeParse({
      ...request,
      source: 'name,host,password',
    }).success).toBe(false);
    expect(ServerImportApplyRequestSchema.safeParse({
      ...request,
      rows: [validInput],
    }).success).toBe(false);
  });
});
