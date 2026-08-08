import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { readFrames, writeFrame } from '../src/ipc.js';

const id = '019c62b2-2970-7000-8000-000000000003';

describe('Agent runtime IPC', () => {
  it('reads split chunks and writes protocol-only JSONL', async () => {
    const input = new PassThrough();
    const reading = (async () => {
      const frames = [];
      for await (const frame of readFrames(input)) frames.push(frame);
      return frames;
    })();
    const line = `${JSON.stringify({ version: 1, type: 'request', requestId: id, method: 'catalog.list', payload: {} })}\n`;
    input.write(line.slice(0, 9));
    input.end(line.slice(9));
    expect((await reading)[0]?.type).toBe('request');

    const output = new PassThrough();
    let encoded = '';
    output.on('data', (chunk: Buffer) => { encoded += chunk.toString('utf8'); });
    writeFrame(output, { version: 1, type: 'heartbeat', timestamp: '2026-08-08T12:00:00.000Z' });
    expect(JSON.parse(encoded)).toMatchObject({ version: 1, type: 'heartbeat' });
  });
});
