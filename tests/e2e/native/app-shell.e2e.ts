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
    await expect(heading).toHaveText('服务器总览');

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
    expect(await $('body').getText()).toContain('Core 已就绪');

    await $('button[title="终端"]').click();
    // keep-alive 下已访问页面保持挂载（隐藏），必须定位目标页面的标题而非第一个 h1。
    const terminalHeading = await $('.terminal-page h1');
    await terminalHeading.waitForDisplayed();
    await expect(terminalHeading).toHaveText('远程终端');
  });

  it('allows the server catalog IPC surface through the main window ACL', async () => {
    const servers = await browser.tauri.execute(({ core }) => core.invoke('server_list'));

    expect(Array.isArray(servers)).toBe(true);
  });
});
