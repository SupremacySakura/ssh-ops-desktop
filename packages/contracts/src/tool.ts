import { z } from 'zod';

import { IdSchema } from './ids.js';

export const ToolCallSchema = z.object({
  toolCallId: IdSchema,
  runId: IdSchema,
  serverId: IdSchema,
  name: z.string().regex(/^[a-z][a-z0-9_.-]+$/),
  schemaVersion: z.literal(1),
  args: z.unknown(),
}).strict();

export type ToolCall = z.infer<typeof ToolCallSchema>;
