import {
  FILE_DOWNLOAD_WARNING_BYTES,
  FILE_UPLOAD_WARNING_BYTES,
  MAX_FILE_DOWNLOAD_BYTES,
  MAX_FILE_UPLOAD_BYTES,
  MAX_UPLOAD_BATCH_BYTES,
  MAX_UPLOAD_BATCH_FILES,
  RemotePathSchema,
} from '@opspilot/contracts';

export interface BreadcrumbItem {
  label: string;
  path: string;
}

const EXTENSION_LANGUAGES: Record<string, string> = {
  c: 'c',
  cc: 'cpp',
  conf: 'ini',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  cxx: 'cpp',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  htm: 'html',
  html: 'html',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  less: 'less',
  lua: 'lua',
  md: 'markdown',
  mjs: 'javascript',
  php: 'php',
  pl: 'perl',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'shell',
  sql: 'sql',
  svg: 'xml',
  toml: 'ini',
  ts: 'typescript',
  tsx: 'typescript',
  txt: 'plaintext',
  vue: 'html',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
};

const FILENAME_LANGUAGES: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'plaintext',
};

export function breadcrumbItems(path: string): BreadcrumbItem[] {
  if (path === '/') return [{ label: '/', path: '/' }];
  const segments = path.split('/').filter(Boolean);
  const items: BreadcrumbItem[] = [{ label: '/', path: '/' }];
  let current = '';
  for (const segment of segments) {
    current += `/${segment}`;
    items.push({ label: segment, path: current });
  }
  return items;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function formatFileModifiedAt(
  seconds: number | undefined,
  timeZone?: string,
): string {
  if (seconds === undefined) return '—';
  return new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(new Date(seconds * 1_000));
}

export function formatPermissions(mode: number | undefined): string {
  if (mode === undefined) return '—';
  return (mode & 0o7777).toString(8).padStart(4, '0');
}

export function downloadNeedsConfirmation(size: number): boolean {
  return size > FILE_DOWNLOAD_WARNING_BYTES && size <= MAX_FILE_DOWNLOAD_BYTES;
}

export function downloadBlocked(size: number): boolean {
  return size > MAX_FILE_DOWNLOAD_BYTES;
}

export function downloadName(path: string): string {
  return path.split('/').at(-1) || 'download';
}

export function joinRemoteResource(parent: string, name: string): string | null {
  if (
    name.length === 0
    || name === '.'
    || name === '..'
    || name.includes('/')
    || /\p{Cc}/u.test(name)
  ) {
    return null;
  }
  const parsed = RemotePathSchema.safeParse(
    parent === '/' ? `/${name}` : `${parent}/${name}`,
  );
  return parsed.success ? parsed.data : null;
}

export function uploadBatchNeedsConfirmation(sizes: number[]): boolean {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return sizes.some((size) => size > FILE_UPLOAD_WARNING_BYTES)
    || total > FILE_UPLOAD_WARNING_BYTES;
}

export function uploadBatchBlocked(sizes: number[]): boolean {
  if (sizes.length === 0 || sizes.length > MAX_UPLOAD_BATCH_FILES) return true;
  if (sizes.some((size) => size > MAX_FILE_UPLOAD_BYTES)) return true;
  return sizes.reduce((sum, size) => sum + size, 0) > MAX_UPLOAD_BATCH_BYTES;
}

export function languageForPath(path: string): string {
  const name = path.split('/').at(-1)?.toLocaleLowerCase('en-US') ?? '';
  const extension = name.includes('.') ? name.split('.').at(-1) ?? '' : '';
  return EXTENSION_LANGUAGES[extension] ?? FILENAME_LANGUAGES[name] ?? 'plaintext';
}

export function remoteFileErrorMessage(error: unknown): string {
  const code = (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
  )
    ? error.code
    : null;
  switch (code) {
    case 'SSH_CONNECTION':
      return 'SSH/SFTP 连接已断开，请重新连接服务器';
    case 'NOT_FOUND':
      return '远程文件或目录不存在，可能已被移动或删除';
    case 'REMOTE_PERMISSION':
      return '没有权限访问该远程路径';
    case 'CAPABILITY_UNAVAILABLE':
      return '当前 SFTP 服务器不支持该文件操作';
    case 'TIMEOUT':
      return '远程文件操作超时，请重试';
    case 'VALIDATION':
    case 'CONFLICT':
      return errorMessage(error) ?? '远程文件校验失败，请刷新后重试';
    default:
      return errorMessage(error) ?? '远程文件操作失败，请重试';
  }
}

function errorMessage(error: unknown): string | null {
  if (
    typeof error === 'object'
    && error !== null
    && 'message' in error
    && typeof error.message === 'string'
    && error.message.trim().length > 0
  ) {
    return error.message;
  }
  return null;
}
