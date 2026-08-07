import { defineConfig, devices } from '@playwright/test';

const noProxy = new Set(
  [process.env.NO_PROXY, process.env.no_proxy, '127.0.0.1', 'localhost']
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(',')),
);
process.env.NO_PROXY = [...noProxy].join(',');
process.env.no_proxy = process.env.NO_PROXY;

export default defineConfig({
  testDir: './tests/e2e/renderer',
  outputDir: 'test-results/renderer',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report/renderer' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:1421',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm --filter @opspilot/desktop exec vite ../../tests/e2e/renderer/fixture --host 127.0.0.1 --port 1421 --strictPort',
    reuseExistingServer: process.env.CI !== 'true',
    url: 'http://127.0.0.1:1421',
  },
  projects: [
    {
      name: 'renderer-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
