import { z } from 'zod';

import { ApprovalRequestSchema } from './approval.js';
import { IdSchema } from './ids.js';
import { RiskDecisionSchema } from './risk.js';

export const OperationPrepareResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('read_completed'), toolCallId: IdSchema, result: z.unknown() }).strict(),
  ApprovalRequestSchema.extend({ kind: z.literal('awaiting_approval') }).strict(),
  z.object({ kind: z.literal('blocked'), toolCallId: IdSchema, risk: RiskDecisionSchema }).strict(),
]);

export const OperationTaskRefSchema = z.object({
  taskId: IdSchema,
  toolCallId: IdSchema,
  argsDigest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export type OperationPrepareResult = z.infer<typeof OperationPrepareResultSchema>;
export type OperationTaskRef = z.infer<typeof OperationTaskRefSchema>;
