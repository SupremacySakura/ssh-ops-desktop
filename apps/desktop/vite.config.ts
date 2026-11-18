import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import { monacoFreezePrototypeCompatibility } from './vite/monaco-freeze-prototype.ts';
import { xtermFreezePrototypeCompatibility } from './vite/xterm-freeze-prototype.ts';

const desktopModules = new URL('./node_modules/', import.meta.url);

export default defineConfig({
  clearScreen: false,
  plugins: [
    monacoFreezePrototypeCompatibility(),
    xtermFreezePrototypeCompatibility(),
    react(),
    tailwindcss(),
  ],
  optimizeDeps: {
    exclude: ['@xterm/xterm', 'monaco-editor'],
  },
  resolve: {
    alias: [
      {
        find: /^react$/,
        replacement: fileURLToPath(new URL('react', desktopModules)),
      },
      {
        find: /^react\//,
        replacement: `${fileURLToPath(new URL('react', desktopModules))}/`,
      },
      {
        find: /^react-dom$/,
        replacement: fileURLToPath(new URL('react-dom', desktopModules)),
      },
      {
        find: /^react-dom\//,
        replacement: `${fileURLToPath(new URL('react-dom', desktopModules))}/`,
      },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
});
