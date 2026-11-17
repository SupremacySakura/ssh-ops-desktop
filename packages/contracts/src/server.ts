import { z } from 'zod';

import { IdSchema } from './ids.js';

const RequiredTextSchema = z.string().trim().min(1)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
    message: 'must not contain control characters',
  });

export const ServerAuthTypeSchema = z.enum(['password', 'key']);

export const ServerSchema = z.object({
  id: IdSchema,
  name: RequiredTextSchema,
  host: RequiredTextSchema
    .refine((value) => !value.includes('://') && !/\s/u.test(value), {
      message: 'must be a hostname without a URL scheme or whitespace',
    }),
  port: z.int().min(1).max(65_535),
  user: RequiredTextSchema.refine((value) => !/\s/u.test(value), {
    message: 'must not contain whitespace',
  }),
  authType: ServerAuthTypeSchema,
  secretRef: RequiredTextSchema,
  groupId: IdSchema.nullable().optional(),
  favorite: z.boolean(),
  lastConnectedAt: z.int().nonnegative().nullable().optional(),
  createdAt: z.int().nonnegative(),
}).strict();

export const GroupSchema = z.object({
  id: IdSchema,
  name: RequiredTextSchema,
  sortOrder: z.int(),
}).strict();

export type ServerAuthType = z.infer<typeof ServerAuthTypeSchema>;
export type Server = z.infer<typeof ServerSchema>;
export type Group = z.infer<typeof GroupSchema>;
