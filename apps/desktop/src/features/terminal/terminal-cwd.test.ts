import { describe, expect, it } from 'vitest';

import { parseOsc7WorkingDirectory } from './terminal-cwd';

describe('OSC 7 terminal working directory parsing', () => {
  it('accepts file URLs, decodes percent escapes, and normalizes the path', () => {
    expect(parseOsc7WorkingDirectory('file://prod-web-01/srv/app'))
      .toBe('/srv/app');
    expect(parseOsc7WorkingDirectory('file://prod-web-01/srv/My%20App'))
      .toBe('/srv/My App');
    expect(parseOsc7WorkingDirectory('file:///'))
      .toBe('/');
    expect(parseOsc7WorkingDirectory('file://prod-web-01//srv/./app/'))
      .toBe('/srv/app');
  });

  it('fails closed for traversal, control characters, malformed URLs, and non-file schemes', () => {
    for (const value of [
      'file://host/srv/../etc',
      'file://host/srv/%2e%2e/etc',
      'file://host/srv/%00app',
      'file://host/srv/%0Aapp',
      'file://host/srv/%ZZ',
      'https://host/srv/app',
      '/srv/app',
      'file://host/srv/app?query=1',
      'file://host/srv/app#fragment',
    ]) {
      expect(parseOsc7WorkingDirectory(value), value).toBeNull();
    }
  });
});
