import { z } from 'zod';

export const TaskStatusSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'rolling_back',
  'rolled_back',
  'rollback_failed',
]);

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
