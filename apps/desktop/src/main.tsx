import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import App from './App';
import { createTauriCoreClient } from './api/core';
import './styles.css';

const root = document.getElementById('root');

async function bootstrap() {
  if (!root) {
    throw new Error('Missing #root element');
  }

  if (import.meta.env.MODE === 'native-e2e') {
    await import('@wdio/tauri-plugin');
  }

  createRoot(root).render(
    <StrictMode>
      <App core={createTauriCoreClient()} />
    </StrictMode>,
  );
}

void bootstrap();
