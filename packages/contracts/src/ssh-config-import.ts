import { z } from 'zod';

import { IdSchema } from './ids.js';
import {
  RequiredTextSchema,
  ServerHostSchema,
  ServerSchema,
  ServerUserSchema,
} from './server.js';

export const SshConfigImportStatusSchema = z.enum([
  'ready',
  'existing',
  'duplicateInBatch',
  'unsupported',
]);

export const SshConfigImportWarningSchema = z.object({
  line: z.int().positive(),
  message: RequiredTextSchema,
}).strict();

export const SshConfigImportItemSchema = z.object({
  id: IdSchema,
  alias: RequiredTextSchema,
  host: ServerHostSchema,
  port: z.int().min(1).max(65_535),
  username: ServerUserSchema,
  identityFile: RequiredTextSchema.nullable(),
  status: SshConfigImportStatusSchema,
  unsupportedDirectives: z.array(RequiredTextSchema),
  warnings: z.array(RequiredTextSchema),
}).strict();

export const SshConfigImportPreviewSchema = z.object({
  previewId: IdSchema,
  sourcePath: RequiredTextSchema,
  items: z.array(SshConfigImportItemSchema),
  warnings: z.array(SshConfigImportWarningSchema),
  warningCount: z.int().nonnegative(),
  existingCount: z.int().nonnegative(),
  importableCount: z.int().nonnegative(),
}).strict();

export const SshConfigImportApplyInputSchema = z.object({
  previewId: IdSchema,
  selectedRowIds: z.array(IdSchema).min(1, '请选择至少一台服务器').max(500),
}).strict();

export const SshConfigImportResultSchema = z.object({
  importedCount: z.int().nonnegative(),
  skippedCount: z.int().nonnegative(),
  servers: z.array(ServerSchema),
}).strict();

export type SshConfigImportStatus = z.infer<typeof SshConfigImportStatusSchema>;
export type SshConfigImportWarning = z.infer<typeof SshConfigImportWarningSchema>;
export type SshConfigImportItem = z.infer<typeof SshConfigImportItemSchema>;
export type SshConfigImportPreview = z.infer<typeof SshConfigImportPreviewSchema>;
export type SshConfigImportApplyInput = z.infer<typeof SshConfigImportApplyInputSchema>;
export type SshConfigImportResult = z.infer<typeof SshConfigImportResultSchema>;
