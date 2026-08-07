import { expect, test } from '@playwright/test';

test('renderer fixture shows Core readiness without a native Tauri runtime', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'OpsPilot' })).toBeVisible();
  await expect(page.getByText('Core 已就绪')).toBeVisible();
  await expect(page.getByText('版本 renderer-fixture')).toBeVisible();
  await expect.poll(() => page.evaluate(() => '__TAURI_INTERNALS__' in window)).toBe(false);
});
