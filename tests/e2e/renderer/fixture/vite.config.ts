import { fileURLToPath } from 'node:url';

import { xtermFreezePrototypeCompatibility } from '../../../../apps/desktop/vite/xterm-freeze-prototype.ts';

const desktopModules = new URL('../../../../apps/desktop/node_modules/', import.meta.url);

export default {
  optimizeDeps: {
    exclude: ['@xterm/xterm'],
  },
  plugins: [xtermFreezePrototypeCompatibility()],
  resolve: {
    alias: [
      {
        find: 'react-dom',
        replacement: fileURLToPath(new URL('react-dom', desktopModules)),
      },
      {
        find: 'react',
        replacement: fileURLToPath(new URL('react', desktopModules)),
      },
    ],
  },
};
