import { Search } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { CoreStatus } from '../../components/core-status';
import { useHarborStore } from '../../store/harbor-store';

export function ServerListPane() {
  const query = useHarborStore((state) => state.query);
  const servers = useHarborStore((state) => state.servers);
  const setQuery = useHarborStore((state) => state.setQuery);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }

    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);

  const visibleServers = query.trim().length === 0
    ? servers
    : servers.filter((server) => {
        const needle = query.trim().toLocaleLowerCase('zh-CN');
        return [server.name, server.host, server.user].some((value) => (
          value.toLocaleLowerCase('zh-CN').includes(needle)
        ));
      });
  const noMatches = query.trim().length > 0 && visibleServers.length === 0;

  return (
    <aside className="flex h-dvh w-[300px] shrink-0 flex-col border-r border-hairline bg-shell px-[18px] py-[22px]">
      <header>
        <h1 className="text-[20px] font-semibold tracking-[0.22em] text-ink">
          <span>HARBOR</span>
          <span aria-hidden className="text-accent">.</span>
        </h1>
        <p className="mt-1 text-[10px] tracking-[0.18em] text-muted">LOCAL SSH OPERATIONS</p>
      </header>

      <label className="mt-6 flex h-[34px] items-center gap-2 border border-hairline bg-paper px-2.5 focus-within:border-accent">
        <Search aria-hidden className="size-3.5 shrink-0 text-muted" strokeWidth={1.5} />
        <input
          aria-label="搜索服务器"
          className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-muted"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索服务器…"
          ref={searchRef}
          type="search"
          value={query}
        />
        <kbd className="border border-hairline px-1.5 py-0.5 font-mono text-[10px] text-muted">
          ⌘K
        </kbd>
      </label>

      <section className="flex min-h-0 flex-1 flex-col" aria-label="服务器目录">
        <div className="mt-6 flex items-center gap-2 text-[10px] tracking-[0.16em] text-muted">
          <span>服务器</span>
          <span className="h-px flex-1 bg-hairline" />
          <span className="font-mono tabular-nums">{visibleServers.length}</span>
        </div>

        <div className="mt-8 border-y border-dashed border-hairline px-3 py-8 text-center">
          <p className="text-[13px] font-medium text-ink" role="heading" aria-level={2}>
            {noMatches ? '没有匹配的服务器' : '还没有服务器'}
          </p>
          <p className="mt-2 text-[11px] leading-5 text-muted">
            {noMatches
              ? '换一个名称、主机或用户名试试。'
              : '服务器目录接入后，机器会按分组停靠在这里。'}
          </p>
        </div>
      </section>

      <footer className="mt-auto border-t border-hairline pt-3">
        <CoreStatus />
      </footer>
    </aside>
  );
}
