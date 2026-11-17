import { ServerListPane } from '../features/catalog/server-list-pane';
import { EmptyWorkspace } from '../features/workspace/empty-workspace';

export function HarborShell() {
  return (
    <div className="flex min-h-dvh min-w-[1024px] overflow-hidden bg-shell text-ink">
      <ServerListPane />
      <EmptyWorkspace />
    </div>
  );
}
