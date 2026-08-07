import { fileURLToPath } from 'node:url';

import type { TauriCapabilities } from '@wdio/tauri-service';

const noProxy = new Set(
  [process.env.NO_PROXY, process.env.no_proxy, '127.0.0.1', 'localhost']
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(',')),
);
process.env.NO_PROXY = [...noProxy].join(',');
process.env.no_proxy = process.env.NO_PROXY;

const binaryName = process.platform === 'win32' ? 'opspilot-desktop.exe' : 'opspilot-desktop';
const appBinaryPath = fileURLToPath(new URL(`../../../target/debug/${binaryName}`, import.meta.url));
const capabilities: TauriCapabilities = {
  browserName: 'tauri',
  'tauri:options': {
    application: appBinaryPath,
  },
};

export const config = {
  runner: 'local',
  specs: ['./app-shell.e2e.ts'],
  maxInstances: 1,
  capabilities: [capabilities],
  services: [
    [
      '@wdio/tauri-service',
      {
        appBinaryPath,
        driverProvider: 'embedded',
        embeddedPort: 4445,
      },
    ],
  ],
  outputDir: './test-results/native',
  reporters: ['spec'],
  logLevel: 'info',
  bail: 0,
  waitforTimeout: 10_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 0,
  framework: 'mocha',
  mochaOpts: {
    ui: 'bdd',
    timeout: 120_000,
  },
} satisfies WebdriverIO.Config;
