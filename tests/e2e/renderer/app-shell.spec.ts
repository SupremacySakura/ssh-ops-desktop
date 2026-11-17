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
  await expect(palette.getByText('从 SSH Config 导入')).toHaveCount(0);

  await search.fill('添加');
  await search.press('Enter');
  await expect(page.getByRole('dialog', { name: '添加服务器' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '添加服务器' })).toHaveCount(0);
});
