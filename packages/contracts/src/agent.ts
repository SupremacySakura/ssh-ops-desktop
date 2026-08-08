import { z } from 'zod';

import { IdSchema } from './ids.js';
import { ConnectionHandleSchema } from './connection.js';
import { RiskLevelSchema } from './risk.js';

export const AgentRunStatusSchema = z.enum([
  'planning', 'awaiting_tool', 'awaiting_approval', 'executing', 'summarizing',
  'succeeded', 'failed', 'cancelled', 'recovery_required',
]);

export const AgentPlanStepSchema = z.object({
  id: IdSchema,
  title: z.string().trim().min(1).max(256),
  rationale: z.string().trim().min(1).max(2_048),
  toolName: z.string().trim().min(1).max(128).optional(),
  targetLabel: z.string().trim().min(1).max(512).optional(),
  expectedRisk: RiskLevelSchema.optional(),
}).strict();

export const AgentPlanSchema = z.object({
  runId: IdSchema,
  summary: z.string().trim().min(1).max(4_096),
  steps: z.array(AgentPlanStepSchema).max(50),
}).strict();

export const AgentThreadSummarySchema = z.object({
  id: IdSchema,
  title: z.string().trim().min(1).max(256),
  contextSummary: z.string().max(64 * 1024),
  summaryVersion: z.int().positive(),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();

export const AgentRunSummarySchema = z.object({
  id: IdSchema,
  threadId: IdSchema,
  serverId: IdSchema,
  modelProfileId: IdSchema.nullable(),
  status: AgentRunStatusSchema,
  sequence: z.int().positive(),
  inputSummary: z.string().max(4_096),
  outputSummary: z.string().max(8_192).nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();

export const AgentRunStartInputSchema = z.object({
  threadId: IdSchema,
  serverId: IdSchema,
  modelProfileId: IdSchema,
  connection: ConnectionHandleSchema,
  input: z.string().trim().min(1).max(4_096),
}).strict().superRefine((value, context) => {
  if (value.connection.serverId !== value.serverId) {
    context.addIssue({ code: 'custom', message: 'Agent connection must belong to the selected server' });
  }
});

export const AgentToolDescriptorSchema = z.object({
  name: z.string().trim().min(1).max(128),
  schemaVersion: z.literal(1),
  description: z.string().trim().min(1),
  inputSchema: z.record(z.string(), z.unknown()),
}).strict();

export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;
export type AgentPlan = z.infer<typeof AgentPlanSchema>;
export type AgentPlanStep = z.infer<typeof AgentPlanStepSchema>;
export type AgentThreadSummary = z.infer<typeof AgentThreadSummarySchema>;
export type AgentRunSummary = z.infer<typeof AgentRunSummarySchema>;
export type AgentRunStartInput = z.infer<typeof AgentRunStartInputSchema>;
export type AgentToolDescriptor = z.infer<typeof AgentToolDescriptorSchema>;
