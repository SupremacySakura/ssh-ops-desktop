import { describe, expect, it } from 'vitest';

import { ApprovalProofSchema, ApprovalRequestSchema } from './approval.js';

const id = '018f0a9a-9c2e-7d25-a4b1-9b8701b6d3f4';

describe('approval contracts', () => {
  it('keeps the confirmation target separate from display text', () => {
    const approval = ApprovalRequestSchema.parse({
      approvalId: id,
      toolCallId: id,
      runId: id,
      serverId: id,
      toolName: 'nginx.apply',
      argsDigest: 'a'.repeat(64),
      risk: {
        level: 'L3',
        approvalRequired: true,
        snapshotRequired: true,
        confirmationText: '请输入资源名以确认',
        reason: 'production configuration overwrite',
      },
      targetLabel: '/etc/nginx/nginx.conf',
      confirmationTarget: '/etc/nginx/nginx.conf',
      impactSummary: 'replace one configuration file',
      expiresAt: '2026-08-08T12:00:00.000Z',
    });

    expect(approval.confirmationTarget).toBe('/etc/nginx/nginx.conf');
    expect(approval.risk.confirmationText).not.toBe(approval.confirmationTarget);
  });

  it('binds a proof to approval, tool call, digest, and optional resource', () => {
    expect(ApprovalProofSchema.parse({
      approvalId: id,
      toolCallId: id,
      argsDigest: 'f'.repeat(64),
      confirmedResource: '/srv/app',
    })).toEqual({
      approvalId: id,
      toolCallId: id,
      argsDigest: 'f'.repeat(64),
      confirmedResource: '/srv/app',
    });
    expect(ApprovalProofSchema.safeParse({
      approvalId: id,
      toolCallId: id,
      argsDigest: 'not-a-digest',
    }).success).toBe(false);
  });
});
