import { describe, expect, it } from 'vitest';

import {
  ServerSchema,
  SshConfigImportApplyInputSchema,
  SshConfigImportPreviewSchema,
  SshConfigImportResultSchema,
} from './index.js';

const previewId = '019c62b2-2970-7000-8000-000000000010';
const readyId = '019c62b2-2970-7000-8000-000000000011';

describe('SSH Config import contracts', () => {
  it('accepts the server-side preview and status vocabulary', () => {
    const preview = {
      previewId,
      sourcePath: '~/.ssh/config',
      items: [{
        id: readyId,
        alias: 'prod',
        host: 'prod.example.com',
        port: 2222,
        username: 'deploy',
        identityFile: '~/.ssh/id_ed25519',
        status: 'ready',
        unsupportedDirectives: [],
        warnings: [],
      }, {
        id: '019c62b2-2970-7000-8000-000000000012',
        alias: 'existing',
        host: 'existing.example.com',
        port: 22,
        username: 'deploy',
        identityFile: null,
        status: 'existing',
        unsupportedDirectives: [],
        warnings: [],
      }],
      warnings: [{
        line: 12,
        message: '通配 Host 已忽略。',
      }],
      warningCount: 1,
      existingCount: 1,
      importableCount: 1,
    } as const;

    expect(SshConfigImportPreviewSchema.parse(preview)).toEqual(preview);
    expect(SshConfigImportApplyInputSchema.parse({
      previewId,
      selectedRowIds: [readyId],
    })).toEqual({
      previewId,
      selectedRowIds: [readyId],
    });
  });

  it('represents pending credentials explicitly on imported servers', () => {
    const server = {
      id: '019c62b2-2970-7000-8000-000000000013',
      name: 'imported',
      host: 'imported.example.com',
      port: 22,
      user: 'deploy',
      authType: 'key',
      secretRef: null,
      groupId: null,
      favorite: false,
      createdAt: 1_700_000_000,
    } as const;

    expect(ServerSchema.parse(server)).toEqual(server);
    expect(ServerSchema.safeParse({ ...server, secretRef: '' }).success).toBe(false);
    expect(SshConfigImportResultSchema.parse({
      importedCount: 1,
      skippedCount: 2,
      servers: [server],
    })).toEqual({
      importedCount: 1,
      skippedCount: 2,
      servers: [server],
    });
  });

  it('fails closed when a caller tries to supply server fields directly', () => {
    expect(SshConfigImportApplyInputSchema.safeParse({
      previewId,
      selectedRowIds: [readyId],
      host: 'attacker.example.com',
      username: 'root',
    }).success).toBe(false);
    expect(SshConfigImportApplyInputSchema.safeParse({
      previewId,
      selectedRowIds: [],
    }).success).toBe(false);
  });
});
