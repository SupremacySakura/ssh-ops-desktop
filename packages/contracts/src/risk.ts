import { z } from 'zod';

export const RiskLevelSchema = z.enum(['L0', 'L1', 'L2', 'L3', 'L4']);

export const RiskDecisionSchema = z.object({
  level: RiskLevelSchema,
  approvalRequired: z.boolean(),
  snapshotRequired: z.boolean(),
  confirmationText: z.string().min(1).optional(),
  reason: z.string().min(1),
}).strict();

export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type RiskDecision = z.infer<typeof RiskDecisionSchema>;
