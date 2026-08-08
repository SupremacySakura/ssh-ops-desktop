import { z } from 'zod';

import { IdSchema } from './ids.js';

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

export const TaskEventSchema = z.object({
  taskId: IdSchema,
  sequence: z.number().int().positive(),
  status: TaskStatusSchema,
  progress: z.number().int().min(0).max(100),
  currentStep: z.string().trim().min(1).optional(),
  errorCode: z.string().trim().min(1).optional(),
  createdAt: z.iso.datetime({ offset: true }),
}).strict();

export const TaskEventPageSchema = z.object({
  events: z.array(TaskEventSchema),
  hasMore: z.boolean(),
  oldestAvailableSequence: z.number().int().positive().optional(),
}).strict();

export type TaskEvent = z.infer<typeof TaskEventSchema>;
export type TaskEventPage = z.infer<typeof TaskEventPageSchema>;
