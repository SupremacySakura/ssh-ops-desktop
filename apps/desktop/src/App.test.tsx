// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import App from './App';

afterEach(cleanup);

describe('App health status', () => {
  it('shows explicit readiness returned through the CoreClient boundary', async () => {
    const core = {
      health: async () => ({
        version: 'test-version',
        databaseReady: true,
        secretStoreReady: true,
      }),
    };

    render(<App core={core} />);

    expect(await screen.findByText('Core 已就绪')).toBeVisible();
    expect(screen.getByText('版本 test-version')).toBeVisible();
  });

  it('shows an error instead of loading forever when Core health rejects', async () => {
    const core = {
      health: () => Promise.reject(new Error('IPC unavailable')),
    };

    render(<App core={core} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取 Core 状态');
    expect(screen.queryByText('正在检查 Core')).not.toBeInTheDocument();
  });
});
