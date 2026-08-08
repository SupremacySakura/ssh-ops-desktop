import { readFileSync } from 'node:fs';

import { $, browser, expect } from '@wdio/globals';
import type {} from '@wdio/tauri-service';

interface CoreHealth {
  version: string;
  databaseReady: boolean;
  secretStoreReady: boolean;
}

const tauriConfig = JSON.parse(
  readFileSync(new URL('../../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
) as { version?: unknown };

if (typeof tauriConfig.version !== 'string') {
  throw new Error('src-tauri/tauri.conf.json must declare a string version');
}

describe('OpsPilot native Tauri shell', () => {
  it('launches the real shell and reads Core readiness through native IPC', async () => {
    const heading = await $('h1');
    await expect(heading).toHaveText('OpsPilot');

    const health = (await browser.tauri.execute(({ core }) =>
      core.invoke('core_health'),
    )) as CoreHealth;

    expect(health.version).toBe(tauriConfig.version);
    expect(health.databaseReady).toBe(true);

    if (!health.secretStoreReady) {
      throw new Error(
        'Native E2E requires an available operating-system credential store; configure the host keyring before running this suite.',
      );
    }

    expect(health.secretStoreReady).toBe(true);
    expect(await $('main').getText()).toContain('Core 已就绪');
  });

  it('allows the server catalog IPC surface through the main window ACL', async () => {
    const servers = await browser.tauri.execute(({ core }) => core.invoke('server_list'));

    expect(Array.isArray(servers)).toBe(true);
  });
});
