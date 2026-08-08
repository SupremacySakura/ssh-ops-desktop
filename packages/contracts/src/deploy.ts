import { z } from 'zod';

import { IdSchema } from './ids.js';

export const GitRevisionSchema = z.string().trim().min(1).max(256)
  .regex(/^(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u);

export const DeploymentPlanSchema = z.object({
  projectId: IdSchema,
  releaseId: IdSchema,
  revision: GitRevisionSchema,
  releasePath: z.string().startsWith('/'),
  currentPath: z.string().startsWith('/'),
  commands: z.array(z.string().trim().min(1)),
  healthUrl: z.url().optional(),
  impactSummary: z.string().trim().min(1),
}).strict();

export const DeployRunArgsSchema = z.object({
  connection: z.object({ serverId: IdSchema, connectionId: IdSchema }).strict(),
  projectId: IdSchema,
  revision: GitRevisionSchema,
  healthUrl: z.url().optional(),
}).strict();

export type DeploymentPlan = z.infer<typeof DeploymentPlanSchema>;
export type DeployRunArgs = z.infer<typeof DeployRunArgsSchema>;
