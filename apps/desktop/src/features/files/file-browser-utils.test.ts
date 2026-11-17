import { describe, expect, it } from 'vitest';

import {
  breadcrumbItems,
  downloadBlocked,
  downloadNeedsConfirmation,
  downloadName,
  formatFileModifiedAt,
  formatFileSize,
  formatPermissions,
  languageForPath,
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
});
