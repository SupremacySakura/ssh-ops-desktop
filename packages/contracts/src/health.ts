import { z } from 'zod';

export const CoreHealthSchema = z.object({
  version: z.string().trim().min(1),
  databaseReady: z.boolean(),
  secretStoreReady: z.boolean(),
}).strict();

export type CoreHealth = z.infer<typeof CoreHealthSchema>;
