import { createHmac } from 'node:crypto';
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let ready = false;
for await (const line of lines) {
  const frame = JSON.parse(line);
  if (!ready) {
    const proof = createHmac('sha256', Buffer.from(frame.sessionToken, 'hex'))
      .update(`${frame.sessionId}${frame.challenge}`).digest('hex');
    process.stdout.write(`${JSON.stringify({
      version: 1, type: 'hello.ack', requestId: frame.requestId, sessionId: frame.sessionId, proof,
    })}\n`);
    ready = true;
    continue;
  }
  const payload = frame.method === 'catalog.list' ? [] : null;
  process.stdout.write(`${JSON.stringify({ version: 1, type: 'response', requestId: frame.requestId, ok: true, payload })}\n`);
  if (frame.method === 'shutdown') break;
}
