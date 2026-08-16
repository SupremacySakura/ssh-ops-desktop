import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { monacoFreezePrototypeCompatibility } from './vite/monaco-freeze-prototype.ts';
import { xtermFreezePrototypeCompatibility } from './vite/xterm-freeze-prototype.ts';

export default defineConfig({
  clearScreen: false,
  optimizeDeps: {
    // 预打包会绕过 freezePrototype 兼容层插件的 transform，这两个包必须保持逐文件加载。
    exclude: ['@xterm/xterm', 'monaco-editor'],
  },
  plugins: [react(), monacoFreezePrototypeCompatibility(), xtermFreezePrototypeCompatibility()],
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
});
