import { z } from 'zod';

import { IdSchema } from './ids.js';
import { RiskDecisionSchema } from './risk.js';

const ArgsDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const ApprovalRequestSchema = z.object({
  approvalId: IdSchema,
  toolCallId: IdSchema,
  runId: IdSchema,
  serverId: IdSchema,
  toolName: z.string().trim().min(1).max(128),
  argsDigest: ArgsDigestSchema,
  risk: RiskDecisionSchema,
  targetLabel: z.string().trim().min(1),
  confirmationTarget: z.string().trim().min(1).optional(),
  impactSummary: z.string().trim().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict();

export const ApprovalProofSchema = z.object({
  approvalId: IdSchema,
  toolCallId: IdSchema,
  argsDigest: ArgsDigestSchema,
  confirmedResource: z.string().trim().min(1).optional(),
}).strict();

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type ApprovalProof = z.infer<typeof ApprovalProofSchema>;
