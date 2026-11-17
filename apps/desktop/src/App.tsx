import { useEffect } from 'react';

import type { CoreClient } from './api/core';
import { HarborShell } from './app/harbor-shell';
import { GroupManagerDialog } from './features/catalog/group-manager-dialog';
import { ServerFormDialog } from './features/catalog/server-form-dialog';
import { CommandPalette } from './features/command-palette/command-palette';
import { SshConfigImportDialog } from './features/import/ssh-config-import-dialog';
import { useHarborStore } from './store/harbor-store';

interface AppProps {
  core: CoreClient;
}

export default function App({ core }: AppProps) {
  const configureCore = useHarborStore((state) => state.configureCore);
  const loadCatalog = useHarborStore((state) => state.loadCatalog);
  const setCoreHealth = useHarborStore((state) => state.setCoreHealth);

  useEffect(() => {
    configureCore(core);
    void loadCatalog();
  }, [configureCore, core, loadCatalog]);

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

  return (
    <>
      <HarborShell />
      <ServerFormDialog />
      <GroupManagerDialog />
      <CommandPalette />
      <SshConfigImportDialog />
    </>
  );
}
