// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CoreClient } from '../../api/core';
import { ModelSettings } from './model-settings';

afterEach(cleanup);

describe('ModelSettings', () => {
  it('saves through Core and clears the API key from WebView state', async () => {
    const profile = {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Production model', provider: 'openai-compatible' as const,
      baseUrl: 'https://models.example.com/v1', model: 'ops-model', timeoutMs: 30_000,
      hasApiKey: true, isDefault: true,
    };
    const core = {
      modelProfiles: vi.fn(async () => []),
      saveModelProfile: vi.fn(async () => profile),
      testModelProfile: vi.fn(async () => undefined),
    } as unknown as CoreClient;
    render(<ModelSettings core={core} />);

    await screen.findByText('尚未配置模型');
    fireEvent.change(screen.getByLabelText('配置名称'), { target: { value: profile.name } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: profile.baseUrl } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: profile.model } });
    const keyInput = screen.getByLabelText('API Key');
    fireEvent.change(keyInput, { target: { value: 'fixture-secret-never-render-again' } });
    fireEvent.click(screen.getByRole('button', { name: '保存模型配置' }));

    expect(await screen.findByText('已配置 API Key')).toBeVisible();
    await waitFor(() => expect(keyInput).toHaveValue(''));
    expect(screen.queryByDisplayValue('fixture-secret-never-render-again')).not.toBeInTheDocument();
  });
});
