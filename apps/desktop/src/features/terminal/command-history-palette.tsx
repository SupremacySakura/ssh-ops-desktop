import { CornerDownLeft, History, Search, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { CommandHistoryEntry } from './command-history';
import { useCommandHistory } from './command-history';

interface CommandHistoryPaletteProps {
  onClose(): void;
  onSelect(command: string): void;
  open: boolean;
  serverId: string;
  serverName: string;
}

export function CommandHistoryPalette({
  onClose,
  onSelect,
  open,
  serverId,
  serverName,
}: CommandHistoryPaletteProps) {
  const history = useCommandHistory();
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<CommandHistoryEntry[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void history.search(serverId, query, 50)
        .then((results) => {
          if (!active) return;
          setEntries(results);
          setActiveIndex(0);
        })
        .catch(() => {
          if (active) setEntries([]);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 80);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [history, open, query, serverId]);

  if (!open) return null;

  function choose(index: number) {
    const entry = entries[index];
    if (!entry) return;
    onSelect(entry.command);
    onClose();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, entries.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      choose(activeIndex);
    }
  }

  return (
    <section
      aria-label="命令历史"
      aria-modal="false"
      className="absolute inset-x-4 top-4 z-30 max-h-[min(440px,70%)] border border-ink bg-shell"
      role="dialog"
    >
      <header className="flex h-11 items-center gap-3 border-b border-hairline bg-paper px-3">
        <History aria-hidden className="size-3.5 text-accent" strokeWidth={1.5} />
        <div className="min-w-0">
          <p className="text-[10px] tracking-[0.14em] text-muted">LOCAL COMMAND HISTORY</p>
          <p className="truncate font-mono text-[10px] text-ink">{serverName}</p>
        </div>
        <span className="ml-auto font-mono text-[9px] tracking-[0.08em] text-muted">CTRL+R</span>
        <button
          aria-label="关闭命令历史"
          className="grid size-7 place-items-center text-muted hover:bg-shell hover:text-ink"
          onClick={onClose}
          type="button"
        >
          <X aria-hidden className="size-3.5" strokeWidth={1.5} />
        </button>
      </header>
      <label className="flex h-11 items-center gap-2 border-b border-hairline bg-paper px-3">
        <Search aria-hidden className="size-3.5 text-muted" strokeWidth={1.5} />
        <input
          aria-label="搜索命令历史"
          autoCapitalize="none"
          autoCorrect="off"
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-muted"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入命令片段，模糊搜索…"
          ref={inputRef}
          spellCheck={false}
          type="search"
          value={query}
        />
        <span className="font-mono text-[9px] text-muted">{entries.length}</span>
      </label>

      {loading && entries.length === 0 ? (
        <div className="h-0.5 overflow-hidden bg-hairline" role="status" aria-label="正在搜索命令历史">
          <span className="block h-full w-1/2 animate-pulse bg-accent" />
        </div>
      ) : null}

      {entries.length > 0 ? (
        <div className="max-h-[340px] overflow-y-auto p-1.5" role="listbox" aria-label="命令历史结果">
          {entries.map((entry, index) => {
            const selected = index === activeIndex;
            return (
              <button
                aria-selected={selected}
                className={`flex w-full items-start gap-3 border px-2.5 py-2 text-left ${
                  selected
                    ? 'border-ink bg-ink text-paper'
                    : 'border-transparent text-ink hover:border-hairline hover:bg-paper'
                }`}
                key={`${entry.id ?? entry.executedAt}:${entry.command}`}
                onClick={() => choose(index)}
                onMouseEnter={() => setActiveIndex(index)}
                role="option"
                type="button"
              >
                <span
                  className={`mt-0.5 font-mono text-[9px] ${
                    selected ? 'text-[#B9B4A8]' : 'text-muted'
                  }`}
                >
                  {formatHistoryTime(entry.executedAt)}
                </span>
                <span className="min-w-0 flex-1 break-all font-mono text-[11px] leading-5">
                  {entry.command}
                </span>
                {selected ? (
                  <CornerDownLeft
                    aria-hidden
                    className="mt-1 size-3 shrink-0 text-[#B9B4A8]"
                    strokeWidth={1.5}
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {!loading && entries.length === 0 ? (
        <p className="border-t border-dashed border-hairline px-4 py-8 text-center text-[11px] text-muted">
          {query.trim().length > 0
            ? '没有匹配的命令。'
            : '这台服务器还没有本地命令历史。执行命令后会出现在这里。'}
        </p>
      ) : null}

      <footer className="flex items-center justify-between border-t border-hairline px-3 py-2 font-mono text-[9px] tracking-[0.08em] text-muted">
        <span>↑↓ 选择</span>
        <span>ENTER 插入</span>
        <span>ESC 关闭</span>
      </footer>
    </section>
  );
}

function formatHistoryTime(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}
