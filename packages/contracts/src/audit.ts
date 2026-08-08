import { z } from 'zod';

export const AuditRecordSchema = z.object({
  id: z.string().uuid(),
  action: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: z.string().nullable(),
  serverId: z.string().nullable(),
  result: z.string().min(1),
  redactedPayload: z.unknown(),
  createdAt: z.iso.datetime({ offset: true }),
}).strict();

export type AuditRecord = z.infer<typeof AuditRecordSchema>;
