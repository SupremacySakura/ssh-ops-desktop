import { describe, expect, it } from 'vitest';

import {
  exceedsTerminalPasteLimit,
  inspectTerminalPaste,
} from './paste-guard';

describe('terminal paste guard', () => {
  it('allows a short single-line command without confirmation', () => {
    expect(inspectTerminalPaste('docker ps')).toEqual({
      bytes: 9,
      lines: 1,
      requiresConfirmation: false,
    });
  });

  it('allows one trailing newline on an otherwise single-line command', () => {
    expect(inspectTerminalPaste('docker ps\n')).toEqual({
      bytes: 10,
      lines: 1,
      requiresConfirmation: false,
    });
    expect(inspectTerminalPaste('docker ps\r\n')).toEqual({
      bytes: 11,
      lines: 1,
      requiresConfirmation: false,
    });
  });

  it('requires confirmation for multiline and control-character input', () => {
    expect(inspectTerminalPaste('echo one\necho two')).toMatchObject({
      lines: 2,
      requiresConfirmation: true,
    });
    expect(inspectTerminalPaste('echo one\necho two\n')).toMatchObject({
      lines: 2,
      requiresConfirmation: true,
    });
    expect(inspectTerminalPaste('echo one\recho two')).toMatchObject({
      requiresConfirmation: true,
    });
    expect(inspectTerminalPaste('echo safe\u0003rm -rf /')).toMatchObject({
      requiresConfirmation: true,
    });
  });

  it('rejects input above the Core write limit before reporting a successful paste', () => {
    const oversized = 'x'.repeat(1024 * 1024 + 1);

    expect(exceedsTerminalPasteLimit(oversized)).toBe(true);
    expect(inspectTerminalPaste(oversized).requiresConfirmation).toBe(true);
  });
});
