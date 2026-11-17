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
