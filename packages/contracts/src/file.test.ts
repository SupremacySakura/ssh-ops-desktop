import { describe, expect, it } from 'vitest';

import {
  MAX_EDITABLE_FILE_BYTES,
  RemoteDirectoryPathSchema,
  RemoteDownloadSchema,
  RemoteFileEntrySchema,
  RemoteFileWriteResultSchema,
  RemotePathSchema,
  RemoteTextFileSchema,
} from './file.js';

const hash = '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03';

describe('remote path contracts', () => {
  it('normalizes root-aware directory paths and keeps resource paths root-free', () => {
    expect(RemoteDirectoryPathSchema.parse('/')).toBe('/');
    expect(RemoteDirectoryPathSchema.parse('//srv/./releases//')).toBe('/srv/releases');
    expect(RemotePathSchema.parse('/srv/./releases/app.tar')).toBe('/srv/releases/app.tar');

    for (const value of ['', 'relative', '/srv/../etc', '/srv/a\0b', '/srv/a\nb']) {
      expect(RemoteDirectoryPathSchema.safeParse(value).success).toBe(false);
    }
    expect(RemotePathSchema.safeParse('/').success).toBe(false);
    expect(RemotePathSchema.safeParse('/srv/../etc/passwd').success).toBe(false);
  });

  it('keeps file listing metadata camelCase, typed, and free of unknown fields', () => {
    const entry = {
      name: 'app.conf',
      path: '/srv/app/app.conf',
      kind: 'file',
      size: 6,
      modifiedAt: 42,
      permissions: 0o640,
    } as const;
    expect(RemoteFileEntrySchema.parse(entry)).toEqual(entry);
    expect(RemoteFileEntrySchema.safeParse({
      ...entry,
      permissions: 0o100_640,
    }).success).toBe(false);
    expect(RemoteFileEntrySchema.safeParse({ ...entry, kind: 'socket' }).success).toBe(false);
    expect(RemoteFileEntrySchema.safeParse({ ...entry, extra: true }).success).toBe(false);
  });
});

describe('online editor contracts', () => {
  it('accepts bounded, NUL-free UTF-8 editor documents and write results', () => {
    const document = {
      path: '/srv/app/app.conf',
      text: 'hello\n',
      sha256: hash,
      size: 6,
      modifiedAt: 42,
    } as const;
    expect(RemoteTextFileSchema.parse(document)).toEqual(document);
    expect(RemoteFileWriteResultSchema.parse({
      path: document.path,
      sha256: hash,
      size: 6,
      warning: '文件已保存，但 SFTP 会话清理失败',
    })).toEqual({
      path: document.path,
      sha256: hash,
      size: 6,
      warning: '文件已保存，但 SFTP 会话清理失败',
    });
  });

  it('rejects binary editor payloads and malformed save results', () => {
    const document = {
      path: '/srv/app/app.conf',
      text: 'hello\n',
      sha256: hash,
      size: 6,
    } as const;
    expect(RemoteTextFileSchema.safeParse({
      ...document,
      text: 'hello\0world',
    }).success).toBe(false);
    expect(RemoteTextFileSchema.safeParse({
      ...document,
      text: 'x'.repeat(MAX_EDITABLE_FILE_BYTES + 1),
    }).success).toBe(false);
    expect(RemoteFileWriteResultSchema.safeParse({
      path: document.path,
      sha256: 'not-a-hash',
      size: 6,
    }).success).toBe(false);
  });
});

describe('download contract', () => {
  it('accepts a bounded byte response and rejects invalid bytes', () => {
    const download = {
      path: '/srv/app/bundle.tar',
      bytes: [1, 2, 255],
      sha256: hash,
    } as const;
    expect(RemoteDownloadSchema.parse(download)).toEqual(download);
    expect(RemoteDownloadSchema.safeParse({
      ...download,
      bytes: [256],
    }).success).toBe(false);
  });
});
