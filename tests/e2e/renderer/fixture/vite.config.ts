import { fileURLToPath } from 'node:url';

const desktopModules = new URL('../../../../apps/desktop/node_modules/', import.meta.url);

export default {
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
