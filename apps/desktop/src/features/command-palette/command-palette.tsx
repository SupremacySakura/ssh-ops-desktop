import { CornerDownLeft, Plus, Search } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { filterServers, useHarborStore } from '../../store/harbor-store';

export function CommandPalette() {
  const closeCommandPalette = useHarborStore((state) => state.closeCommandPalette);
  const commandPaletteOpen = useHarborStore((state) => state.commandPaletteOpen);
  const openAddServer = useHarborStore((state) => state.openAddServer);
  const openCommandPalette = useHarborStore((state) => state.openCommandPalette);
  const selectServer = useHarborStore((state) => state.selectServer);
  const servers = useHarborStore((state) => state.servers);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  const serverItems = filterServers(servers, query).map((server) => ({
    key: `server:${server.id}`,
    label: server.name,
    detail: `${server.user}@${server.host}:${server.port}`,
    run: () => {
      selectServer(server.id);
      closeCommandPalette();
    },
  }));
  const addServerMatches = matches(query, '添加服务器');
  const items = [
    ...serverItems,
    ...(addServerMatches
      ? [{
          key: 'action:add-server',
          label: '添加服务器',
          detail: '建立一条新的服务器记录',
          run: openAddServer,
        }]
      : []),
  ];
  const activeItem = items[activeIndex];

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (
        event.key.toLocaleLowerCase('en-US') === 'k'
        && (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        openCommandPalette();
      }
    }

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [openCommandPalette]);

  useEffect(() => {
    if (!commandPaletteOpen) return;
    setQuery('');
    setActiveIndex(0);
    searchRef.current?.focus();
  }, [commandPaletteOpen]);

  useEffect(() => {
    if (!commandPaletteOpen) return;

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') closeCommandPalette();
    }

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [closeCommandPalette, commandPaletteOpen]);

  if (!commandPaletteOpen) return null;

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, items.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === 'Enter' && activeItem) {
      event.preventDefault();
      activeItem.run();
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-ink/40 px-6 pt-[16vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeCommandPalette();
      }}
    >
      <section
        aria-labelledby="command-palette-title"
        aria-modal="true"
        className="w-[620px] border border-ink bg-shell"
        role="dialog"
      >
        <h2 className="sr-only" id="command-palette-title">命令面板</h2>

        <label className="flex h-12 items-center gap-3 border-b border-hairline bg-paper px-4">
          <Search aria-hidden className="size-4 shrink-0 text-muted" strokeWidth={1.5} />
          <input
            aria-activedescendant={activeItem ? `command-palette-${activeIndex}` : undefined}
            aria-controls="command-palette-results"
            aria-label="搜索服务器或命令"
            autoCapitalize="none"
            autoCorrect="off"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-muted"
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="搜索服务器、主机或命令…"
            ref={searchRef}
            spellCheck={false}
            type="search"
            value={query}
          />
          <kbd className="border border-hairline px-1.5 py-0.5 font-mono text-[10px] text-muted">
            ESC
          </kbd>
        </label>

        <div className="flex items-center gap-2 px-4 pb-1 pt-3 text-[10px] tracking-[0.16em] text-muted">
          <span>结果</span>
          <span aria-hidden className="h-px flex-1 bg-hairline" />
          <span className="font-mono tabular-nums">{items.length}</span>
        </div>

        {items.length > 0 ? (
          <div
            aria-label="命令结果"
            className="max-h-[min(420px,52dvh)] overflow-y-auto px-2 pb-2"
            id="command-palette-results"
            role="listbox"
          >
            {items.map((item, index) => {
              const selected = index === activeIndex;
              return (
                <button
                  aria-selected={selected}
                  className={`mt-1 flex min-h-12 w-full items-center gap-3 border px-3 py-2 text-left ${
                    selected
                      ? 'border-ink bg-ink text-paper'
                      : 'border-transparent text-ink hover:border-hairline hover:bg-paper'
                  }`}
                  id={`command-palette-${index}`}
                  key={item.key}
                  onClick={item.run}
                  onMouseEnter={() => setActiveIndex(index)}
                  role="option"
                  type="button"
                >
                  <span
                    aria-hidden
                    className={`grid size-6 shrink-0 place-items-center border ${
                      selected ? 'border-[#6D6A62]' : 'border-hairline'
                    }`}
                  >
                    {item.key === 'action:add-server' ? (
                      <Plus className="size-3" strokeWidth={1.5} />
                    ) : (
                      <span className={`size-1.5 ${selected ? 'bg-accent' : 'bg-ink'}`} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium">
                      {item.label}
                    </span>
                    <span
                      className={`mt-0.5 block truncate font-mono text-[10px] ${
                        selected ? 'text-[#B9B4A8]' : 'text-muted'
                      }`}
                    >
                      {item.detail}
                    </span>
                  </span>
                  {selected ? (
                    <CornerDownLeft
                      aria-hidden
                      className="size-3.5 shrink-0 text-[#B9B4A8]"
                      strokeWidth={1.5}
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="border-t border-dashed border-hairline px-4 py-8 text-center text-[12px] text-muted">
            没有匹配的服务器或命令。
          </p>
        )}

        <footer className="flex items-center justify-between border-t border-hairline px-4 py-2.5 font-mono text-[9px] tracking-[0.08em] text-muted">
          <span>↑↓ 选择</span>
          <span>ENTER 打开</span>
        </footer>
      </section>
    </div>
  );
}

function matches(query: string, value: string): boolean {
  const needle = query.trim().toLocaleLowerCase('zh-CN');
  return needle.length === 0 || value.toLocaleLowerCase('zh-CN').includes(needle);
}
