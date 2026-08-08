import { z } from 'zod';

import { ConnectionHandleSchema } from './connection.js';

export const ContainerIdentifierSchema = z.string().trim().min(1).max(128)
  .regex(/^(?!-)[A-Za-z0-9_.-]+$/u);

export const DockerVersionSchema = z.object({
  version: z.string().trim().min(1),
  apiVersion: z.string().trim().min(1),
  os: z.string().trim().min(1),
  arch: z.string().trim().min(1),
  transport: z.literal('cli'),
}).strict();

export const DockerContainerSchema = z.object({
  id: z.string().trim().min(1),
  names: z.string().trim().min(1),
  image: z.string().trim().min(1),
  state: z.string().trim().min(1),
  status: z.string().trim().min(1),
  ports: z.string(),
}).strict();

export const DockerStatsSchema = z.object({
  containerId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  cpuPercent: z.string().trim().min(1),
  memoryUsage: z.string().trim().min(1),
  memoryPercent: z.string().trim().min(1),
  networkIo: z.string().trim().min(1),
  blockIo: z.string().trim().min(1),
}).strict();

export const DockerContainerActionArgsSchema = z.object({
  connection: ConnectionHandleSchema,
  container: ContainerIdentifierSchema,
}).strict();

export const DockerContainerExecRequestSchema = DockerContainerActionArgsSchema.extend({
  columns: z.int().min(2).max(1000),
  rows: z.int().min(2).max(1000),
}).strict();

export type DockerVersion = z.infer<typeof DockerVersionSchema>;
export type DockerContainer = z.infer<typeof DockerContainerSchema>;
export type DockerStats = z.infer<typeof DockerStatsSchema>;
export type DockerContainerExecRequest = z.infer<typeof DockerContainerExecRequestSchema>;
