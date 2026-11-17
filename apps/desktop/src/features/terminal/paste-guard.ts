const MAX_TERMINAL_WRITE_BYTES = 1024 * 1024;
const BRACKETED_PASTE_OVERHEAD = 32;

export interface PasteInspection {
  bytes: number;
  lines: number;
  requiresConfirmation: boolean;
}

export function inspectTerminalPaste(value: string): PasteInspection {
  const bytes = new TextEncoder().encode(value).length;
  const lines = value.length === 0
    ? 0
    : value.replaceAll('\r\n', '\n').split('\n').length;
  return {
    bytes,
    lines,
    requiresConfirmation: (
      exceedsTerminalPasteLimit(value)
      || value.includes('\r')
      || value.includes('\n')
      || hasUnsafeControlCharacter(value)
    ),
  };
}

export function exceedsTerminalPasteLimit(value: string): boolean {
  const encodedBytes = new TextEncoder().encode(value).length;
  const bareLineFeeds = [...value].filter((character) => character === '\n').length;
  return (
    encodedBytes + bareLineFeeds + BRACKETED_PASTE_OVERHEAD
    > MAX_TERMINAL_WRITE_BYTES
  );
}

function hasUnsafeControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && code !== 9 && code !== 10 && code !== 13)
      || (code >= 127 && code <= 159);
  });
}
