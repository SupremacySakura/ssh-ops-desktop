import { ModelProfileSummarySchema, type ModelProfileSummary } from '@opspilot/contracts';

export type ProviderFailureKind = 'invalid_credentials' | 'rate_limited' | 'timeout' | 'provider_error';

export class ModelProviderError extends Error {
  constructor(
    readonly kind: ProviderFailureKind,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export async function testOpenAiCompatible(
  profile: ModelProfileSummary,
  apiKey: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const checked = ModelProfileSummarySchema.parse(profile);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), checked.timeoutMs);
  try {
    const response = await fetcher(`${checked.baseUrl.replace(/\/$/u, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({
        model: checked.model,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new ModelProviderError('invalid_credentials', false, 'model credentials were rejected');
    }
    if (response.status === 429) {
      throw new ModelProviderError('rate_limited', true, 'model provider rate limit reached');
    }
    if (!response.ok) {
      throw new ModelProviderError('provider_error', response.status >= 500, `model provider returned HTTP ${response.status}`);
    }
    await response.body?.cancel();
  } catch (error) {
    if (error instanceof ModelProviderError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ModelProviderError('timeout', true, 'model provider request timed out');
    }
    throw new ModelProviderError('provider_error', true, 'model provider request failed');
  } finally {
    clearTimeout(timeout);
  }
}
