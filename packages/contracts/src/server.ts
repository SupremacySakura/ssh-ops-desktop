import { z } from 'zod';

import { IdSchema } from './ids.js';

export const RequiredTextSchema = z.string().trim().min(1)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
    message: 'must not contain control characters',
  });
export const ServerHostSchema = RequiredTextSchema
  .refine((value) => !value.includes('://') && !/\s/u.test(value), {
    message: 'must be a hostname without a URL scheme or whitespace',
  });
export const ServerUserSchema = RequiredTextSchema.refine((value) => !/\s/u.test(value), {
  message: 'must not contain whitespace',
});

export const ServerAuthTypeSchema = z.enum(['password', 'key']);

export const ServerSchema = z.object({
  id: IdSchema,
  name: RequiredTextSchema,
  host: ServerHostSchema,
  port: z.int().min(1).max(65_535),
  user: ServerUserSchema,
  authType: ServerAuthTypeSchema,
  secretRef: RequiredTextSchema.nullable(),
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

export const ServerInputSchema = z.object({
  name: RequiredTextSchema,
  host: ServerHostSchema,
  port: z.int().min(1, '端口必须在 1–65535 之间').max(65_535, '端口必须在 1–65535 之间'),
  user: ServerUserSchema,
  authType: ServerAuthTypeSchema,
  groupId: IdSchema.nullable().optional(),
  favorite: z.boolean(),
}).strict();

export const ServerCredentialInputSchema = z.object({
  credential: z.string().min(1, '密码或私钥不能为空'),
}).strict();

export const GroupInputSchema = z.object({
  name: RequiredTextSchema,
  sortOrder: z.int(),
}).strict();

export type ServerAuthType = z.infer<typeof ServerAuthTypeSchema>;
export type Server = z.infer<typeof ServerSchema>;
export type Group = z.infer<typeof GroupSchema>;
export type ServerInput = z.infer<typeof ServerInputSchema>;
export type ServerCredentialInput = z.infer<typeof ServerCredentialInputSchema>;
export type GroupInput = z.infer<typeof GroupInputSchema>;
