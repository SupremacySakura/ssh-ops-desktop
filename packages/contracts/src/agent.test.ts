import { describe, expect, it } from 'vitest';

import { AgentPlanSchema } from './agent.js';

describe('Agent contracts', () => {
  it('requires a bounded structured plan', () => {
    const runId = '019c62b2-2970-7000-8000-000000000003';
    expect(AgentPlanSchema.parse({
      runId,
      summary: 'Inspect disk usage',
      steps: [{
        id: '019c62b2-2970-7000-8000-000000000004',
        title: 'Read metrics',
        rationale: 'Use observed disk data',
        toolName: 'server.overview',
        expectedRisk: 'L0',
      }],
    }).runId).toBe(runId);
  });
});
