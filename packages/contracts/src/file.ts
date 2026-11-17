import { z } from 'zod';

export const MAX_EDITABLE_FILE_BYTES = 1024 * 1024;
export const MAX_EDIT_WRITE_BYTES = 4 * 1024 * 1024;
export const FILE_DOWNLOAD_WARNING_BYTES = 4 * 1024 * 1024;
export const MAX_FILE_DOWNLOAD_BYTES = 16 * 1024 * 1024;

const CONTROL_CHARACTERS = /\p{Cc}/u;
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/u);
const ByteArraySchema = z.array(z.int().min(0).max(255));

function normalizeRemotePath(value: string, allowRoot: boolean): string | null {
  if (value.length === 0 || CONTROL_CHARACTERS.test(value) || !value.startsWith('/')) {
    return null;
  }
  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  if (segments.length === 0) return allowRoot ? '/' : null;
  return `/${segments.join('/')}`;
}

function remotePathSchema(allowRoot: boolean) {
  return z.string().transform((value, context) => {
    const normalized = normalizeRemotePath(value, allowRoot);
    if (normalized === null) {
      context.addIssue({
        code: 'custom',
        message: allowRoot
          ? '远程目录必须是绝对路径，且不能越出根目录或包含控制字符'
          : '远程文件路径必须指向资源，且不能越出根目录或包含控制字符',
      });
      return z.NEVER;
    }
    return normalized;
  });
}

export const RemoteDirectoryPathSchema = remotePathSchema(true);
export const RemotePathSchema = remotePathSchema(false);

export const RemoteFileKindSchema = z.enum([
  'file',
  'directory',
  'symlink',
  'other',
]);

export const RemoteFileEntrySchema = z.object({
  name: z.string().min(1).refine(
    (name) => name !== '.' && name !== '..' && !name.includes('/')
      && !CONTROL_CHARACTERS.test(name),
  ),
  path: RemotePathSchema,
  kind: RemoteFileKindSchema,
  size: z.int().nonnegative(),
  modifiedAt: z.int().nonnegative().optional(),
  permissions: z.int().nonnegative().max(0o7777).optional(),
}).strict();

export const RemoteFileListSchema = z.array(RemoteFileEntrySchema);

export const RemoteTextFileSchema = z.object({
  path: RemotePathSchema,
  text: z.string().refine(
    (text) => !text.includes('\0')
      && new TextEncoder().encode(text).byteLength <= MAX_EDITABLE_FILE_BYTES,
    '在线编辑仅支持不超过 1 MiB 且不含 NUL 的 UTF-8 文本',
  ),
  sha256: SHA256,
  size: z.int().nonnegative().max(MAX_EDITABLE_FILE_BYTES),
  modifiedAt: z.int().nonnegative().optional(),
}).strict().refine(
  (document) => new TextEncoder().encode(document.text).byteLength === document.size,
  { message: '文本长度与远程文件大小不一致' },
);

export const RemoteFileWriteResultSchema = z.object({
  path: RemotePathSchema,
  sha256: SHA256,
  size: z.int().nonnegative().max(MAX_EDIT_WRITE_BYTES),
  modifiedAt: z.int().nonnegative().optional(),
  warning: z.string().trim().min(1).optional(),
}).strict();

export const RemoteDownloadSchema = z.object({
  path: RemotePathSchema,
  bytes: ByteArraySchema.max(MAX_FILE_DOWNLOAD_BYTES),
  sha256: SHA256,
}).strict();

export const FileWriteArgsSchema = z.object({
  path: RemotePathSchema,
  content: z.string().refine(
    (content) => !content.includes('\0')
      && new TextEncoder().encode(content).byteLength <= MAX_EDIT_WRITE_BYTES,
    '保存内容必须是不超过 4 MiB 且不含 NUL 的 UTF-8 文本',
  ),
  expectedSha256: SHA256,
}).strict();

export type RemoteDirectoryPath = z.infer<typeof RemoteDirectoryPathSchema>;
export type RemotePath = z.infer<typeof RemotePathSchema>;
export type RemoteFileKind = z.infer<typeof RemoteFileKindSchema>;
export type RemoteFileEntry = z.infer<typeof RemoteFileEntrySchema>;
export type RemoteFileList = z.infer<typeof RemoteFileListSchema>;
export type RemoteTextFile = z.infer<typeof RemoteTextFileSchema>;
export type RemoteFileWriteResult = z.infer<typeof RemoteFileWriteResultSchema>;
export type RemoteDownload = z.infer<typeof RemoteDownloadSchema>;
export type FileWriteArgs = z.infer<typeof FileWriteArgsSchema>;
