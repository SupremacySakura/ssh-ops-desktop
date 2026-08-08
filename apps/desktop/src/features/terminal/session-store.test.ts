import { describe, expect, it } from 'vitest';

import { createTerminalSessionStore } from './session-store';

describe('terminal session store', () => {
  it('isolates tabs, drops old chunks, and marks gaps without fabricating output', () => {
    const store = createTerminalSessionStore();
    store.open('tab-a', 'server-a', 'web-01');
    store.open('tab-b', 'server-a', 'web-01 #2');
    expect(store.accept({ terminalSessionId: 'tab-a', sequence: 1, bytes: [111, 110, 101] })).toBe('accepted');
    expect(store.accept({ terminalSessionId: 'tab-a', sequence: 3, bytes: [116, 104, 114, 101, 101] })).toBe('gap');
    expect(store.accept({ terminalSessionId: 'tab-a', sequence: 2, bytes: [116, 119, 111] })).toBe('old');

    expect(store.get('tab-a')).toMatchObject({ output: 'onethree', outputMayHaveGap: true, lastSequence: 3 });
    expect(store.get('tab-b')).toMatchObject({ output: '', outputMayHaveGap: false, lastSequence: 0 });
  });
});
