import {
  FileInput,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Star,
} from 'lucide-react';
import { useRef } from 'react';

import { CoreStatus } from '../../components/core-status';
import {
  buildCatalogSections,
  formatLastConnectedAt,
  useHarborStore,
} from '../../store/harbor-store';

export function ServerListPane() {
  const catalogBusy = useHarborStore((state) => state.catalogBusy);
  const catalogError = useHarborStore((state) => state.catalogError);
  const catalogStatus = useHarborStore((state) => state.catalogStatus);
  const groups = useHarborStore((state) => state.groups);
  const loadCatalog = useHarborStore((state) => state.loadCatalog);
  const openAddServer = useHarborStore((state) => state.openAddServer);
  const openGroupManager = useHarborStore((state) => state.openGroupManager);
  const openSshConfigImport = useHarborStore((state) => state.openSshConfigImport);
  const query = useHarborStore((state) => state.query);
  const selectServer = useHarborStore((state) => state.selectServer);
  const selectedServerId = useHarborStore((state) => state.selectedServerId);
  const servers = useHarborStore((state) => state.servers);
  const setQuery = useHarborStore((state) => state.setQuery);
  const toggleFavorite = useHarborStore((state) => state.toggleFavorite);
  const searchRef = useRef<HTMLInputElement>(null);
  const sections = buildCatalogSections(servers, groups, query);
  const visibleCount = sections.reduce((count, section) => count + section.servers.length, 0);
  const noMatches = query.trim().length > 0 && visibleCount === 0;
  const catalogEmpty = catalogStatus === 'ready' && servers.length === 0;
  const catalogLoading = catalogStatus === 'idle' || catalogStatus === 'loading';

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
        <kbd
          aria-label="按 Command-K 打开命令面板"
          className="border border-hairline px-1.5 py-0.5 font-mono text-[10px] text-muted"
        >
          ⌘K
        </kbd>
      </label>

      {catalogError ? (
        <div className="mt-3 border-l-2 border-danger bg-paper px-2.5 py-2" role="alert">
          <p className="text-[10px] leading-4 text-danger">{catalogError}</p>
          {catalogStatus === 'error' ? (
            <button
              className="mt-2 inline-flex items-center gap-1 text-[10px] font-medium text-ink underline decoration-hairline underline-offset-2"
              onClick={() => void loadCatalog()}
              type="button"
            >
              <RefreshCw aria-hidden className="size-3" strokeWidth={1.5} />
              重试
            </button>
          ) : null}
        </div>
      ) : null}

      <section className="flex min-h-0 flex-1 flex-col" aria-label="服务器目录">
        <div className="mt-6 flex items-center gap-2 text-[10px] tracking-[0.16em] text-muted">
          <span>服务器</span>
          <span className="h-px flex-1 bg-hairline" />
          <span className="font-mono tabular-nums">{visibleCount}</span>
        </div>

        {catalogLoading ? (
          <div className="mt-6 space-y-2" aria-label="正在读取服务器目录" role="status">
            {[0, 1, 2].map((item) => (
              <div className="h-11 animate-pulse border border-hairline bg-paper/60" key={item} />
            ))}
          </div>
        ) : null}

        {!catalogLoading && sections.length > 0 ? (
          <div className="-mx-1.5 mt-3 min-h-0 flex-1 overflow-y-auto px-1.5 pb-4">
            {sections.map((section) => (
              <section
                aria-label={section.title}
                className="mt-3 first:mt-0"
                key={section.key}
              >
                <h2
                  aria-label={`${section.title}，${section.servers.length} 台服务器`}
                  className="flex items-center gap-2 text-[10px] font-normal tracking-[0.16em] text-muted"
                >
                  <span>{section.title}</span>
                  <span aria-hidden className="h-px flex-1 bg-hairline" />
                  <span aria-hidden className="font-mono tabular-nums">
                    {section.servers.length}
                  </span>
                </h2>
                <ul className="mt-1.5 space-y-1">
                  {section.servers.map((server) => {
                    const selected = server.id === selectedServerId;
                    return (
                      <li
                        className={`group flex min-h-11 border ${
                          selected
                            ? 'border-ink bg-ink text-paper'
                            : 'border-transparent hover:border-hairline hover:bg-paper'
                        }`}
                        key={server.id}
                      >
                        <button
                          aria-current={selected ? 'true' : undefined}
                          aria-label={`打开服务器 ${server.name}，${server.user}@${server.host}:${server.port}`}
                          className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-left"
                          onClick={() => selectServer(server.id)}
                          type="button"
                        >
                          <span
                            aria-hidden
                            className={`size-2 shrink-0 ${
                              section.isFavorites ? 'bg-accent' : 'bg-hairline'
                            }`}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-baseline gap-2">
                              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                                {server.name}
                              </span>
                              <span
                                className={`shrink-0 font-mono text-[10px] ${
                                  selected ? 'text-[#B9B4A8]' : 'text-muted'
                                }`}
                              >
                                {server.secretRef === null
                                  ? '凭据待配置'
                                  : formatLastConnectedAt(server.lastConnectedAt)}
                              </span>
                            </span>
                            <span
                              className={`mt-0.5 block truncate font-mono text-[10px] ${
                                selected ? 'text-[#B9B4A8]' : 'text-muted'
                              }`}
                            >
                              {server.user}@{server.host}:{server.port}
                            </span>
                          </span>
                        </button>
                        <button
                          aria-label={
                            server.favorite
                              ? `取消收藏 ${server.name}`
                              : `收藏 ${server.name}`
                          }
                          aria-pressed={server.favorite}
                          className={`grid w-8 shrink-0 place-items-center ${
                            selected ? 'text-accent' : 'text-muted hover:text-accent'
                          }`}
                          disabled={catalogBusy}
                          onClick={() => void toggleFavorite(server.id)}
                          type="button"
                        >
                          <Star
                            aria-hidden
                            className="size-3"
                            fill={server.favorite ? 'currentColor' : 'none'}
                            strokeWidth={1.5}
                          />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        ) : null}

        {!catalogLoading && (catalogEmpty || noMatches) ? (
          <div className="mt-8 border-y border-dashed border-hairline px-3 py-8 text-center">
          <p className="text-[13px] font-medium text-ink" role="heading" aria-level={2}>
              {noMatches ? '没有匹配的服务器' : '还没有服务器'}
          </p>
          <p className="mt-2 text-[11px] leading-5 text-muted">
            {noMatches
              ? '换一个名称、主机或用户名试试。'
                : '添加第一台服务器，让机器停靠在这里。'}
          </p>
            {!noMatches ? (
              <button
                className="mt-4 inline-flex h-8 items-center gap-1.5 bg-ink px-3 text-[11px] font-medium text-paper"
                onClick={openAddServer}
                type="button"
              >
                <Plus aria-hidden className="size-3.5" strokeWidth={1.5} />
                添加服务器
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      <footer className="mt-auto border-t border-hairline pt-3">
        <div className="mb-3 grid grid-cols-2 gap-1.5">
          <button
            className="inline-flex h-8 items-center justify-center gap-1.5 bg-ink px-2 text-[11px] font-medium text-paper disabled:opacity-40"
            disabled={catalogBusy}
            onClick={openAddServer}
            type="button"
          >
            <Plus aria-hidden className="size-3.5" strokeWidth={1.5} />
            添加服务器
          </button>
          <button
            className="inline-flex h-8 items-center justify-center gap-1.5 border border-hairline bg-transparent px-2 text-[11px] font-medium text-ink hover:bg-paper disabled:opacity-40"
            disabled={catalogBusy}
            onClick={openGroupManager}
            type="button"
          >
            <Settings2 aria-hidden className="size-3.5" strokeWidth={1.5} />
            管理分组
          </button>
        </div>
        <button
          className="mb-3 inline-flex h-8 w-full items-center justify-center gap-1.5 border border-hairline bg-transparent px-2 text-[11px] font-medium text-ink hover:bg-paper disabled:opacity-40"
          disabled={catalogBusy}
          onClick={() => void openSshConfigImport()}
          type="button"
        >
          <FileInput aria-hidden className="size-3.5" strokeWidth={1.5} />
          从 SSH Config 导入
        </button>
        <CoreStatus />
      </footer>
    </aside>
  );
}
