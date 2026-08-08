import { describe, expect, it } from 'vitest';

import { TaskEventPageSchema } from './task.js';

describe('task event contracts', () => {
  it('accepts a resumable page with a monotonic cursor', () => {
    const parsed = TaskEventPageSchema.parse({
      events: [{
        taskId: '019fd728-ce6b-78a1-b60c-6a51b0e1a8af',
        sequence: 7,
        status: 'running',
        progress: 40,
        currentStep: 'apply',
        createdAt: '2026-08-08T10:00:00.000Z',
      }],
      hasMore: false,
      oldestAvailableSequence: 1,
    });

    expect(parsed.events[0]?.sequence).toBe(7);
  });

  it('rejects invalid progress and zero sequences', () => {
    expect(() => TaskEventPageSchema.parse({
      events: [{
        taskId: '019fd728-ce6b-78a1-b60c-6a51b0e1a8af',
        sequence: 0,
        status: 'running',
        progress: 101,
        createdAt: '2026-08-08T10:00:00.000Z',
      }],
      hasMore: false,
    })).toThrow();
  });
});
