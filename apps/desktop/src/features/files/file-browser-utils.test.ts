import { describe, expect, it } from 'vitest';

import {
  breadcrumbItems,
  downloadBlocked,
  downloadNeedsConfirmation,
  downloadName,
  formatFileModifiedAt,
  formatFileSize,
  formatPermissions,
  joinRemoteResource,
  languageForPath,
  remoteFileErrorMessage,
  uploadBatchBlocked,
  uploadBatchNeedsConfirmation,
} from './file-browser-utils';

describe('file browser path and formatting helpers', () => {
  it('builds a root-first breadcrumb for the current directory', () => {
    expect(breadcrumbItems('/')).toEqual([
      { label: '/', path: '/' },
    ]);
    expect(breadcrumbItems('/srv/app/releases')).toEqual([
      { label: '/', path: '/' },
      { label: 'srv', path: '/srv' },
      { label: 'app', path: '/srv/app' },
      { label: 'releases', path: '/srv/app/releases' },
    ]);
  });

  it('formats sizes, timestamps, and permission bits for a dense table', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(1536)).toBe('1.5 KiB');
    expect(formatFileSize(4 * 1024 * 1024)).toBe('4.0 MiB');
    expect(formatPermissions(0o640)).toBe('0640');
    expect(formatPermissions(undefined)).toBe('—');
    expect(formatFileModifiedAt(undefined)).toBe('—');
    expect(formatFileModifiedAt(1_700_000_000, 'Asia/Shanghai'))
      .toBe('2023-11-15 06:13');
  });

  it('makes download limits explicit and derives a safe download name', () => {
    expect(downloadNeedsConfirmation(4 * 1024 * 1024)).toBe(false);
    expect(downloadNeedsConfirmation(4 * 1024 * 1024 + 1)).toBe(true);
    expect(downloadBlocked(16 * 1024 * 1024)).toBe(false);
    expect(downloadBlocked(16 * 1024 * 1024 + 1)).toBe(true);
    expect(downloadName('/srv/app/bundle.tar')).toBe('bundle.tar');
  });

  it('maps common text filenames to Monaco languages', () => {
    expect(languageForPath('/srv/app/config.yaml')).toBe('yaml');
    expect(languageForPath('/srv/app/Dockerfile')).toBe('dockerfile');
    expect(languageForPath('/srv/app/unknown.harbor')).toBe('plaintext');
  });

  it('joins safe remote basenames without allowing traversal', () => {
    expect(joinRemoteResource('/', 'app.conf')).toBe('/app.conf');
    expect(joinRemoteResource('/srv/app', 'app.conf')).toBe('/srv/app/app.conf');
    for (const name of ['', '.', '..', 'nested/file', 'bad\nname']) {
      expect(joinRemoteResource('/srv/app', name)).toBeNull();
    }
  });

  it('warns and blocks large or oversized upload batches', () => {
    expect(uploadBatchNeedsConfirmation([4 * 1024 * 1024])).toBe(false);
    expect(uploadBatchNeedsConfirmation([4 * 1024 * 1024 + 1])).toBe(true);
    expect(uploadBatchBlocked([16 * 1024 * 1024])).toBe(false);
    expect(uploadBatchBlocked([16 * 1024 * 1024 + 1])).toBe(true);
    expect(uploadBatchBlocked([32 * 1024 * 1024, 33 * 1024 * 1024])).toBe(true);
    expect(uploadBatchBlocked(Array.from({ length: 33 }, () => 1))).toBe(true);
  });

  it('maps file errors by code and never echoes raw remote messages', () => {
    const internal = remoteFileErrorMessage({
      code: 'INTERNAL',
      message: 'sqlx error: database is locked',
      retryable: false,
    });
    expect(internal).toBe('远程文件操作失败，请重试');
    expect(internal).not.toContain('sqlx');

    const parse = remoteFileErrorMessage({
      code: 'REMOTE_PARSE',
      message: 'unexpected SFTP packet type 200',
      retryable: false,
    });
    expect(parse).toBe('远程文件操作失败，请重试');
    expect(parse).not.toContain('SFTP packet');

    expect(remoteFileErrorMessage({
      code: 'VALIDATION',
      message: '目标路径不是安全 basename',
      retryable: false,
    })).toBe('目标路径不是安全 basename');
    expect(remoteFileErrorMessage({
      code: 'VALIDATION',
      message: 'target path escapes the remote root',
      retryable: false,
    })).toBe('远程文件校验失败，请刷新后重试');
    expect(remoteFileErrorMessage(new Error('socket closed')))
      .toBe('远程文件操作失败，请重试');
  });
});
