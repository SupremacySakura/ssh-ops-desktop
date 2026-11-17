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

const DOCKER_SHELL_COMMANDS = new Set(['sh', 'bash', 'ash', 'zsh', 'busybox']);
const DOCKER_SHELL_SEGMENT = /^[A-Za-z0-9_.-]+$/u;

function isDockerShell(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return false;
  if (DOCKER_SHELL_COMMANDS.has(value)) return true;
  if (!value.startsWith('/') || value.length === 1) return false;
  return value.slice(1).split('/').every((segment) => (
    segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && DOCKER_SHELL_SEGMENT.test(segment)
  ));
}

export const DockerShellSchema = z
  .string()
  .min(1, 'shell 不能为空')
  .max(256, 'shell 路径不能超过 256 个字符')
  .refine(
    isDockerShell,
    'shell 必须是简单命令名或绝对路径，不能包含空白或 shell 元字符',
  );

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
