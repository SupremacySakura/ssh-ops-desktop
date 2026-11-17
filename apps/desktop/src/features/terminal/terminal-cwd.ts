import { RemoteDirectoryPathSchema } from '@opspilot/contracts';

export function parseOsc7WorkingDirectory(data: string): string | null {
  let url: URL;
  try {
    url = new URL(data);
  } catch {
    return null;
  }
  if (url.protocol !== 'file:' || url.search || url.hash) return null;

  // WHATWG URL resolves dot segments while parsing, which would silently turn
  // a hostile OSC 7 path into a different directory. Decode the original path
  // slice so RemoteDirectoryPathSchema can reject traversal itself.
  const raw = data.slice('file://'.length);
  const pathStart = raw.indexOf('/');
  if (pathStart < 0) return null;
  const rawPath = raw.slice(pathStart);
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  const parsed = RemoteDirectoryPathSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}
