import { z } from 'zod';

import { CoreErrorSchema } from './errors.js';
import { IdSchema } from './ids.js';

export const AGENT_IPC_VERSION = 1 as const;
export const AGENT_IPC_MAX_FRAME_BYTES = 1024 * 1024;

const BaseFrameSchema = z.object({ version: z.literal(AGENT_IPC_VERSION) });

export const AgentEventEnvelopeSchema = z.object({
  eventName: z.string().trim().min(1).max(128),
  runId: IdSchema.optional(),
  sequence: z.int().positive().optional(),
  payload: z.unknown(),
}).strict();

export const AgentIpcFrameSchema = z.union([
  BaseFrameSchema.extend({
    type: z.literal('hello'),
    requestId: IdSchema,
    sessionId: IdSchema,
    challenge: z.string().regex(/^[0-9a-f]{64}$/u),
    sessionToken: z.string().regex(/^[0-9a-f]{64}$/u),
    storageUrl: z.string().trim().min(1),
  }).strict(),
  BaseFrameSchema.extend({
    type: z.literal('hello.ack'),
    requestId: IdSchema,
    sessionId: IdSchema,
    proof: z.string().regex(/^[0-9a-f]{64}$/u),
  }).strict(),
  BaseFrameSchema.extend({
    type: z.literal('request'),
    requestId: IdSchema,
    method: z.string().trim().min(1).max(128),
    payload: z.unknown(),
  }).strict(),
  BaseFrameSchema.extend({
    type: z.literal('response'),
    requestId: IdSchema,
    ok: z.literal(true),
    payload: z.unknown(),
  }).strict(),
  BaseFrameSchema.extend({
    type: z.literal('response'),
    requestId: IdSchema,
    ok: z.literal(false),
    error: CoreErrorSchema,
  }).strict(),
  BaseFrameSchema.extend({
    type: z.literal('event'),
    event: AgentEventEnvelopeSchema,
  }).strict(),
  BaseFrameSchema.extend({
    type: z.literal('heartbeat'),
    timestamp: z.iso.datetime({ offset: true }),
  }).strict(),
]);

export type AgentIpcFrame = z.infer<typeof AgentIpcFrameSchema>;
export type AgentEventEnvelope = z.infer<typeof AgentEventEnvelopeSchema>;

export class AgentJsonlDecoder {
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  #pending = new Uint8Array();

  push(chunk: Uint8Array): AgentIpcFrame[] {
    const combined = new Uint8Array(this.#pending.length + chunk.length);
    combined.set(this.#pending);
    combined.set(chunk, this.#pending.length);
    const frames: AgentIpcFrame[] = [];
    let start = 0;
    for (let index = 0; index < combined.length; index += 1) {
      if (combined[index] !== 0x0a) continue;
      const line = combined.slice(start, index);
      if (line.length === 0 || line.length > AGENT_IPC_MAX_FRAME_BYTES) {
        throw new Error('invalid Agent IPC frame length');
      }
      const parsed: unknown = JSON.parse(this.#decoder.decode(line));
      frames.push(AgentIpcFrameSchema.parse(parsed));
      start = index + 1;
    }
    this.#pending = combined.slice(start);
    if (this.#pending.length > AGENT_IPC_MAX_FRAME_BYTES) {
      throw new Error('Agent IPC frame exceeds 1 MiB');
    }
    return frames;
  }

  finish(): void {
    if (this.#pending.length !== 0) throw new Error('truncated Agent IPC frame');
  }
}
