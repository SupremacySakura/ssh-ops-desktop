import type { ConnectionHandle } from '@opspilot/contracts';
import { useEffect } from 'react';

import { useHarborStore } from '../../store/harbor-store';
import { useMonitorStore } from '../../store/monitor-store';
import type { ServerConnectionStatus } from '../../store/terminal-store';

export function useMonitorSampling({
  active,
  connection,
  serverId,
  status,
}: {
  active: boolean;
  connection: ConnectionHandle | null | undefined;
  serverId: string;
  status: ServerConnectionStatus;
}) {
  const core = useHarborStore((state) => state.core);
  const startSampling = useMonitorStore((state) => state.startSampling);
  const stopSampling = useMonitorStore((state) => state.stopSampling);

  useEffect(() => {
    if (!active) {
      stopSampling(serverId, connection?.connectionId);
      return;
    }
    if (!core || !connection || status !== 'ready') {
      const offline = status === 'closed'
        || status === 'error'
        || status === 'blocked';
      stopSampling(
        serverId,
        connection?.connectionId,
        offline ? 'offline' : 'idle',
      );
      return;
    }
    startSampling(core, connection);
    return () => stopSampling(serverId, connection.connectionId);
  }, [
    active,
    connection,
    core,
    serverId,
    startSampling,
    status,
    stopSampling,
  ]);
}
