import { z } from 'zod';

import { IdSchema } from './ids.js';

const HostSchema = z.string().trim().min(1).max(255)
  .refine((value) => !/[\u0000-\u0020\u007f]/u.test(value) && !value.includes('://'));
const PortSchema = z.int().min(0).max(65_535);
const TargetPortSchema = z.int().min(1).max(65_535);

export const TunnelDirectionSchema = z.enum(['local', 'remote', 'dynamic']);

export const TunnelRuleSchema = z.object({
  direction: TunnelDirectionSchema,
  bindHost: HostSchema.default('127.0.0.1'),
  bindPort: PortSchema,
  targetHost: HostSchema.optional(),
  targetPort: TargetPortSchema.optional(),
  publicBindConfirmed: z.boolean().default(false),
}).strict().superRefine((rule, context) => {
  if (['0.0.0.0', '::'].includes(rule.bindHost) && !rule.publicBindConfirmed) {
    context.addIssue({ code: 'custom', path: ['publicBindConfirmed'], message: 'public bind must be confirmed' });
  }
  const hasTarget = rule.targetHost !== undefined && rule.targetPort !== undefined;
  if (rule.direction === 'dynamic' ? hasTarget : !hasTarget) {
    context.addIssue({ code: 'custom', message: 'target fields do not match tunnel direction' });
  }
});

export const RemoteSocketPathSchema = z.string().min(2).max(4_096).superRefine((value, context) => {
  if (!value.startsWith('/') || /[\u0000-\u001f\u007f]/u.test(value)
    || value.split('/').includes('..')) {
    context.addIssue({ code: 'custom', message: 'remote socket path must be a safe absolute path' });
  }
});

export const ActiveTunnelSchema = z.object({
  id: IdSchema,
  rule: TunnelRuleSchema,
  boundPort: z.int().min(1).max(65_535),
}).strict();

export type TunnelDirection = z.infer<typeof TunnelDirectionSchema>;
export type TunnelRule = z.infer<typeof TunnelRuleSchema>;
export type RemoteSocketPath = z.infer<typeof RemoteSocketPathSchema>;
export type ActiveTunnel = z.infer<typeof ActiveTunnelSchema>;
