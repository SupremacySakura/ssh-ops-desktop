import { z } from 'zod';

import { CoreErrorSchema } from './errors.js';

export const MAX_EDITABLE_FILE_BYTES = 1024 * 1024;
export const MAX_EDIT_WRITE_BYTES = 4 * 1024 * 1024;
export const FILE_DOWNLOAD_WARNING_BYTES = 4 * 1024 * 1024;
export const MAX_FILE_DOWNLOAD_BYTES = 16 * 1024 * 1024;
export const FILE_UPLOAD_WARNING_BYTES = 4 * 1024 * 1024;
export const MAX_FILE_UPLOAD_BYTES = 16 * 1024 * 1024;
export const MAX_UPLOAD_BATCH_BYTES = 64 * 1024 * 1024;
export const MAX_UPLOAD_BATCH_FILES = 32;

const CONTROL_CHARACTERS = /\p{Cc}/u;
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/u);
const ByteArraySchema = z.array(z.int().min(0).max(255));
const RemoteBasenameSchema = z.string().min(1).refine(
  (name) => name !== '.' && name !== '..' && !name.includes('/')
    && !CONTROL_CHARACTERS.test(name),
  '文件名必须是安全的 basename，且不能包含控制字符',
);

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
  name: RemoteBasenameSchema,
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

export const RemoteUploadFileSchema = z.object({
  name: RemoteBasenameSchema,
  bytes: ByteArraySchema.max(MAX_FILE_UPLOAD_BYTES),
}).strict();

export const FileUploadArgsSchema = z.object({
  directory: RemoteDirectoryPathSchema,
  files: z.array(RemoteUploadFileSchema).min(1).max(MAX_UPLOAD_BATCH_FILES),
}).strict().superRefine(({ files }, context) => {
  const names = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (names.has(file.name)) {
      context.addIssue({
        code: 'custom',
        message: `上传批次包含重复文件名：${file.name}`,
        path: ['files'],
      });
    }
    names.add(file.name);
    total += file.bytes.length;
  }
  if (total > MAX_UPLOAD_BATCH_BYTES) {
    context.addIssue({
      code: 'custom',
      message: '上传批次总大小超过 64 MiB 上限',
      path: ['files'],
    });
  }
});

export const UploadBatchStatusSchema = z.enum([
  'succeeded',
  'failed_rolled_back',
  'failed_with_residue',
]);

export const RemoteUploadOutcomeSchema = z.object({
  status: UploadBatchStatusSchema,
  committed: z.array(RemotePathSchema),
  residual: z.array(RemotePathSchema),
  warning: z.string().trim().min(1).optional(),
  error: CoreErrorSchema.optional(),
}).strict().superRefine((outcome, context) => {
  if (outcome.status === 'succeeded' && outcome.error !== undefined) {
    context.addIssue({
      code: 'custom',
      message: '成功的上传结果不能携带错误',
      path: ['error'],
    });
  }
  if (
    outcome.status === 'succeeded'
    && outcome.residual.length > 0
    && outcome.warning === undefined
  ) {
    context.addIssue({
      code: 'custom',
      message: '上传成功但存在残留时必须明确警告',
      path: ['warning'],
    });
  }
  if (outcome.status === 'failed_rolled_back') {
    if (outcome.error === undefined) {
      context.addIssue({
        code: 'custom',
        message: '回滚失败结果必须携带错误',
        path: ['error'],
      });
    }
    if (outcome.committed.length > 0 || outcome.residual.length > 0) {
      context.addIssue({
        code: 'custom',
        message: '完全回滚时 committed 与 residual 必须为空',
        path: ['status'],
      });
    }
  }
  if (outcome.status === 'failed_with_residue') {
    if (outcome.error === undefined) {
      context.addIssue({
        code: 'custom',
        message: '存在残留的失败结果必须携带错误',
        path: ['error'],
      });
    }
    if (outcome.residual.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'failed_with_residue 必须列出残留路径',
        path: ['residual'],
      });
    }
  }
});

export const RenameStatusSchema = z.enum(['renamed', 'partial']);

function sameRemoteParent(source: string, target: string): boolean {
  const parent = (path: string) => {
    const index = path.lastIndexOf('/');
    return index <= 0 ? '/' : path.slice(0, index);
  };
  return parent(source) === parent(target);
}

export const RemoteRenameResultSchema = z.object({
  status: RenameStatusSchema,
  sourcePath: RemotePathSchema,
  targetPath: RemotePathSchema,
  warning: z.string().trim().min(1).optional(),
  error: CoreErrorSchema.optional(),
}).strict().superRefine((outcome, context) => {
  if (outcome.sourcePath === outcome.targetPath) {
    context.addIssue({
      code: 'custom',
      message: '重命名源与目标不能相同',
      path: ['targetPath'],
    });
  }
  if (!sameRemoteParent(outcome.sourcePath, outcome.targetPath)) {
    context.addIssue({
      code: 'custom',
      message: '重命名只支持同一父目录',
      path: ['targetPath'],
    });
  }
  if (outcome.status === 'partial' && outcome.error === undefined) {
    context.addIssue({
      code: 'custom',
      message: '部分完成的重命名必须携带错误',
      path: ['error'],
    });
  }
  if (outcome.status === 'renamed' && outcome.error !== undefined) {
    context.addIssue({
      code: 'custom',
      message: '成功的重命名不能携带错误',
      path: ['error'],
    });
  }
});

export const RemoteFileMutationResultSchema = z.object({
  path: RemotePathSchema,
  warning: z.string().trim().min(1).optional(),
}).strict();

export const FileMkdirArgsSchema = z.object({
  path: RemotePathSchema,
}).strict();

export const FileRenameArgsSchema = z.object({
  sourcePath: RemotePathSchema,
  targetPath: RemotePathSchema,
}).strict().refine(
  ({ sourcePath, targetPath }) => (
    sourcePath !== targetPath && sameRemoteParent(sourcePath, targetPath)
  ),
  { message: '重命名只支持同一父目录内的不同路径' },
);

export const FileDeleteArgsSchema = z.object({
  path: RemotePathSchema,
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
export type RemoteUploadFile = z.infer<typeof RemoteUploadFileSchema>;
export type FileUploadArgs = z.infer<typeof FileUploadArgsSchema>;
export type UploadBatchStatus = z.infer<typeof UploadBatchStatusSchema>;
export type RemoteUploadOutcome = z.infer<typeof RemoteUploadOutcomeSchema>;
export type RenameStatus = z.infer<typeof RenameStatusSchema>;
export type RemoteRenameResult = z.infer<typeof RemoteRenameResultSchema>;
export type RemoteFileMutationResult = z.infer<typeof RemoteFileMutationResultSchema>;
export type FileMkdirArgs = z.infer<typeof FileMkdirArgsSchema>;
export type FileRenameArgs = z.infer<typeof FileRenameArgsSchema>;
export type FileDeleteArgs = z.infer<typeof FileDeleteArgsSchema>;
