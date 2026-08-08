import { z } from 'zod';

export const HealthCheckPolicySchema = z.object({
  url: z.url().refine((value) => value.startsWith('http://') || value.startsWith('https://')),
  deadlineMs: z.int().min(1_000).max(300_000).default(60_000),
  requestTimeoutMs: z.int().min(100).max(30_000).default(10_000),
  successThreshold: z.int().min(1).max(10).default(1),
  failureThreshold: z.int().min(1).max(10).default(1),
}).strict();

export type HealthCheckPolicy = z.infer<typeof HealthCheckPolicySchema>;
