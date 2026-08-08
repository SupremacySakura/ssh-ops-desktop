import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { xtermFreezePrototypeCompatibility } from './vite/xterm-freeze-prototype.ts';

export default defineConfig({
  clearScreen: false,
  optimizeDeps: {
    exclude: ['@xterm/xterm'],
  },
  plugins: [react(), xtermFreezePrototypeCompatibility()],
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
});
