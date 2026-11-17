import { expect, test } from '@playwright/test';

import { FIXTURE_METADATA_KEY } from './fixture/scenario-keys';

test('adds a server, connects, edits a file, monitors it, and execs into Docker', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/?scenario=integration');
  await expect(page.getByRole('heading', { name: '还没有服务器' })).toBeVisible();

  await page.locator('footer').getByRole('button', { name: '添加服务器' }).click();
  const form = page.getByRole('dialog', { name: '添加服务器' });
  await form.getByLabel('名称').fill('fresh-prod');
  await form.getByLabel('主机').fill('fresh.example.com');
  await form.getByLabel('用户名').fill('deploy');
  await form.getByRole('textbox', { name: '私钥' })
    .fill('-----BEGIN OPENSSH PRIVATE KEY-----fixture');
  await form.getByRole('button', { name: '保存服务器' }).click();

  await expect(form).toHaveCount(0);
  const terminal = page.getByRole('log', { name: '终端 1' });
  await expect(terminal).toContainText('harbor renderer fixture');
  await expect(page.getByRole('button', {
    name: /^打开服务器 fresh-prod/u,
  })).toHaveAttribute('aria-current', 'true');

  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('cd /etc');
  await page.keyboard.press('Enter');
  await expect(terminal).toContainText('cd /etc');

  await page.getByRole('button', { name: '跳转到当前终端目录' }).click();
  const table = page.getByRole('table', { name: '目录内容' });
  await expect(table).toContainText('nginx.conf');
  await expect(page.getByRole('navigation', { name: '目录面包屑' }))
    .toContainText('etc');

  await page.getByRole('button', { name: '跳转到 /', exact: true }).click();
  await expect(table).toContainText('app.conf');
  await page.getByRole('button', { name: '打开文件 app.conf' }).dblclick();
  const editor = page.getByRole('dialog', { name: '编辑 app.conf' });
  await expect(editor.locator('.monaco-editor')).toBeVisible();
  const editorInput = editor.getByRole('textbox', {
    name: 'app.conf 的远程文本内容',
  });
  await editorInput.focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('hello from harbor');
  await expect(editor.getByText('有未保存修改')).toBeVisible();
  await editor.getByRole('button', { name: '保存到远程' }).click();
  await expect(editor.getByRole('status')).toContainText('已保存到远程');
  await expect(editor.getByText('与远端一致')).toBeVisible();
  await editor.getByLabel('关闭编辑器').click();

  await page.getByRole('button', { name: '监控' }).click();
  await expect(page.getByRole('heading', { name: '系统监控' })).toBeVisible();
  const cpu = page.getByRole('region', { name: 'CPU 概览' });
  await expect(cpu).toContainText('%');
  await expect(cpu.getByRole('img', { name: 'CPU 概览近 5 分钟趋势' }))
    .toBeVisible();
  await expect(page.getByRole('region', { name: '内存概览' })).toContainText('%');
  await expect(page.getByRole('region', { name: '磁盘概览' })).toContainText('%');
  await expect(page.getByRole('region', { name: '负载概览' })).toBeVisible();
  await expect(page.getByRole('region', { name: '运行时间概览' }))
    .toContainText('天');

  const processTable = page.getByRole('table', { name: 'Top 10 进程' });
  await expect(processTable.locator('tbody tr')).toHaveCount(10);
  await expect(processTable.locator('tbody tr').first()).toContainText('cpu-heavy');
  await expect(processTable.getByRole('columnheader', { name: 'CPU' }))
    .toHaveAttribute('aria-sort', 'descending');
  await page.getByRole('button', { name: '按内存排序' }).click();
  await expect(processTable.locator('tbody tr').first()).toContainText('mem-heavy');
  await expect(processTable.getByRole('columnheader', { name: '内存' }))
    .toHaveAttribute('aria-sort', 'descending');

  await page.getByRole('button', { name: 'Docker' }).click();
  const containers = page.getByRole('table', { name: 'Docker 容器' });
  await expect(containers).toContainText('nginx:alpine');
  await page.getByRole('button', { name: '重启 web' }).click();
  const confirmation = page.getByRole('alertdialog', { name: '重启容器？' });
  await confirmation.getByRole('button', { name: '确认重启' }).click();
  await expect(page.getByText('容器已重启')).toBeVisible();

  await page.getByRole('button', { name: 'Exec web' }).click();
  await expect(page.getByRole('tab', { name: '切换到 终端 2' }))
    .toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('log', { name: '终端 2' }))
    .toContainText('docker exec web sh');
  expect(pageErrors).toEqual([]);
});

test('keeps terminal output and monitor sort across tabs and server switches', async ({
  page,
}) => {
  await page.goto('/?scenario=keepalive');
  await page.getByRole('button', { name: /^打开服务器 prod-web-01/u }).click();
  const prodTerminal = page.getByRole('log', { name: '终端 1' });
  await expect(prodTerminal).toContainText('harbor renderer fixture');
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('echo prod-marker');
  await page.keyboard.press('Enter');
  await expect(prodTerminal).toContainText('echo prod-marker');

  await page.getByRole('button', { name: '监控' }).click();
  await expect(page.getByRole('region', { name: 'CPU 概览' })).toContainText('%');
  await page.getByRole('button', { name: '按内存排序' }).click();

  await page.getByRole('button', { name: 'Docker' }).click();
  await page.getByRole('button', { name: '文件', exact: true }).click();
  await expect(page.getByRole('table', { name: '目录内容' })).toBeVisible();

  await page.getByRole('button', { name: /^打开服务器 dev-box/u }).click();
  await expect(page.getByRole('log', { name: '终端 1' })).toBeVisible();
  await page.getByRole('button', { name: '监控' }).click();
  const devCpu = page.getByRole('region', { name: 'CPU 概览' });
  await expect(devCpu).toContainText('%');
  await expect.poll(async () => (
    await devCpu.locator('p.font-mono.text-\\[20px\\]').textContent()
  )).toMatch(/^9\d\.\d%$/u);

  await page.getByRole('button', { name: /^打开服务器 prod-web-01/u }).click();
  await page.getByRole('button', { name: '监控' }).click();
  await expect(page.getByRole('button', { name: '按内存排序' }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (
    await page.getByRole('region', { name: 'CPU 概览' })
      .locator('p.font-mono.text-\\[20px\\]').textContent()
  )).toMatch(/^[23]\d\.\d%$/u);

  await page.getByRole('button', { name: '终端', exact: true }).click();
  await expect(page.getByRole('log', { name: '终端 1' }))
    .toContainText('echo prod-marker');
  await expect(page.getByRole('log', { name: '终端 1' })).toBeVisible();

  const connections = await page.evaluate(() => {
    const runtime = window as unknown as {
      __harborRuntime: {
        core: { calls: Array<{ method: string; args: unknown[] }> };
      };
    };
    return runtime.__harborRuntime.core.calls
      .filter((call) => call.method === 'connect')
      .map((call) => call.args[0]);
  });
  expect(connections).toHaveLength(2);
});

test('retries a failed monitor sample without losing the panel', async ({ page }) => {
  await page.goto('/?scenario=monitor-failure');
  await page.getByRole('button', { name: /^打开服务器 prod-web-01/u }).click();
  await page.getByRole('button', { name: '监控' }).click();
  const failure = page.getByRole('alert').filter({ hasText: '监控采集失败' });
  await expect(failure).toContainText('服务器拒绝读取系统指标');
  await failure.getByRole('button', { name: '立即重试' }).click();
  await expect(page.getByRole('region', { name: 'CPU 概览' })).toContainText('%');
  await expect(failure).toHaveCount(0);
});

test('drops a late monitor sample from a background server', async ({ page }) => {
  await page.goto('/?scenario=monitor-late');
  await page.getByRole('button', { name: /^打开服务器 prod-web-01/u }).click();
  await page.getByRole('button', { name: '监控' }).click();
  await expect(page.getByRole('region', { name: 'CPU 概览' }))
    .toContainText('等待采样');
  const prodCpu = page.getByRole('region', { name: 'CPU 概览' });

  await page.getByRole('button', { name: /^打开服务器 dev-box/u }).click();
  await page.getByRole('button', { name: '监控' }).click();
  const devCpu = page.getByRole('region', { name: 'CPU 概览' });
  await expect.poll(async () => (
    await devCpu.locator('p.font-mono.text-\\[20px\\]').textContent()
  )).toBe('91.0%');

  await page.waitForTimeout(1_500);
  await expect.poll(async () => (
    await devCpu.locator('p.font-mono.text-\\[20px\\]').textContent()
  )).toBe('91.0%');
  await expect(devCpu).not.toContainText('77.0%');

  await page.getByRole('button', { name: /^打开服务器 prod-web-01/u }).click();
  await page.getByRole('button', { name: '监控' }).click();
  await expect(prodCpu).not.toContainText('77.0%');
  await expect.poll(async () => (
    await prodCpu.locator('p.font-mono.text-\\[20px\\]').textContent()
  )).toBe('31.0%');
});

test('keeps a conflicted draft and lets the user retry the save', async ({ page }) => {
  await page.goto('/?scenario=files-conflict');
  await page.getByRole('button', { name: /^打开服务器 prod-web-01/u }).click();
  await page.getByRole('button', { name: '文件', exact: true }).click();
  await page.getByRole('button', { name: '打开文件 app.conf' }).dblclick();

  const editor = page.getByRole('dialog', { name: '编辑 app.conf' });
  const editorInput = editor.getByRole('textbox', {
    name: 'app.conf 的远程文本内容',
  });
  await editorInput.focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('draft kept locally');
  await editor.getByRole('button', { name: '保存到远程' }).click();
  await expect(editor.getByRole('alert')).toContainText('已在别处修改');
  await expect(editor).toContainText('草稿仍保留在本编辑器内');
  await expect(editor.locator('.monaco-editor')).toContainText('draft kept locally');
  await expect(editor.getByRole('button', { name: '重试保存' })).toBeVisible();
});

test('shows explicit offline states with a reconnect action', async ({ page }) => {
  await page.goto('/?scenario=offline');
  await page.getByRole('button', { name: /^打开服务器 offline-box/u }).click();
  const terminalPanel = page.locator('[data-workspace-panel="terminal"]');
  await expect(terminalPanel.getByRole('alert'))
    .toContainText('无法建立 SSH 连接');
  await expect(terminalPanel.getByRole('button', {
    name: '重试',
    exact: true,
  })).toBeVisible();

  await page.getByRole('button', { name: '文件', exact: true }).click();
  await expect(page.getByRole('heading', { name: '服务器连接已断开' }))
    .toBeVisible();
  await expect(page.getByRole('button', { name: '重新连接服务器' }))
    .toBeVisible();

  await page.getByRole('button', { name: 'Docker' }).click();
  const dockerPanel = page.locator('[data-workspace-panel="docker"]');
  await expect(dockerPanel.getByText('服务器离线')).toBeVisible();
  await expect(dockerPanel.getByRole('button', { name: '重新连接' }))
    .toBeVisible();
});

test('shows empty search and empty directory states', async ({ page }) => {
  await page.goto('/?scenario=empty');
  await page.getByRole('searchbox', { name: '搜索服务器' }).fill('no-such-host');
  await expect(page.getByRole('heading', { name: '没有匹配的服务器' }))
    .toBeVisible();

  await page.getByRole('searchbox', { name: '搜索服务器' }).fill('');
  await page.getByRole('button', { name: /^打开服务器 prod-web-01/u }).click();
  await page.getByRole('button', { name: '文件', exact: true }).click();
  await expect(page.getByRole('heading', { name: '目录为空' })).toBeVisible();
  await expect(page.getByText('/ 当前没有文件或子目录。')).toBeVisible();
  await expect(page.getByRole('button', { name: '新建文件夹' }).first())
    .toBeVisible();
});

test('imports three ready hosts and skips the existing one', async ({ page }) => {
  await page.goto('/?scenario=import');
  await page.getByRole('button', { name: '从 SSH Config 导入' }).click();
  const dialog = page.getByRole('dialog', { name: '导入 SSH Config' });
  await expect(dialog.getByText('imported-prod')).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: '选择 imported-staging' }))
    .toBeEnabled();
  await expect(dialog.getByRole('checkbox', { name: '选择 imported-db' }))
    .toBeEnabled();
  await expect(dialog.getByRole('checkbox', { name: '选择 race-existing' }))
    .toBeEnabled();
  await expect(dialog.getByRole('checkbox', { name: '选择 already-here' }))
    .toBeDisabled();
  await expect(dialog.getByText('已存在', { exact: true })).toHaveCount(2);

  await dialog.getByRole('button', { name: '导入 4 台服务器' }).click();
  await expect(dialog.getByText('导入完成')).toBeVisible();
  await expect(dialog.getByText(/已导入/u)).toHaveText(
    /已导入\s*3\s*台服务器，\s*跳过\s*1\s*台重复记录/u,
  );
  await dialog.getByRole('button', { name: '完成' }).click();

  await expect(page.getByRole('button', { name: /^打开服务器 imported-prod/u }))
    .toBeVisible();
  await expect(page.getByRole('button', { name: /^打开服务器 imported-staging/u }))
    .toBeVisible();
  await expect(page.getByRole('button', { name: /^打开服务器 imported-db/u }))
    .toBeVisible();
  await expect(page.getByRole('button', { name: /^打开服务器 race-existing/u }))
    .toHaveCount(1);

  await page.getByRole('button', { name: /^打开服务器 imported-prod/u }).click();
  await expect(page.getByText('凭据待配置').first()).toBeVisible();
  await expect(page.getByText(/尚未配置密码或私钥/u)).toBeVisible();
});

test('restores servers, groups, and favorites after a renderer reload', async ({ page }) => {
  await page.goto('/?scenario=persistence');
  await expect(page.getByRole('button', { name: /^打开服务器 prod-web-01/u }))
    .toBeVisible();
  await page.getByRole('button', { name: '收藏 prod-web-01' }).click();
  await expect(page.getByRole('button', { name: '取消收藏 prod-web-01' }))
    .toBeVisible();
  await expect(page.getByRole('region', { name: '收藏' })).toBeVisible();

  await page.locator('footer').getByRole('button', { name: '添加服务器' }).click();
  const form = page.getByRole('dialog', { name: '添加服务器' });
  await form.getByLabel('名称').fill('persisted-box');
  await form.getByLabel('主机').fill('persisted.example.com');
  await form.getByLabel('用户名').fill('deploy');
  await form.getByRole('textbox', { name: '私钥' })
    .fill('-----BEGIN OPENSSH PRIVATE KEY-----fixture');
  await form.getByLabel('分组').selectOption({ label: '生产' });
  await form.getByRole('button', { name: '保存服务器' }).click();
  await expect(page.getByRole('button', {
    name: /^打开服务器 persisted-box/u,
  })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('region', { name: '收藏' })).toBeVisible();
  await expect(page.getByRole('button', { name: '取消收藏 prod-web-01' }))
    .toBeVisible();
  await expect(
    page.getByRole('region', { name: '生产', exact: true }),
  ).toContainText('persisted-box');
  const stored = await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, FIXTURE_METADATA_KEY);
  expect(stored.servers).toHaveLength(3);
  expect(stored.groups).toHaveLength(1);
  expect(JSON.stringify(stored)).not.toContain('BEGIN OPENSSH PRIVATE KEY');
});

