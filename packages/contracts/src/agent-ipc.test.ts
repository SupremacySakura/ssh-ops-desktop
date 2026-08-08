import { describe, expect, it } from 'vitest';

import { AGENT_IPC_MAX_FRAME_BYTES, AgentJsonlDecoder } from './agent-ipc.js';

const encoder = new TextEncoder();
const id = '019c62b2-2970-7000-8000-000000000003';

describe('Agent JSONL protocol', () => {
  it('decodes a split frame and multiple frames in one chunk', () => {
    const first = `${JSON.stringify({ version: 1, type: 'request', requestId: id, method: 'catalog.list', payload: {} })}\n`;
    const second = `${JSON.stringify({ version: 1, type: 'heartbeat', timestamp: '2026-08-08T12:00:00.000Z' })}\n`;
    const bytes = encoder.encode(first + second);
    const decoder = new AgentJsonlDecoder();
    expect(decoder.push(bytes.slice(0, 17))).toEqual([]);
    expect(decoder.push(bytes.slice(17)).map((frame) => frame.type)).toEqual(['request', 'heartbeat']);
    decoder.finish();
  });

  it('rejects oversized, unknown-version, and missing-request-id frames', () => {
    const decoder = new AgentJsonlDecoder();
    expect(() => decoder.push(new Uint8Array(AGENT_IPC_MAX_FRAME_BYTES + 1))).toThrow();
    expect(() => new AgentJsonlDecoder().push(encoder.encode(`${JSON.stringify({ version: 2, type: 'heartbeat', timestamp: '2026-08-08T12:00:00.000Z' })}\n`))).toThrow();
    expect(() => new AgentJsonlDecoder().push(encoder.encode(`${JSON.stringify({ version: 1, type: 'request', method: 'x', payload: {} })}\n`))).toThrow();
  });
});
