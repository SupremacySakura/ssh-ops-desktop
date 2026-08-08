import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const frame = JSON.parse(line);
  process.stdout.write(`${JSON.stringify({
    version: 1,
    type: 'hello.ack',
    requestId: frame.requestId,
    sessionId: frame.sessionId,
    proof: '00'.repeat(32),
  })}\n`);
  break;
}
