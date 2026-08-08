import { z } from 'zod';

import { IdSchema } from './ids.js';

export const ModelBaseUrlSchema = z.url().superRefine((value, context) => {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username !== '' || url.password !== '' || url.hash !== '') {
    context.addIssue({
      code: 'custom',
      message: 'model endpoint must use HTTPS or loopback HTTP without credentials or fragments',
    });
  }
});

export const ModelProfileInputSchema = z.object({
  id: IdSchema.optional(),
  name: z.string().trim().min(1).max(128),
  provider: z.literal('openai-compatible'),
  baseUrl: ModelBaseUrlSchema,
  model: z.string().trim().min(1).max(256),
  timeoutMs: z.int().min(1_000).max(300_000),
  apiKey: z.string().min(1).max(64 * 1024).optional(),
  clearApiKey: z.boolean().optional(),
  isDefault: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.apiKey !== undefined && value.clearApiKey === true) {
    context.addIssue({ code: 'custom', message: 'apiKey and clearApiKey are mutually exclusive' });
  }
});

export const ModelProfileSummarySchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1),
  provider: z.literal('openai-compatible'),
  baseUrl: ModelBaseUrlSchema,
  model: z.string().trim().min(1),
  timeoutMs: z.int().min(1_000).max(300_000),
  hasApiKey: z.boolean(),
  isDefault: z.boolean(),
}).strict();

export type ModelProfileInput = z.infer<typeof ModelProfileInputSchema>;
export type ModelProfileSummary = z.infer<typeof ModelProfileSummarySchema>;
