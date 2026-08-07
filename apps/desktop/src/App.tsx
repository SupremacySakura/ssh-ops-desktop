import { useEffect, useState } from 'react';

import type { CoreClient, CoreHealth } from './api/core';

interface AppProps {
  core: CoreClient;
}

type HealthState =
  | { status: 'loading' }
  | { status: 'loaded'; health: CoreHealth }
  | { status: 'error' };

export default function App({ core }: AppProps) {
  const [healthState, setHealthState] = useState<HealthState>({ status: 'loading' });

  useEffect(() => {
    let active = true;

    setHealthState({ status: 'loading' });

    async function loadHealth() {
      try {
        const health = await core.health();

        if (active) {
          setHealthState({ status: 'loaded', health });
        }
      } catch {
        if (active) {
          setHealthState({ status: 'error' });
        }
      }
    }

    void loadHealth();

    return () => {
      active = false;
    };
  }, [core]);

  const ready =
    healthState.status === 'loaded' &&
    healthState.health.databaseReady &&
    healthState.health.secretStoreReady;

  return (
    <main>
      <h1>OpsPilot</h1>
      {healthState.status === 'loading' ? <p>正在检查 Core</p> : null}
      {healthState.status === 'error' ? <p role="alert">无法读取 Core 状态</p> : null}
      {healthState.status === 'loaded' ? (
        <section aria-label="Core 状态">
          <p>{ready ? 'Core 已就绪' : 'Core 未就绪'}</p>
          <p>版本 {healthState.health.version}</p>
        </section>
      ) : null}
    </main>
  );
}
