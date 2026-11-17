import { z } from 'zod';

const ByteCountSchema = z.int().nonnegative();
const PercentageSchema = z.number().finite().min(0);

export const MonitorUnavailableSchema = z.enum([
  'cpu',
  'cpu_warming_up',
  'memory',
  'disk',
  'load',
  'uptime',
  'processes',
  'processes_partial',
]);

export const MonitorMemorySchema = z.object({
  totalBytes: ByteCountSchema,
  availableBytes: ByteCountSchema,
  usedBytes: ByteCountSchema,
}).strict();

export const MonitorDiskSchema = z.object({
  filesystem: z.string().min(1),
  totalBytes: ByteCountSchema,
  usedBytes: ByteCountSchema,
  availableBytes: ByteCountSchema,
  mountPoint: z.literal('/'),
}).strict();

export const MonitorLoadSchema = z.object({
  one: PercentageSchema,
  five: PercentageSchema,
  fifteen: PercentageSchema,
}).strict();

export const MonitorProcessSchema = z.object({
  pid: z.int().positive(),
  user: z.string().min(1),
  name: z.string().min(1),
  cpuPercent: PercentageSchema,
  memoryPercent: PercentageSchema,
}).strict();

export const MonitorSnapshotSchema = z.object({
  timestamp: z.string().trim().min(1).refine(
    (value) => !Number.isNaN(Date.parse(value)),
    { message: '监控采样时间无效' },
  ),
  cpuPercent: z.number().finite().min(0).max(100).optional(),
  memory: MonitorMemorySchema.optional(),
  disk: MonitorDiskSchema.optional(),
  load: MonitorLoadSchema.optional(),
  uptimeSeconds: ByteCountSchema.optional(),
  topProcesses: z.array(MonitorProcessSchema).max(20),
  unavailable: z.array(MonitorUnavailableSchema),
}).strict();

export type MonitorUnavailable = z.infer<typeof MonitorUnavailableSchema>;
export type MonitorMemory = z.infer<typeof MonitorMemorySchema>;
export type MonitorDisk = z.infer<typeof MonitorDiskSchema>;
export type MonitorLoad = z.infer<typeof MonitorLoadSchema>;
export type MonitorProcess = z.infer<typeof MonitorProcessSchema>;
export type MonitorSnapshot = z.infer<typeof MonitorSnapshotSchema>;
