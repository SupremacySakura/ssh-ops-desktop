import { describe, expect, it } from 'vitest';

import { OperationPrepareResultSchema, OperationTaskRefSchema } from './operation.js';

const ids = {
  approvalId: '7f8b67b4-f7df-43dc-820c-84145b1c9e80',
  runId: 'c9544d4c-c95f-4237-a9db-94c87abcfa0c',
  serverId: '1d3e5835-9b8d-47ea-9077-28ebcf2fd5ab',
  taskId: '11340886-6739-4fb0-bfa2-6f8f555dad01',
  toolCallId: 'b3ab6dbe-fe03-4ab6-a7f1-0089b76f7fa2',
};

describe('operation contracts', () => {
  it('accepts the flattened Rust awaiting-approval representation', () => {
    const result = OperationPrepareResultSchema.parse({
      kind: 'awaiting_approval',
      approvalId: ids.approvalId,
      toolCallId: ids.toolCallId,
      runId: ids.runId,
      serverId: ids.serverId,
      toolName: 'nginx.apply',
      argsDigest: 'a'.repeat(64),
      risk: {
        level: 'L3',
        approvalRequired: true,
        snapshotRequired: true,
        confirmationText: '/etc/nginx/nginx.conf',
        reason: 'production configuration replacement',
      },
      targetLabel: '/etc/nginx/nginx.conf',
      confirmationTarget: '/etc/nginx/nginx.conf',
      impactSummary: 'validate and reload Nginx',
      expiresAt: '2026-08-08T12:00:00Z',
    });

    expect(result.kind).toBe('awaiting_approval');
  });

  it('rejects malformed digests in submitted tasks', () => {
    expect(() => OperationTaskRefSchema.parse({
      taskId: ids.taskId,
      toolCallId: ids.toolCallId,
      argsDigest: 'not-a-digest',
    })).toThrow();
  });
});
