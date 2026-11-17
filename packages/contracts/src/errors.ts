import { z } from 'zod';

export const CoreErrorCodeSchema = z.enum([
  'VALIDATION',
  'NOT_FOUND',
  'CONFLICT',
  'CANCELLED',
  'TIMEOUT',
  'CAPABILITY_UNAVAILABLE',
  'SECRET_UNAVAILABLE',
  'SSH_CONNECTION',
  'SSH_AUTHENTICATION',
  'SSH_HOST_KEY_UNKNOWN',
  'SSH_HOST_KEY_CHANGED',
  'REMOTE_PERMISSION',
  'REMOTE_COMMAND',
  'REMOTE_PARSE',
  'DOCKER_NOT_INSTALLED',
  'DOCKER_PERMISSION_DENIED',
  'DOCKER_DAEMON_UNAVAILABLE',
  'DOCKER_CONTAINER_NOT_FOUND',
  'DOCKER_SHELL_UNAVAILABLE',
  'INTERNAL',
]);

export const CoreErrorSchema = z.object({
  code: CoreErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
}).strict();

export type CoreErrorCode = z.infer<typeof CoreErrorCodeSchema>;
export type CoreError = z.infer<typeof CoreErrorSchema>;
