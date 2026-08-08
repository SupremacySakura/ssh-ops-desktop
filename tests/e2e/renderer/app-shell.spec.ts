import { expect, test } from '@playwright/test';

test('renderer fixture shows Core readiness without a native Tauri runtime', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: '服务器总览' })).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveCSS('display', 'grid');
  await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.getByRole('status', { name: 'Core 状态' })).toContainText('Core 已就绪');
  await expect(page.getByRole('status', { name: 'Core 状态' })).toContainText('Core renderer-fixture');
  await expect.poll(() => page.evaluate(() => '__TAURI_INTERNALS__' in window)).toBe(false);
});

test('primary navigation exposes every desktop MVP workspace', async ({ page }) => {
  await page.goto('/');
  const workspaces = [
    ['服务器', '服务器管理'],
    ['终端', '远程终端'],
    ['AI Agent', 'AI Agent'],
    ['项目', '项目与发布'],
    ['文件', '远程文件'],
    ['Docker', 'Docker'],
    ['Nginx', 'Nginx'],
    ['任务与日志', '任务与日志'],
    ['设置', '设置'],
    ['仪表盘', '服务器总览'],
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

  await expect(page.getByRole('heading', { name: '远程终端' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Core 状态' })).toContainText('Core 已就绪');
  expect(pageErrors).toEqual([]);
});
