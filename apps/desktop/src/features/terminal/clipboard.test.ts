import { describe, expect, it, vi } from 'vitest';

import { readTerminalClipboard } from './clipboard';

describe('terminal clipboard read', () => {
  it('prefers the Core clipboard when it is available', async () => {
    const readWebClipboard = vi.fn(async () => 'from-web');

    await expect(readTerminalClipboard({
      readWebClipboard,
      readCoreClipboard: async () => 'from-core',
    })).resolves.toBe('from-core');
    expect(readWebClipboard).not.toHaveBeenCalled();
  });

  it('falls back to the WebView clipboard when the Core reader rejects', async () => {
    await expect(readTerminalClipboard({
      readCoreClipboard: async () => {
        throw new Error('native clipboard unavailable');
      },
      readWebClipboard: async () => 'from-web',
    })).resolves.toBe('from-web');
  });

  it('falls back when the Core clipboard API is missing entirely', async () => {
    await expect(readTerminalClipboard({
      readWebClipboard: async () => 'from-web',
    })).resolves.toBe('from-web');
  });

  it('preserves an empty clipboard so the UI can report it', async () => {
    await expect(readTerminalClipboard({
      readWebClipboard: async () => 'from-web',
      readCoreClipboard: async () => '',
    })).resolves.toBe('');
  });

  it('returns null only when every clipboard source fails', async () => {
    await expect(readTerminalClipboard({
      readWebClipboard: async () => {
        throw new Error('denied');
      },
      readCoreClipboard: async () => {
        throw new Error('native clipboard unavailable');
      },
    })).resolves.toBeNull();
  });
});
