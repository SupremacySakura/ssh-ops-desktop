import { z } from 'zod';

import { IdSchema } from './ids.js';
import { ServerInputSchema, ServerSummarySchema } from './server.js';

export const ServerImportFormatSchema = z.enum(['csv', 'json']);

export const ServerImportPreviewRequestSchema = z.object({
  format: ServerImportFormatSchema,
  source: z.string().min(1),
}).strict();

const ValidImportRowSchema = z.object({
  rowId: IdSchema,
  status: z.literal('valid'),
  server: ServerInputSchema,
}).strict();

const DuplicateImportRowSchema = z.object({
  rowId: IdSchema,
  status: z.literal('duplicate'),
  server: ServerInputSchema,
}).strict();

const RejectedImportRowSchema = z.object({
  rowId: IdSchema,
  status: z.literal('error'),
  error: z.string().min(1),
}).strict();

export const ServerImportRowSchema = z.discriminatedUnion('status', [
  ValidImportRowSchema,
  DuplicateImportRowSchema,
  RejectedImportRowSchema,
]);

export const ServerImportPreviewSchema = z.object({
  importId: IdSchema,
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  rows: z.array(ServerImportRowSchema).max(10_000),
}).strict();

export const ServerImportApplyRequestSchema = z.object({
  importId: IdSchema,
  rowIds: z.array(IdSchema).min(1).max(10_000),
}).strict();

export const ServerImportApplyResultSchema = z.object({
  servers: z.array(ServerSummarySchema),
}).strict();

export type ServerImportFormat = z.infer<typeof ServerImportFormatSchema>;
export type ServerImportPreviewRequest = z.infer<
  typeof ServerImportPreviewRequestSchema
>;
export type ServerImportRow = z.infer<typeof ServerImportRowSchema>;
export type ServerImportPreview = z.infer<typeof ServerImportPreviewSchema>;
export type ServerImportApplyRequest = z.infer<
  typeof ServerImportApplyRequestSchema
>;
export type ServerImportApplyResult = z.infer<
  typeof ServerImportApplyResultSchema
>;
