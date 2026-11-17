# xterm Freeze Prototype Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Tauri 冻结 `Object.prototype` 后 xterm 导致的原生应用白屏。

**Architecture:** 用版本锁定的 Vite 源码变换修复依赖根因，并把终端页面从 App 启动路径中延迟加载。真实 App 的 Renderer E2E 模拟 Tauri 初始化脚本，覆盖仪表盘和终端路由。

**Tech Stack:** React 19、Vite 8、Playwright、Tauri 2。

## Global Constraints

- 保持 `freezePrototype: true`。
- 固定补丁目标为 `@xterm/xterm@6.0.0`。
- 不修改 SSH、Core IPC 或终端会话行为。

---

### Task 1: 建立冻结原型回归测试

**Files:**
- Modify: `tests/e2e/renderer/app-shell.spec.ts`
- Modify: `tests/e2e/renderer/fixture/vite.config.ts`
- Modify: `tests/e2e/native/app-shell.e2e.ts`

**Interfaces:**
- Consumes: Renderer fixture 中的真实 `App` 与注入式 `CoreClient`。
- Produces: 冻结原型下 Renderer 与 Native WebView 的仪表盘、终端路由启动契约。

- [x] **Step 1: 写入失败测试**

```ts
await page.addInitScript(() => Object.freeze(Object.prototype));
await page.goto('/#terminal');
await expect(page.getByRole('heading', { name: '远程终端' })).toBeVisible();
expect(pageErrors).toEqual([]);
```

- [x] **Step 2: 验证测试因 xterm 的只读 `toString` 赋值失败**

Run: `pnpm test:e2e:renderer`
Expected: FAIL，并包含 `Cannot assign to read only property 'toString'`。

### Task 2: 修补依赖并隔离启动路径

**Files:**
- Create: `apps/desktop/vite/xterm-freeze-prototype.ts`
- Modify: `apps/desktop/vite.config.ts`
- Modify: `apps/desktop/tsconfig.node.json`
- Modify: `apps/desktop/src/App.tsx`

**Interfaces:**
- Consumes: `@xterm/xterm@6.0.0` 的 ESM 入口和 `TerminalPage` 命名导出。
- Produces: 冻结原型兼容的 xterm 依赖和延迟加载终端路由。

- [x] **Step 1: 通过版本锁定的 Vite 变换将 xterm 的 `toString` 赋值改为自有属性定义**

```js
Object.defineProperty(o,"toString",{value:s,writable:!0,enumerable:!0,configurable:!0});
```

- [x] **Step 2: 用 `React.lazy` 动态导入终端页面**

```tsx
const TerminalPage = lazy(async () => {
  const module = await import('./features/terminal/terminal-page');
  return { default: module.TerminalPage };
});
```

- [x] **Step 3: 验证回归测试通过**

Run: `pnpm test:e2e:renderer`
Expected: PASS。

### Task 3: 全量验证

**Files:**
- Verify only.

**Interfaces:**
- Consumes: 修复后的工作区。
- Produces: 可复现的质量门禁结果。

- [x] **Step 1: 执行前端验证**

Run: `pnpm lint`
Run: `pnpm typecheck`
Run: `pnpm test`
Expected: PASS。

- [x] **Step 2: 执行桌面构建**

Run: `pnpm tauri build --debug --no-bundle`
Expected: PASS。

- [x] **Step 3: 检查工作区差异**

Run: `git diff --check`
Expected: 无新增格式错误。
