import { describe, expect, it } from 'vitest';

import { SequenceTracker } from './event-sequence.js';

describe('SequenceTracker', () => {
  it('detects gaps, drops old events, and isolates streams', () => {
    const tracker = new SequenceTracker();
    expect(tracker.accept('task-a', 1)).toBe('accept');
    expect(tracker.accept('task-a', 3)).toBe('gap');
    expect(tracker.cursor('task-a')).toBe(1);
    expect(tracker.accept('task-a', 1)).toBe('drop_old');
    expect(tracker.accept('task-b', 7)).toBe('accept');
    tracker.resume('task-a', 2);
    expect(tracker.accept('task-a', 3)).toBe('accept');
  });
});
