import { useEffect } from 'react';

import type { CoreClient } from './api/core';
import { HarborShell } from './app/harbor-shell';
import { useHarborStore } from './store/harbor-store';

interface AppProps {
  core: CoreClient;
}

export default function App({ core }: AppProps) {
  const setCoreHealth = useHarborStore((state) => state.setCoreHealth);

  useEffect(() => {
    let active = true;
    setCoreHealth({ status: 'loading' });

    void core.health()
      .then((health) => {
        if (active) setCoreHealth({ status: 'ready', health });
      })
      .catch(() => {
        if (active) setCoreHealth({ status: 'unavailable' });
      });

    return () => {
      active = false;
    };
  }, [core, setCoreHealth]);

  return <HarborShell />;
}
