import { createHmac } from 'node:crypto';

import type { AgentIpcFrame } from '@opspilot/contracts';

import { readFrames, writeFrame } from './ipc.js';
import { runMastraAgent, type RuntimeProfile, type RuntimeToolDescriptor } from './runtime.js';
import { initializePrivateStorage } from './storage.js';

let authenticated = false;

for await (const frame of readFrames(process.stdin)) {
  if (!authenticated) {
    if (frame.type !== 'hello') throw new Error('hello must be the first Agent IPC frame');
    await initializePrivateStorage(frame.storageUrl);
    const token = frame.sessionToken;
    const proof = createHmac('sha256', Buffer.from(token, 'hex'))
      .update(`${frame.sessionId}${frame.challenge}`)
      .digest('hex');
    authenticated = true;
    writeFrame(process.stdout, {
      version: 1,
      type: 'hello.ack',
      requestId: frame.requestId,
      sessionId: frame.sessionId,
      proof,
    });
    continue;
  }
  if (frame.type !== 'request') throw new Error('only requests are accepted after handshake');
  const response = await responseFor(frame);
  writeFrame(process.stdout, response);
  if (frame.method === 'shutdown') process.exitCode = 0;
  if (frame.method === 'shutdown') break;
}

async function responseFor(frame: Extract<AgentIpcFrame, { type: 'request' }>): Promise<AgentIpcFrame> {
  if (frame.method === 'catalog.list') {
    return { version: 1, type: 'response', requestId: frame.requestId, ok: true, payload: [] };
  }
  if (frame.method === 'runtime.status') {
    return {
      version: 1,
      type: 'response',
      requestId: frame.requestId,
      ok: true,
      payload: { ready: true },
    };
  }
  if (frame.method === 'shutdown') {
    return { version: 1, type: 'response', requestId: frame.requestId, ok: true, payload: null };
  }
  try {
    if (frame.method === 'model.test') {
      const payload = modelPayload(frame.payload);
      const result = await runMastraAgent({
        apiKey: payload.apiKey,
        catalog: [],
        maxTokens: 1,
        profile: payload.profile,
        prompt: 'Reply with OK.',
      });
      if (!result.content) throw new Error('model returned an empty response');
      return { version: 1, type: 'response', requestId: frame.requestId, ok: true, payload: { ok: true } };
    }
    if (frame.method === 'run.start') {
      const payload = runPayload(frame.payload);
      const observations = JSON.stringify(payload.observations).slice(0, 65_536);
      const result = await runMastraAgent({
        apiKey: payload.apiKey,
        catalog: payload.catalog,
        maxTokens: 1024,
        profile: payload.profile,
        prompt: `${payload.input}\n\nTrusted Rust tool observations (JSON):\n${observations}`,
        runId: payload.runId,
      });
      return {
        version: 1,
        type: 'response',
        requestId: frame.requestId,
        ok: true,
        payload: {
          runId: payload.runId,
          summary: result.content || `Agent requested ${result.toolCalls.length} reviewed operation(s).`,
          toolCalls: result.toolCalls,
        },
      };
    }
  } catch (error) {
    if (process.env.OPSPILOT_AGENT_DEBUG === '1') console.error(error);
    return {
      version: 1,
      type: 'response',
      requestId: frame.requestId,
      ok: false,
      error: {
        code: error instanceof DOMException && error.name === 'AbortError' ? 'TIMEOUT' : 'MODEL_UNAVAILABLE',
        message: 'Agent request failed',
        retryable: true,
      },
    };
  }
  return {
    version: 1,
    type: 'response',
    requestId: frame.requestId,
    ok: false,
    error: { code: 'NOT_FOUND', message: 'Agent method is not registered', retryable: false },
  };
}

function modelPayload(value: unknown): { apiKey?: string; profile: RuntimeProfile } {
  const payload = record(value);
  return {
    ...(typeof payload.apiKey === 'string' ? { apiKey: payload.apiKey } : {}),
    profile: profile(payload.profile),
  };
}

function runPayload(value: unknown): {
  apiKey?: string;
  catalog: RuntimeToolDescriptor[];
  input: string;
  observations: unknown[];
  profile: RuntimeProfile;
  runId: string;
} {
  const payload = record(value);
  if (typeof payload.input !== 'string' || typeof payload.runId !== 'string'
    || !Array.isArray(payload.catalog) || !Array.isArray(payload.observations)) {
    throw new Error('invalid Agent run payload');
  }
  return {
    ...(typeof payload.apiKey === 'string' ? { apiKey: payload.apiKey } : {}),
    catalog: payload.catalog.map((descriptor) => {
      const item = record(descriptor);
      return {
        name: String(item.name ?? ''),
        description: String(item.description ?? ''),
        inputSchema: record(item.inputSchema),
      };
    }),
    input: payload.input,
    observations: payload.observations,
    profile: profile(payload.profile),
    runId: payload.runId,
  };
}

function profile(value: unknown): RuntimeProfile {
  const item = record(value);
  return {
    baseUrl: String(item.baseUrl ?? ''),
    model: String(item.model ?? ''),
    timeoutMs: Number(item.timeoutMs),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('expected an object');
  }
  return value as Record<string, unknown>;
}
