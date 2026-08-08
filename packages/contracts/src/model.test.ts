import { describe, expect, it } from 'vitest';

import { ModelProfileInputSchema } from './model.js';

const valid = (baseUrl: string) => ({
  name: 'Primary', provider: 'openai-compatible' as const, baseUrl,
  model: 'example-model', timeoutMs: 30_000,
});

describe('model profile contract', () => {
  it.each([
    ['https://models.example.com/v1', true],
    ['http://127.0.0.1:11434/v1', true],
    ['http://models.example.com/v1', false],
    ['file:///tmp/model', false],
    ['https://user:secret@models.example.com/v1', false],
  ])('validates model endpoint %s', (baseUrl, accepted) => {
    expect(ModelProfileInputSchema.safeParse(valid(baseUrl)).success).toBe(accepted);
  });

  it('does not allow save and clear of a key together', () => {
    expect(ModelProfileInputSchema.safeParse({ ...valid('https://example.com/v1'), apiKey: 'secret', clearApiKey: true }).success).toBe(false);
  });
});
