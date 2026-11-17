import { expect, test } from '@playwright/test';

test('Harbor empty shell renders the calibrated foundation', async ({ page }) => {
  await page.goto('/');

  await expect(
    page.getByRole('heading', { level: 1, name: 'HARBOR', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('searchbox', { name: '搜索服务器' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '还没有服务器' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '未选择服务器' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Core 状态' })).toContainText('Core 已就绪');

  const aside = page.locator('aside');
  await expect(aside).toHaveCSS('background-color', 'rgb(233, 230, 223)');
  await expect(aside).toHaveCSS('width', '300px');
  await expect(page.locator('body')).toHaveCSS('font-family', /Inter Tight/u);
  await expect.poll(() => page.evaluate(() => '__TAURI_INTERNALS__' in window)).toBe(false);
});

test('legacy OpsPilot entry points are absent', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('status', { name: 'Core 状态' })).toContainText('Core 已就绪');

  for (const legacyLabel of ['AI Agent', '项目', 'Nginx', '任务与日志', '设置']) {
    await expect(page.getByText(legacyLabel)).toHaveCount(0);
  }
});

test('xterm boots in a renderer with a frozen Object prototype', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => Object.freeze(Object.prototype));

  await page.goto('/?scenario=terminal');
  await page.getByRole('button', {
    name: /^打开服务器 prod-web-01/u,
  }).click();

  await expect(page.getByRole('log', { name: '终端 1' })).toBeVisible();
  await expect(page.locator('.xterm')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('file browser opens Monaco in a renderer with a frozen Object prototype', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => Object.freeze(Object.prototype));

  await page.goto('/?scenario=files');
  await page.getByRole('button', {
    name: /^打开服务器 prod-web-01/u,
  }).click();
  await expect(page.getByRole('log', { name: '终端 1' })).toBeVisible();
  await page.getByRole('button', { name: '文件', exact: true }).click();

  const table = page.getByRole('table', { name: '目录内容' });
  await expect(table).toBeVisible();
  await expect(table).toContainText('0640');
  await page.getByRole('button', { name: '打开文件 app.conf' }).dblclick();

  const dialog = page.getByRole('dialog', { name: '编辑 app.conf' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.monaco-editor')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('Command-K opens the command palette and runs an action', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('status', { name: 'Core 状态' })).toContainText('Core 已就绪');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+KeyK' : 'Control+KeyK');

  const palette = page.getByRole('dialog', { name: '命令面板' });
  await expect(palette).toBeVisible();
  const search = palette.getByRole('searchbox', { name: '搜索服务器或命令' });
  await expect(search).toBeFocused();
  await expect(palette.getByRole('option', { name: /从 SSH Config 导入/u })).toHaveCount(1);

  await search.fill('添加');
  await search.press('Enter');
  await expect(page.getByRole('dialog', { name: '添加服务器' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '添加服务器' })).toHaveCount(0);
});

test('selecting a server opens a live xterm with sessions, history, and keepalive', async ({
  page,
}) => {
  await page.goto('/?scenario=terminal');
  await page.getByRole('button', {
    name: /^打开服务器 prod-web-01/u,
  }).click();

  const firstTerminal = page.getByRole('log', { name: '终端 1' });
  await expect(firstTerminal).toBeVisible();
  await expect(firstTerminal).toContainText('harbor renderer fixture');
  await expect(page.locator('.xterm')).toHaveCSS(
    'font-family',
    /IBM Plex Mono/u,
  );
  await expect(firstTerminal).toHaveCSS('background-color', 'rgb(20, 19, 17)');

  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('echo harbor-history');
  await page.keyboard.press('Enter');
  await expect(firstTerminal).toContainText('echo harbor-history');
  await page.context().grantPermissions(
    ['clipboard-read', 'clipboard-write'],
    { origin: 'http://127.0.0.1:1421' },
  );
  await page.evaluate(() => navigator.clipboard.writeText('echo pasted'));
  await page.getByRole('button', { name: '粘贴到终端' }).click();
  await expect(firstTerminal).toContainText('echo pasted');

  await page.evaluate(() => navigator.clipboard.writeText(
    'echo multiline-one\necho multiline-two',
  ));
  const [declinedDialog] = await Promise.all([
    page.waitForEvent('dialog'),
    page.getByRole('button', { name: '粘贴到终端' }).click(),
  ]);
  expect(declinedDialog.message()).toContain('2 行');
  await declinedDialog.dismiss();
  await expect(firstTerminal).not.toContainText('echo multiline-one');
  const [acceptedDialog] = await Promise.all([
    page.waitForEvent('dialog'),
    page.getByRole('button', { name: '粘贴到终端' }).click(),
  ]);
  await acceptedDialog.accept();
  await expect(firstTerminal).toContainText('echo multiline-one');
  await expect(firstTerminal).toContainText('echo multiline-two');
  await page.keyboard.press('Control+KeyR');

  const history = page.getByRole('dialog', { name: '命令历史' });
  await expect(history).toBeVisible();
  await history.getByRole('searchbox', { name: '搜索命令历史' }).fill('harbor');
  await expect(history.getByRole('option', {
    name: /echo harbor-history/u,
  })).toBeVisible();
  await history.getByRole('searchbox', { name: '搜索命令历史' }).press('Enter');
  await expect(history).toHaveCount(0);

  await page.getByRole('button', { name: '新增终端会话' }).click();
  await expect(page.getByRole('tab', { name: '切换到 终端 2' })).toBeVisible();
  await expect(page.getByLabel('终端会话数量')).toContainText('2/8');
  await page.getByRole('button', { name: '关闭会话 终端 2' }).click();
  await expect(page.getByRole('tab', { name: '切换到 终端 2' })).toHaveCount(0);
  await expect(page.getByLabel('终端会话数量')).toContainText('1/8');

  await page.getByRole('button', { name: /^打开服务器 dev-box/u }).click();
  await expect(page.getByRole('log', { name: '终端 1' })).toBeVisible();
  await page.getByRole('button', { name: /^打开服务器 prod-web-01/u }).click();
  await expect(page.getByRole('log', { name: '终端 1' })).toContainText(
    'echo harbor-history',
  );
  await expect(
    page.locator('main:visible').getByLabel('终端会话数量'),
  ).toContainText('1/8');
});

test('lists Docker containers, reads both log streams, restarts, and execs into a terminal', async ({
  page,
}) => {
  await page.goto('/?scenario=docker');
  await page.getByRole('button', {
    name: /^打开服务器 prod-web-01/u,
  }).click();
  await expect(page.getByRole('tab', { name: '切换到 终端 1' })).toBeVisible();

  await page.getByRole('button', { name: 'Docker' }).click();
  const table = page.getByRole('table', { name: 'Docker 容器' });
  await expect(table).toBeVisible();
  await expect(table).toContainText('web');
  await expect(table).toContainText('nginx:alpine');
  await expect(table).toContainText('运行中');
  await expect(table).toContainText('0.0.0.0:8080->80/tcp');
  await expect(table).toContainText('2026-11-17');

  await page.getByRole('button', { name: '查看 web 日志' }).click();
  const logs = page.getByRole('dialog', { name: '容器日志 web' });
  await expect(logs).toBeVisible();
  await expect(logs.getByRole('log')).toContainText('request completed');
  await expect(logs.getByRole('log')).toContainText('warning from stderr');
  await expect(logs).toHaveCSS('background-color', 'rgb(20, 19, 17)');
  await logs.getByRole('button', { name: '关闭日志' }).click();
  await expect(logs).toHaveCount(0);
  await expect(table).toBeVisible();

  await page.getByRole('button', { name: '重启 web' }).click();
  const confirmation = page.getByRole('alertdialog', { name: '重启容器？' });
  await expect(confirmation).toContainText('web');
  await confirmation.getByRole('button', { name: '确认重启' }).click();
  await expect(page.getByText('容器已重启')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const runtime = window as unknown as {
      __harborRuntime: {
        core: { calls: Array<{ method: string }> };
      };
    };
    return runtime.__harborRuntime.core.calls
      .filter((call) => call.method === 'runDockerAction').length;
  })).toBe(1);

  await page.getByRole('button', { name: 'Exec web' }).click();
  const dockerTab = page.getByRole('tab', { name: '切换到 终端 2' });
  await expect(dockerTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('log', { name: '终端 2' })).toContainText(
    'docker exec web sh',
  );
});

test('never records interactive input that the remote pty does not echo', async ({ page }) => {
  await page.goto('/?scenario=terminal');
  await page.getByRole('button', {
    name: /^打开服务器 prod-web-01/u,
  }).click();
  const terminal = page.getByRole('log', { name: '终端 1' });
  await expect(terminal).toBeVisible();

  await page.evaluate(() => {
    const runtime = window as unknown as {
      __harborRuntime: {
        core: {
          emitTerminalData(event: {
            terminalSessionId: string;
            sequence: number;
            bytes: number[];
          }): void;
          writeTerminal: () => Promise<void>;
        };
        terminalStore: {
          getState(): {
            runtimes: Record<string, {
              sessions: Array<{ id: string }>;
            }>;
          };
        };
      };
    };
    const state = runtime.__harborRuntime;
    const session = Object.values(state.terminalStore.getState().runtimes)
      .flatMap((entry) => entry.sessions)[0];
    if (!session) throw new Error('missing fixture session');
    state.core.writeTerminal = async () => undefined;
    state.core.emitTerminalData({
      terminalSessionId: session.id,
      sequence: 2,
      bytes: Array.from(new TextEncoder().encode('[sudo] password for deploy: ')),
    });
  });
  await expect(terminal).toContainText('[sudo] password for deploy:');

  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('deploy');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  await page.keyboard.press('Control+KeyR');

  const history = page.getByRole('dialog', { name: '命令历史' });
  await expect(history).toBeVisible();
  await history.getByRole('searchbox', { name: '搜索命令历史' }).fill('deploy');
  await expect(history.getByRole('option')).toHaveCount(0);
});

test('routes native paste through confirmation and sends one keyboard paste', async ({ page }) => {
  await page.goto('/?scenario=terminal');
  await page.getByRole('button', {
    name: /^打开服务器 prod-web-01/u,
  }).click();
  const terminal = page.getByRole('log', { name: '终端 1' });
  await expect(terminal).toBeVisible();
  await page.locator('.xterm-helper-textarea').focus();

  const dispatchNativePaste = (text: string) => page.evaluate((value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    const textarea = document.querySelector('.xterm-helper-textarea');
    if (!(textarea instanceof HTMLElement)) {
      throw new Error('missing xterm textarea');
    }
    textarea.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
  }, text);

  const declined = page.waitForEvent('dialog');
  const declinedPaste = dispatchNativePaste(
    'echo native-one\necho native-two',
  );
  const declinedDialog = await declined;
  expect(declinedDialog.message()).toContain('2 行');
  await declinedDialog.dismiss();
  await declinedPaste;
  await expect(terminal).not.toContainText('echo native-one');

  const accepted = page.waitForEvent('dialog');
  const acceptedPaste = dispatchNativePaste(
    'echo native-one\necho native-two',
  );
  const acceptedDialog = await accepted;
  await acceptedDialog.accept();
  await acceptedPaste;
  await expect(terminal).toContainText('echo native-one');
  await expect(terminal).toContainText('echo native-two');

  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'readText', {
      configurable: true,
      value: async () => 'echo keyboard-paste',
    });
  });
  await page.locator('.xterm-helper-textarea').focus();
  await page.evaluate(() => {
    const textarea = document.querySelector('.xterm-helper-textarea');
    if (!(textarea instanceof HTMLElement)) {
      throw new Error('missing xterm textarea');
    }
    for (const type of ['keydown', 'keyup']) {
      textarea.dispatchEvent(new KeyboardEvent(type, {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: 'v',
      }));
    }
  });
  await expect(terminal).toContainText('echo keyboard-paste');
  await expect.poll(async () => (
    await terminal.locator('.xterm-rows').evaluate(
      (element, command) => element.textContent?.split(command).length - 1,
      'echo keyboard-paste',
    )
  )).toBe(1);
});

test('editing a connected endpoint closes the old SSH identity first', async ({ page }) => {
  await page.goto('/?scenario=terminal');
  await page.getByRole('button', {
    name: /^打开服务器 prod-web-01/u,
  }).click();
  await expect(page.getByRole('log', { name: '终端 1' })).toBeVisible();
  const oldConnectionId = await page.evaluate(() => {
    const runtime = window as unknown as {
      __harborRuntime: {
        harborStore: {
          getState(): {
            servers: Array<{ id: string }>;
          };
        };
        terminalStore: {
          getState(): {
            runtimes: Record<string, {
              connection: { connectionId: string } | null;
            }>;
          };
        };
      };
    };
    return runtime.__harborRuntime.terminalStore
      .getState()
      .runtimes['019c62b2-2970-7000-8000-000000000101']
      ?.connection?.connectionId;
  });

  await page.getByRole('button', { name: '编辑服务器' }).click();
  const dialog = page.getByRole('dialog', { name: '编辑服务器' });
  await dialog.getByLabel('主机').fill('replacement.example.com');
  await dialog.getByLabel('用户名').fill('replacement');
  await dialog.getByRole('button', { name: '保存服务器' }).click();

  await expect.poll(() => page.evaluate(() => {
    const runtime = window as unknown as {
      __harborRuntime: {
        core: {
          calls: Array<{ method: string }>;
        };
        terminalStore: {
          getState(): {
            runtimes: Record<string, {
              connection: { connectionId: string } | null;
              connectionIdentity: string | null;
            }>;
          };
        };
      };
    };
    const state = runtime.__harborRuntime;
    return {
      connects: state.core.calls.filter((call) => call.method === 'connect').length,
      disconnects: state.core.calls.filter((call) => call.method === 'disconnect').length,
      connectionId: state.terminalStore.getState()
        .runtimes['019c62b2-2970-7000-8000-000000000101']
        ?.connection?.connectionId,
    };
  })).toEqual({
    connects: 2,
    disconnects: 1,
    connectionId: expect.not.stringMatching(oldConnectionId ?? '^$'),
  });
  await expect(page.getByRole('log', { name: '终端 1' })).toBeVisible();
});

test('unknown host keys require explicit trust and a closed session can reconnect', async ({
  page,
}) => {
  await page.goto('/?scenario=host-key');
  await page.getByRole('button', {
    name: /^打开服务器 prod-web-01/u,
  }).click();

  const hostKeyDialog = page.getByRole('dialog', {
    name: '首次连接，核对主机指纹',
  });
  await expect(hostKeyDialog).toBeVisible();
  await expect(hostKeyDialog).toContainText('SHA256:rendererFixtureHostKey');
  const trust = hostKeyDialog.getByRole('button', {
    name: '信任并以 SSH 连接',
  });
  await expect(trust).toBeDisabled();
  await hostKeyDialog.getByLabel(
    '我已通过独立渠道核对上述 SHA-256 主机指纹。',
  ).check();
  await trust.click();

  await expect(hostKeyDialog).toHaveCount(0);
  await expect(page.getByRole('log', { name: '终端 1' })).toContainText(
    'harbor renderer fixture',
  );

  await page.evaluate(() => {
    const runtime = window as unknown as {
      __harborRuntime: { disconnectFirstSession(): void };
    };
    runtime.__harborRuntime.disconnectFirstSession();
  });
  await expect(page.getByRole('heading', {
    name: 'SSH 连接已断开',
  })).toBeVisible();
  await page.getByRole('button', { name: '重连会话' }).click();
  await expect(page.getByRole('heading', { name: 'SSH 连接已断开' })).toHaveCount(0);
  await expect(page.getByRole('log', { name: '终端 1' })).toContainText(
    'harbor renderer fixture',
  );
});

test('changed host keys stay blocked until explicit fingerprint replacement', async ({
  page,
}) => {
  await page.goto('/?scenario=host-key-changed');
  await page.getByRole('button', {
    name: /^打开服务器 prod-web-01/u,
  }).click();

  const hostKeyDialog = page.getByRole('dialog', {
    name: '主机指纹已变化，重新核对',
  });
  await expect(hostKeyDialog).toBeVisible();
  await expect(hostKeyDialog).toContainText('SHA256:rendererFixtureOldHostKey');
  await expect(hostKeyDialog).toContainText('SHA256:rendererFixtureNewHostKey');
  const trust = hostKeyDialog.getByRole('button', {
    name: '确认变化并连接',
  });
  await expect(trust).toBeDisabled();
  await hostKeyDialog.getByLabel(
    '我已确认服务器密钥确实发生变更，并核对了当前 SHA-256 指纹。',
  ).check();
  await trust.click();

  await expect(hostKeyDialog).toHaveCount(0);
  await expect(page.getByRole('log', { name: '终端 1' })).toContainText(
    'harbor renderer fixture',
  );
});

test('imports an SSH Config preview and marks the server as pending credentials', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('status', { name: 'Core 状态' })).toContainText('Core 已就绪');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+KeyK' : 'Control+KeyK');
  await page.getByRole('option', { name: /从 SSH Config 导入/u }).click();

  const dialog = page.getByRole('dialog', { name: '导入 SSH Config' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('imported-prod')).toBeVisible();
  await expect(dialog.getByText('imported.example.com').first()).toBeVisible();
  await expect(dialog.getByText('deploy').first()).toBeVisible();
  await expect(dialog.getByText('2222').first()).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: '选择 imported-prod' })).toBeEnabled();
  await expect(dialog.getByRole('checkbox', { name: '选择 existing' })).toBeDisabled();
  await expect(dialog.getByRole('checkbox', { name: '选择 imported-copy' })).toBeDisabled();
  await expect(dialog.getByRole('checkbox', { name: '选择 proxied' })).toBeDisabled();
  await expect(dialog.getByText('已存在', { exact: true })).toHaveCount(2);
  await expect(dialog.getByText('同批重复')).toBeVisible();
  await expect(dialog.getByText('暂不支持', { exact: true })).toBeVisible();

  await dialog.getByRole('button', { name: '导入 1 台服务器' }).click();
  await expect(dialog.getByText('导入完成')).toBeVisible();
  await expect(dialog.getByText(/已导入/u)).toContainText('已导入 1 台服务器');
  await dialog.getByRole('button', { name: '完成' }).click();

  await expect(page.getByRole('button', {
    name: /^打开服务器 imported-prod/u,
  })).toBeVisible();
  await expect(page.getByText('凭据待配置')).toBeVisible();
  await page.getByRole('button', { name: /^打开服务器 imported-prod/u }).click();
  await expect(page.getByText(/尚未配置密码或私钥/u)).toBeVisible();
});
