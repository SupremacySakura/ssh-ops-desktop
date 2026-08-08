import { z } from 'zod';

import { IdSchema } from './ids.js';

export const RuntimeTypeSchema = z.enum([
  'docker_compose', 'static_site', 'node_js', 'go', 'python', 'generic',
]);
export const DeployStrategySchema = z.enum([
  'in_place', 'release_symlink', 'docker_compose', 'static_atomic',
]);

export const ProjectRootSchema = z.string().min(2).superRefine((value, context) => {
  if (!value.startsWith('/') || /[\u0000-\u001f\u007f]/u.test(value)
    || value.split('/').includes('..')) {
    context.addIssue({ code: 'custom', message: 'project root must be a safe absolute path' });
  }
});

export const RepositoryUrlSchema = z.string().trim().min(1).refine((value) => {
  if (/\s/u.test(value)) return false;
  return value.startsWith('https://') || value.startsWith('ssh://')
    || /^[^@\s]+@[^:\s]+:[^/\s].*$/u.test(value);
});

export const ProjectInputSchema = z.object({
  serverId: IdSchema,
  name: z.string().trim().min(1),
  rootPath: ProjectRootSchema,
  repositoryUrl: RepositoryUrlSchema.optional(),
  runtime: RuntimeTypeSchema,
  deployStrategy: DeployStrategySchema,
}).strict();

export const ProjectSummarySchema = ProjectInputSchema.extend({ id: IdSchema }).strict();

export const ProjectDetectionSchema = z.object({
  primary: RuntimeTypeSchema,
  evidence: z.array(z.string().min(1)),
  confidence: z.number().min(0).max(1),
}).strict();

export type RuntimeType = z.infer<typeof RuntimeTypeSchema>;
export type DeployStrategy = z.infer<typeof DeployStrategySchema>;
export type ProjectInput = z.infer<typeof ProjectInputSchema>;
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
export type ProjectDetection = z.infer<typeof ProjectDetectionSchema>;
