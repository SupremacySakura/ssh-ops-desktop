import { describe, expect, it } from 'vitest';

import {
  FileDeleteArgsSchema,
  FileMkdirArgsSchema,
  FileRenameArgsSchema,
  FileUploadArgsSchema,
  MAX_UPLOAD_BATCH_FILES,
  MAX_EDITABLE_FILE_BYTES,
  RemoteDirectoryPathSchema,
  RemoteDownloadSchema,
  RemoteFileEntrySchema,
  RemoteFileMutationResultSchema,
  RemoteRenameResultSchema,
  RemoteFileWriteResultSchema,
  RemoteUploadOutcomeSchema,
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

describe('file mutation contracts', () => {
  it('normalizes upload directories and rejects unsafe or duplicate basenames', () => {
    expect(FileUploadArgsSchema.parse({
      directory: '//docs/./releases//',
      files: [{ name: 'one.txt', bytes: [1, 2, 3] }],
    })).toEqual({
      directory: '/docs/releases',
      files: [{ name: 'one.txt', bytes: [1, 2, 3] }],
    });

    expect(FileUploadArgsSchema.safeParse({
      directory: '/docs',
      files: [],
    }).success).toBe(false);
    expect(FileUploadArgsSchema.safeParse({
      directory: '/docs',
      files: [{ name: '../escape', bytes: [1] }],
    }).success).toBe(false);
    expect(FileUploadArgsSchema.safeParse({
      directory: '/docs',
      files: [
        { name: 'same.txt', bytes: [1] },
        { name: 'same.txt', bytes: [2] },
      ],
    }).success).toBe(false);
    expect(FileUploadArgsSchema.safeParse({
      directory: '/docs',
      files: Array.from(
        { length: MAX_UPLOAD_BATCH_FILES + 1 },
        (_, index) => ({ name: `file-${index}.txt`, bytes: [index] }),
      ),
    }).success).toBe(false);
  });

  it('requires rollback outcomes to state committed and residual paths honestly', () => {
    const error = {
      code: 'CONFLICT',
      message: '目标文件已存在，未覆盖',
      retryable: false,
    } as const;
    expect(RemoteUploadOutcomeSchema.parse({
      status: 'succeeded',
      committed: ['/docs/one.txt'],
      residual: [],
    })).toEqual({
      status: 'succeeded',
      committed: ['/docs/one.txt'],
      residual: [],
    });
    expect(RemoteUploadOutcomeSchema.parse({
      status: 'failed_with_residue',
      committed: ['/docs/one.txt'],
      residual: ['/docs/one.txt'],
      warning: '回滚未完全完成',
      error,
    })).toMatchObject({
      status: 'failed_with_residue',
      committed: ['/docs/one.txt'],
      residual: ['/docs/one.txt'],
    });

    expect(RemoteUploadOutcomeSchema.safeParse({
      status: 'failed_rolled_back',
      committed: ['/docs/one.txt'],
      residual: [],
      error,
    }).success).toBe(false);
    expect(RemoteUploadOutcomeSchema.safeParse({
      status: 'failed_with_residue',
      committed: [],
      residual: [],
      error,
    }).success).toBe(false);
    expect(RemoteUploadOutcomeSchema.safeParse({
      status: 'failed_rolled_back',
      committed: [],
      residual: [],
    }).success).toBe(false);
  });

  it('validates rename partial results and simple mutation arguments', () => {
    const error = {
      code: 'INTERNAL',
      message: '源文件删除失败',
      retryable: true,
    } as const;
    expect(RemoteRenameResultSchema.parse({
      status: 'partial',
      sourcePath: '/docs/source.txt',
      targetPath: '/docs/target.txt',
      warning: '源与目标当前同时存在',
      error,
    })).toMatchObject({ status: 'partial' });
    expect(RemoteRenameResultSchema.safeParse({
      status: 'partial',
      sourcePath: '/docs/source.txt',
      targetPath: '/docs/target.txt',
    }).success).toBe(false);
    expect(RemoteRenameResultSchema.safeParse({
      status: 'renamed',
      sourcePath: '/docs/source.txt',
      targetPath: '/docs/target.txt',
      error,
    }).success).toBe(false);

    expect(FileMkdirArgsSchema.parse({ path: '//docs/./new//' })).toEqual({
      path: '/docs/new',
    });
    expect(FileRenameArgsSchema.parse({
      sourcePath: '/docs/old.txt',
      targetPath: '//docs/./new.txt',
    })).toEqual({
      sourcePath: '/docs/old.txt',
      targetPath: '/docs/new.txt',
    });
    expect(FileDeleteArgsSchema.parse({ path: '/docs/old.txt' })).toEqual({
      path: '/docs/old.txt',
    });
    expect(RemoteFileMutationResultSchema.parse({
      path: '/docs/new',
      warning: '会话清理失败',
    })).toEqual({
      path: '/docs/new',
      warning: '会话清理失败',
    });
  });
});
