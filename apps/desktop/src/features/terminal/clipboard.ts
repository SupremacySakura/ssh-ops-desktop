export interface TerminalClipboardReaders {
  readWebClipboard?: () => Promise<string>;
  readCoreClipboard?: () => Promise<string>;
}

export async function readTerminalClipboard({
  readWebClipboard,
  readCoreClipboard,
}: TerminalClipboardReaders): Promise<string | null> {
  if (readCoreClipboard) {
    try {
      return await readCoreClipboard();
    } catch {
      // The native clipboard may be unavailable or locked by another app.
    }
  }
  if (readWebClipboard) {
    try {
      return await readWebClipboard();
    } catch {
      // Tauri WebViews can expose the API but reject the permission prompt.
    }
  }
  return null;
}
