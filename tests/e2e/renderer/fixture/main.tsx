import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from '../../../../apps/desktop/src/App';
import '../../../../apps/desktop/src/styles.css';
import { createFakeCoreClient } from '../../../../apps/desktop/src/test/fake-core';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing #root element');
}

const core = createFakeCoreClient({
  health: {
    version: 'renderer-fixture',
    databaseReady: true,
    secretStoreReady: true,
  },
});

createRoot(root).render(
  <StrictMode>
    <App core={core} />
  </StrictMode>,
);
