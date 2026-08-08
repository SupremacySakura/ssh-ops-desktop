// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ApprovalRequest } from '@opspilot/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RiskDecisionDialog } from './risk-decision-dialog';

afterEach(cleanup);

const request: ApprovalRequest = {
  approvalId: '00000000-0000-4000-8000-000000000001',
  toolCallId: '00000000-0000-4000-8000-000000000002',
  runId: '00000000-0000-4000-8000-000000000003',
  serverId: '00000000-0000-4000-8000-000000000004',
  toolName: 'nginx.apply',
  argsDigest: 'a'.repeat(64),
  risk: {
    level: 'L3', approvalRequired: true, snapshotRequired: true,
    confirmationText: '输入目标资源名后继续', reason: '将替换生产配置并重载 Nginx',
  },
  targetLabel: 'production / nginx / web-01',
  confirmationTarget: 'web-01',
  impactSummary: '替换站点配置并重载服务',
  expiresAt: '2026-08-08T12:00:00+08:00',
};

describe('RiskDecisionDialog', () => {
  it('requires the exact Core-provided L3 target and submits a bound proof', () => {
    const approve = vi.fn();
    render(<RiskDecisionDialog environment="production" request={request} onApprove={approve} onReject={vi.fn()} />);

    expect(screen.getByText('生产环境')).toBeVisible();
    expect(screen.getByText(request.risk.reason)).toBeVisible();
    expect(screen.getByText(request.risk.confirmationText!)).toBeVisible();
    expect(screen.getByText(request.argsDigest)).toBeVisible();
    expect(screen.getByRole('button', { name: '确认执行' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('确认目标资源'), { target: { value: 'web-02' } });
    expect(screen.getByRole('button', { name: '确认执行' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('确认目标资源'), { target: { value: 'web-01' } });
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));

    expect(approve).toHaveBeenCalledWith({
      approvalId: request.approvalId,
      toolCallId: request.toolCallId,
      argsDigest: request.argsDigest,
      confirmedResource: 'web-01',
    });
  });

  it('never exposes an approval action for L4', () => {
    render(<RiskDecisionDialog
      environment="production"
      request={{ ...request, risk: { ...request.risk, level: 'L4', approvalRequired: false } }}
      onApprove={vi.fn()}
      onReject={vi.fn()}
    />);

    expect(screen.getByText('产品不提供结构化执行')).toBeVisible();
    expect(screen.queryByRole('button', { name: '确认执行' })).not.toBeInTheDocument();
  });
});
