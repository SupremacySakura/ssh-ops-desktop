import { z } from 'zod';

import { IdSchema } from './ids.js';
import { ConnectionHandleSchema } from './connection.js';
import { ServerEnvironmentSchema } from './server.js';

export const ServiceManagerSchema = z.enum(['systemd', 'unsupported']);
export const OsReleaseSchema = z.object({
  id: z.string().trim().min(1),
  versionId: z.string().trim().min(1),
  prettyName: z.string().trim().min(1),
  serviceManager: ServiceManagerSchema,
}).strict();

export const MemoryMetricSchema = z.object({
  totalBytes: z.int().nonnegative(),
  availableBytes: z.int().nonnegative(),
  usedBytes: z.int().nonnegative(),
}).strict();

export const LoadMetricSchema = z.object({
  one: z.number().nonnegative(),
  five: z.number().nonnegative(),
  fifteen: z.number().nonnegative(),
}).strict();

export const DiskMetricSchema = z.object({
  filesystem: z.string().min(1),
  totalBytes: z.int().nonnegative(),
  usedBytes: z.int().nonnegative(),
  availableBytes: z.int().nonnegative(),
  mountPoint: z.string().min(1),
}).strict();

export const LinuxMetricsSchema = z.object({
  timestamp: z.iso.datetime({ offset: true }),
  memory: MemoryMetricSchema.optional(),
  load: LoadMetricSchema.optional(),
  disks: z.array(DiskMetricSchema),
  unavailable: z.array(z.string().min(1)),
}).strict();

export const ServiceActionSchema = z.enum(['start', 'stop', 'restart']);

export const ServiceActionArgsSchema = z.object({
  connection: ConnectionHandleSchema,
  unit: z.string().trim().max(256).regex(/^[A-Za-z0-9@_.:-]+\.service$/u),
}).strict();

export const SystemServiceSchema = z.object({
  unit: z.string().trim().endsWith('.service'),
  loadState: z.string().trim().min(1),
  activeState: z.string().trim().min(1),
  subState: z.string().trim().min(1),
  description: z.string().trim().min(1),
}).strict();

export const ListeningPortSchema = z.object({
  protocol: z.enum(['tcp', 'udp']),
  address: z.string().min(1),
  port: z.int().min(1).max(65535),
  process: z.string().min(1).optional(),
}).strict();

export const SystemOverviewSchema = z.object({
  serverId: IdSchema,
  environment: ServerEnvironmentSchema,
  os: OsReleaseSchema,
}).strict();

export type LinuxMetrics = z.infer<typeof LinuxMetricsSchema>;
export type SystemOverview = z.infer<typeof SystemOverviewSchema>;
export type ServiceAction = z.infer<typeof ServiceActionSchema>;
export type OsRelease = z.infer<typeof OsReleaseSchema>;
export type SystemService = z.infer<typeof SystemServiceSchema>;
export type ListeningPort = z.infer<typeof ListeningPortSchema>;
