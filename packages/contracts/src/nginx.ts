import { z } from 'zod';

import { ConnectionHandleSchema } from './connection.js';

export const NginxPathSchema = z.string().trim().min(2).max(4096).superRefine((value, context) => {
  if (!value.startsWith('/') || /[\u0000-\u001f\u007f]/u.test(value)
    || value.split('/').includes('..')) {
    context.addIssue({ code: 'custom', message: 'Nginx path must be a safe absolute path' });
  }
});

export const NginxApplyArgsSchema = z.object({
  connection: ConnectionHandleSchema,
  livePath: NginxPathSchema,
  mainConfigPath: NginxPathSchema,
  candidate: z.string().min(1).max(1024 * 1024).refine((value) => !value.includes('\0')),
  healthUrl: z.url().optional(),
  confirmationTarget: NginxPathSchema,
}).strict().superRefine((value, context) => {
  if (value.confirmationTarget !== value.livePath) {
    context.addIssue({ code: 'custom', path: ['confirmationTarget'], message: 'confirmation must match live path' });
  }
});

export const NginxApplyResultSchema = z.object({
  backupPath: NginxPathSchema,
  livePath: NginxPathSchema,
  rolledBack: z.boolean(),
}).strict();

export type NginxApplyArgs = z.infer<typeof NginxApplyArgsSchema>;
export type NginxApplyResult = z.infer<typeof NginxApplyResultSchema>;
