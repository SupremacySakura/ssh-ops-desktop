import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { AGENT_IPC_MAX_FRAME_BYTES, AgentIpcFrameSchema, type AgentIpcFrame } from '@opspilot/contracts';

export async function* readFrames(input: Readable): AsyncGenerator<AgentIpcFrame> {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (line.length === 0 || Buffer.byteLength(line, 'utf8') > AGENT_IPC_MAX_FRAME_BYTES) {
      throw new Error('invalid Agent IPC frame length');
    }
    yield AgentIpcFrameSchema.parse(JSON.parse(line) as unknown);
  }
}

export function writeFrame(output: Writable, frame: AgentIpcFrame): void {
  const line = JSON.stringify(AgentIpcFrameSchema.parse(frame));
  if (Buffer.byteLength(line, 'utf8') > AGENT_IPC_MAX_FRAME_BYTES) {
    throw new Error('Agent IPC frame exceeds 1 MiB');
  }
  output.write(`${line}\n`);
}
