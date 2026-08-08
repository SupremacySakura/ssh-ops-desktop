import { describe, expect, it, vi } from 'vitest';

import { ModelProviderError, testOpenAiCompatible } from './openai-compatible.js';

const profile = {
  id: '019c62b2-2970-7000-8000-000000000003',
  name: 'Mock', provider: 'openai-compatible' as const,
  baseUrl: 'http://127.0.0.1:11434/v1', model: 'mock', timeoutMs: 1_000,
  hasApiKey: true, isDefault: true,
};

describe('OpenAI-compatible provider', () => {
  it.each([
    [401, 'invalid_credentials', false],
    [429, 'rate_limited', true],
    [500, 'provider_error', true],
  ] as const)('maps HTTP %s without exposing bodies', async (status, kind, retryable) => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('secret body', { status }));
    const error = await testOpenAiCompatible(profile, 'fixture-key', fetcher)
      .then(() => undefined, (value: unknown) => value);
    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error).toMatchObject({ kind, retryable });
    expect(String(error)).not.toContain('secret body');
  });

  it('sends a bounded generation request instead of relying on a models endpoint', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }));
    await testOpenAiCompatible(profile, 'fixture-key', fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toContain('/chat/completions');
    expect(String(init?.body)).toContain('"max_tokens":1');
  });
});
