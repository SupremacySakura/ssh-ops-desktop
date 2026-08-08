import { z } from 'zod';

import { IdSchema } from './ids.js';

const hasControlCharacter = (value: string): boolean => [...value].some((character) => {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint < 32 || codePoint === 127;
});

const TrimmedRequiredTextSchema = z.string()
  .trim()
  .min(1)
  .refine((value) => !hasControlCharacter(value), {
    message: 'must not contain control characters',
  });

export const ServerEnvironmentSchema = z.enum([
  'development',
  'staging',
  'production',
  'other',
]);

export const ServerAuthTypeSchema = z.enum([
  'password',
  'private_key',
  'ssh_agent',
  'certificate',
]);

export const ServerHostSchema = TrimmedRequiredTextSchema
  .refine((value) => !value.includes('://'), {
    message: 'must be a host, not a URL',
  })
  .transform((value) => value.toLowerCase());

export const ServerPortSchema = z.int().min(1).max(65_535);

export const ServerInputSchema = z.object({
  name: TrimmedRequiredTextSchema,
  host: ServerHostSchema,
  port: ServerPortSchema,
  username: TrimmedRequiredTextSchema,
  environment: ServerEnvironmentSchema,
  authType: ServerAuthTypeSchema,
  groupId: IdSchema.optional(),
  tagIds: z.array(IdSchema),
}).strict();

export const ServerSummarySchema = ServerInputSchema.extend({
  id: IdSchema,
  lastConnectedAt: z.iso.datetime({ offset: true }).optional(),
}).strict();

export const ServerDeleteRequestSchema = z.object({
  serverId: IdSchema,
  confirmed: z.literal(true),
}).strict();

export const ServerCredentialSetRequestSchema = z.object({
  serverId: IdSchema,
  secret: z.string().min(1).max(64 * 1024),
}).strict();

export const ServerGroupInputSchema = z.object({
  name: TrimmedRequiredTextSchema,
  sortOrder: z.int(),
}).strict();

export const ServerGroupSchema = ServerGroupInputSchema.extend({
  id: IdSchema,
}).strict();

export const ServerTagInputSchema = z.object({
  name: TrimmedRequiredTextSchema,
}).strict();

export const ServerTagSchema = ServerTagInputSchema.extend({
  id: IdSchema,
}).strict();

export type ServerEnvironment = z.infer<typeof ServerEnvironmentSchema>;
export type ServerAuthType = z.infer<typeof ServerAuthTypeSchema>;
export type ServerInput = z.infer<typeof ServerInputSchema>;
export type ServerSummary = z.infer<typeof ServerSummarySchema>;
export type ServerDeleteRequest = z.infer<typeof ServerDeleteRequestSchema>;
export type ServerCredentialSetRequest = z.infer<typeof ServerCredentialSetRequestSchema>;
export type ServerGroupInput = z.infer<typeof ServerGroupInputSchema>;
export type ServerGroup = z.infer<typeof ServerGroupSchema>;
export type ServerTagInput = z.infer<typeof ServerTagInputSchema>;
export type ServerTag = z.infer<typeof ServerTagSchema>;
