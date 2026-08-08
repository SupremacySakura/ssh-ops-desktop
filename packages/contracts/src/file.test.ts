import { describe, expect, it } from 'vitest';

import {
  ConflictPolicySchema,
  FileWriteArgsSchema,
  RemotePathSchema,
  TransferCheckpointSchema,
} from './file.js';

describe('file contracts', () => {
  it('accepts raw safe remote names but rejects traversal', () => {
    expect(RemotePathSchema.parse('/srv/-release;safe')).toBe('/srv/-release;safe');
    for (const path of ['relative', '/../etc/passwd', '/srv/../secret', '/a\0b']) {
      expect(RemotePathSchema.safeParse(path).success).toBe(false);
    }
  });

  it('binds an edit to the digest of the opened remote file', () => {
    expect(FileWriteArgsSchema.parse({
      connection: {
        serverId: '00000000-0000-4000-8000-000000000001',
        connectionId: '00000000-0000-4000-8000-000000000002',
      },
      path: '/etc/app.conf',
      bytes: [112, 111, 114, 116, 61, 56, 48],
      expectedSha256: 'a'.repeat(64),
    }).expectedSha256).toHaveLength(64);
  });

  it('requires an explicit conflict policy and validates checkpoints', () => {
    expect(ConflictPolicySchema.options).toEqual([
      'fail', 'overwrite', 'rename', 'resume_if_matching',
    ]);
    expect(TransferCheckpointSchema.parse({
      sourceSize: 12,
      sourceModifiedMillis: 42,
      sourceSha256: 'a'.repeat(64),
      transferred: 6,
    }).transferred).toBe(6);
  });
});
