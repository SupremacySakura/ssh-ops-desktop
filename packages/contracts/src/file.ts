import { z } from 'zod';

import { IdSchema } from './ids.js';
import { ConnectionHandleSchema } from './connection.js';

export const RemotePathSchema = z.string().min(2).superRefine((value, context) => {
  if (!value.startsWith('/') || value.includes('\0') || /[\u0000-\u001f\u007f]/u.test(value)) {
    context.addIssue({ code: 'custom', message: 'remote path must be absolute and contain no control characters' });
    return;
  }
  if (value.split('/').some((component) => component === '..')) {
    context.addIssue({ code: 'custom', message: 'remote path must not traverse its root' });
  }
});

export const ConflictPolicySchema = z.enum([
  'fail',
  'overwrite',
  'rename',
  'resume_if_matching',
]);

export const TransferCheckpointSchema = z.object({
  sourceSize: z.int().nonnegative(),
  sourceModifiedMillis: z.int().nonnegative(),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  transferred: z.int().nonnegative(),
}).strict().refine(
  ({ sourceSize, transferred }) => transferred <= sourceSize,
  { message: 'transferred bytes cannot exceed source size' },
);

export const UploadRequestSchema = z.object({
  taskId: IdSchema,
  serverId: IdSchema,
  localPath: z.string().trim().min(1),
  remotePath: RemotePathSchema,
  conflict: ConflictPolicySchema,
  checkpoint: TransferCheckpointSchema.optional(),
}).strict();

export const RemoteFileEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().startsWith('/'),
  kind: z.enum(['file', 'directory', 'symlink', 'other']),
  size: z.int().nonnegative(),
  modifiedAt: z.int().nonnegative().optional(),
  permissions: z.int().nonnegative().optional(),
}).strict();

export const RemoteFileContentSchema = z.object({
  path: RemotePathSchema,
  bytes: z.array(z.int().min(0).max(255)).max(1024 * 1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  modifiedAt: z.int().nonnegative().optional(),
  truncated: z.literal(false),
}).strict();

export const FileListRequestSchema = z.object({
  connection: ConnectionHandleSchema,
  path: z.string().startsWith('/'),
}).strict();

export const FileReadRequestSchema = z.object({
  connection: ConnectionHandleSchema,
  path: RemotePathSchema,
}).strict();

export const FileDownloadRequestSchema = FileReadRequestSchema;

export const RemoteFileDownloadSchema = z.object({
  path: RemotePathSchema,
  bytes: z.array(z.int().min(0).max(255)).max(16 * 1024 * 1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export const FileWriteArgsSchema = z.object({
  connection: ConnectionHandleSchema,
  path: RemotePathSchema,
  bytes: z.array(z.int().min(0).max(255)).max(4 * 1024 * 1024),
  expectedSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();

export type RemotePath = z.infer<typeof RemotePathSchema>;
export type ConflictPolicy = z.infer<typeof ConflictPolicySchema>;
export type TransferCheckpoint = z.infer<typeof TransferCheckpointSchema>;
export type UploadRequest = z.infer<typeof UploadRequestSchema>;
export type RemoteFileEntry = z.infer<typeof RemoteFileEntrySchema>;
export type RemoteFileContent = z.infer<typeof RemoteFileContentSchema>;
export type FileListRequest = z.infer<typeof FileListRequestSchema>;
export type FileReadRequest = z.infer<typeof FileReadRequestSchema>;
export type FileDownloadRequest = z.infer<typeof FileDownloadRequestSchema>;
export type RemoteFileDownload = z.infer<typeof RemoteFileDownloadSchema>;
export type FileWriteArgs = z.infer<typeof FileWriteArgsSchema>;
