// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { CoreClient } from '../../api/core';
import { TasksPage } from './task-center';

afterEach(cleanup);

describe('TasksPage', () => {
  it('shows authoritative task states and redacted audit payloads', async () => {
    const core = {
      tasks: async () => [{
        taskId: '00000000-0000-4000-8000-000000000001', sequence: 3, status: 'failed', progress: 70,
        currentStep: 'health-check', errorCode: 'HEALTH_CHECK_FAILED', createdAt: '2026-08-08T00:00:00Z',
      }],
      audits: async () => [{
        id: '00000000-0000-4000-8000-000000000002', action: 'nginx.apply', resourceType: 'nginx',
        resourceId: null, serverId: '00000000-0000-4000-8000-000000000003', result: 'failed',
        redactedPayload: { password: '[REDACTED]', rolledBack: true }, createdAt: '2026-08-08T00:00:00Z',
      }],
    } as unknown as CoreClient;
    render(<TasksPage core={core} />);

    expect(await screen.findByText('HEALTH_CHECK_FAILED')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '审计日志' }));
    expect(await screen.findByText('nginx.apply')).toBeVisible();
    expect(screen.getByText(/\[REDACTED\]/u)).toBeVisible();
  });
});
