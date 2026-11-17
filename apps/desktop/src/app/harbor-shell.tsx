import { useEffect, useState } from 'react';

import { ServerListPane } from '../features/catalog/server-list-pane';
import { EmptyWorkspace } from '../features/workspace/empty-workspace';
import { ServerWorkspace } from '../features/workspace/server-workspace';
import { useHarborStore } from '../store/harbor-store';

export function HarborShell() {
  const selectedServerId = useHarborStore((state) => state.selectedServerId);
  const servers = useHarborStore((state) => state.servers);
  const [visitedServerIds, setVisitedServerIds] = useState<string[]>([]);

  useEffect(() => {
    if (
      !selectedServerId
      || !servers.some((server) => server.id === selectedServerId)
    ) {
      return;
    }
    setVisitedServerIds((visited) => (
      visited.includes(selectedServerId)
        ? visited
        : [...visited, selectedServerId]
    ));
  }, [selectedServerId, servers]);

  const visitedServers = visitedServerIds.flatMap((serverId) => {
    const server = servers.find((candidate) => candidate.id === serverId);
    return server ? [server] : [];
  });

  return (
    <div className="flex min-h-dvh min-w-[1024px] overflow-hidden bg-shell text-ink">
      <ServerListPane />
      <div className="flex min-w-0 flex-1">
        {selectedServerId === null ? <EmptyWorkspace /> : null}
        {visitedServers.map((server) => {
          const selected = server.id === selectedServerId;
          return (
            <div
              aria-hidden={!selected}
              className={selected ? 'contents' : 'hidden'}
              key={server.id}
            >
              <ServerWorkspace active={selected} server={server} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
