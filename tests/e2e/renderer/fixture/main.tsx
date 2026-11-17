import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from '../../../../apps/desktop/src/App';
import '../../../../apps/desktop/src/styles.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing #root element');
}

createRoot(root).render(
  <StrictMode>
    <App
      core={{
        health: async () => ({
          version: 'renderer-fixture',
          databaseReady: true,
          secretStoreReady: true,
        }),
      }}
    />
  </StrictMode>,
);
