import { describe, expect, it, vi } from 'vitest';

import { AgentRunCoordinator } from './runtime.js';

const runId = '019c62b2-2970-7000-8000-000000000003';

describe('Agent run coordinator', () => {
  it('emits the structured plan before any tool result', async () => {
    const events: Array<{ type: string }> = [];
    const model = {
      plan: vi.fn(async () => ({
        runId, summary: 'Inspect disk', steps: [{
          id: '019c62b2-2970-7000-8000-000000000004', title: 'Read',
          rationale: 'Observe real metrics', toolName: 'server.overview', expectedRisk: 'L0' as const,
        }],
      })),
      summarize: vi.fn(async (results: unknown[]) => `Observed ${JSON.stringify(results)}`),
    };
    const tools = { request: vi.fn(async () => ({ disk: { used: 42 } })) };
    await new AgentRunCoordinator(model, tools, (event) => events.push(event)).run(runId, 'disk usage');
    expect(events.findIndex((event) => event.type === 'plan'))
      .toBeLessThan(events.findIndex((event) => event.type === 'tool'));
    expect(model.summarize).toHaveBeenCalledWith([{ disk: { used: 42 } }], expect.any(AbortSignal));
  });

  it('emits no tool result after cancellation', async () => {
    const events: Array<{ type: string; status?: string }> = [];
    let coordinator: AgentRunCoordinator;
    const model = {
      plan: vi.fn(async () => ({ runId, summary: 'Cancel', steps: [{
        id: '019c62b2-2970-7000-8000-000000000004', title: 'Read', rationale: 'Read', toolName: 'server.overview',
      }] })),
      summarize: vi.fn(async () => 'never'),
    };
    const tools = { request: vi.fn(async () => { coordinator.cancel(); return { value: 1 }; }) };
    coordinator = new AgentRunCoordinator(model, tools, (event) => events.push(event));
    await expect(coordinator.run(runId, 'cancel')).rejects.toThrow();
    expect(events.some((event) => event.type === 'tool')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'state', status: 'cancelled' });
  });
});
