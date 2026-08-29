import { expect, test } from '@playwright/test';

test('renderer fixture shows Core readiness without a native Tauri runtime', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveCSS('display', 'grid');
  await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.72)');
  await expect(page.getByRole('status', { name: 'Core 状态' })).toContainText('Core 已就绪');
  await expect(page.getByRole('status', { name: 'Core 状态' })).toContainText('Core renderer-fixture');
  await expect.poll(() => page.evaluate(() => '__TAURI_INTERNALS__' in window)).toBe(false);
});

test('primary navigation exposes every desktop MVP workspace', async ({ page }) => {
  await page.goto('/');
  const workspaces = [
    ['服务器', '服务器'],
    ['终端', '终端'],
    ['AI Agent', 'AI Agent'],
    ['项目', '项目'],
    ['文件', '文件'],
    ['Docker', 'Docker'],
    ['Nginx', 'Nginx'],
    ['任务与日志', '任务与日志'],
    ['设置', '设置'],
    ['仪表盘', '仪表盘'],
  ] as const;

  for (const [navigationLabel, heading] of workspaces) {
    await page.getByRole('button', { exact: true, name: navigationLabel }).click();
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  }
});

test('real renderer boots when Tauri freezes Object.prototype', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => Object.freeze(Object.prototype));

  await page.goto('/#terminal');

  await expect(page.getByRole('heading', { name: '终端' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Core 状态' })).toContainText('Core 已就绪');
  expect(pageErrors).toEqual([]);
});

test('theme toggle switches data-theme and sidebar collapse persists', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', /light|dark/);

  await page.getByRole('button', { name: '切换到深色模式' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');

  await page.getByRole('button', { name: '切换到浅色模式' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  // 收起侧边栏：宽度收窄且导航按钮保留
  const sidebar = page.locator('.sidebar');
  await expect(sidebar).toHaveCSS('width', '240px');
  await page.getByRole('button', { name: '收起侧边栏' }).click();
  await expect(sidebar).toHaveCSS('width', '72px');
  await expect(page.getByRole('button', { name: '仪表盘' })).toBeVisible();

  // 刷新后保持收起
  await page.reload();
  await expect(page.locator('.sidebar')).toHaveCSS('width', '72px');
});
