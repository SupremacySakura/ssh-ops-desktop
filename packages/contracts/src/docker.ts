import { z } from 'zod';

export const DockerContainerIdSchema = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u,
  'must be a validated Docker container identifier',
);

export const DockerContainerSchema = z.object({
  id: DockerContainerIdSchema,
  names: z.array(z.string().trim().min(1).max(128)).min(1),
  image: z.string().trim().min(1),
  state: z.string().trim().min(1),
  status: z.string().trim().min(1),
  ports: z.array(z.string().trim().min(1)),
  startedAt: z.string().trim().min(1).nullable(),
}).strict();

export const DockerContainerListSchema = z.object({
  containers: z.array(DockerContainerSchema),
  startedAtWarning: z.string().trim().min(1).nullable(),
}).strict();

export const DockerActionSchema = z.enum(['start', 'stop', 'restart']);
export const DockerShellSchema = z.enum(['sh', 'bash', 'ash']);

export const DockerLogsSchema = z.object({
  containerId: DockerContainerIdSchema,
  tail: z.int().min(1).max(1_000),
  stdout: z.string(),
  stderr: z.string(),
}).strict();

export type DockerContainer = z.infer<typeof DockerContainerSchema>;
export type DockerContainerList = z.infer<typeof DockerContainerListSchema>;
export type DockerAction = z.infer<typeof DockerActionSchema>;
export type DockerShell = z.infer<typeof DockerShellSchema>;
export type DockerLogs = z.infer<typeof DockerLogsSchema>;
