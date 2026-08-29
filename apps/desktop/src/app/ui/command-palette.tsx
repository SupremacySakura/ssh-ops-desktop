import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { Icon, type IconName } from '../icons';

export interface CommandAction {
  hint?: string;
  icon?: IconName;
  id: string;
  label: string;
  run(): void;
}

export function CommandPalette({ actions, onClose, open }: {
  actions: CommandAction[];
  onClose(): void;
  open: boolean;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) { setQuery(''); return; }
    setActive(0);
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, open]);

  if (!open) return null;

  const filtered = actions.filter((action) => action.label.toLowerCase().includes(query.toLowerCase()));
  const run = (action: CommandAction) => { onClose(); action.run(); };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(filtered.length - 1, index + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(0, index - 1)); }
    else if (event.key === 'Enter') {
      event.preventDefault();
      const action = filtered[active];
      if (action) run(action);
    }
  };

  return (
    <div
      className="command-palette-overlay"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div aria-label="命令面板" aria-modal="true" className="command-palette" role="dialog">
        <div className="command-palette-search">
          <Icon name="search" size={16} />
          <input
            aria-label="命令面板搜索"
            onChange={(event) => { setQuery(event.target.value); setActive(0); }}
            onKeyDown={onKeyDown}
            placeholder="搜索页面或命令…"
            ref={inputRef}
            value={query}
          />
          <kbd>ESC</kbd>
        </div>
        <ul className="command-palette-list" role="listbox">
          {filtered.length === 0
            ? <li className="command-palette-empty">没有匹配的命令</li>
            : filtered.map((action, index) => (
              <li
                aria-selected={index === active}
                className={index === active ? 'command-palette-item active' : 'command-palette-item'}
                key={action.id}
                onClick={() => run(action)}
                onMouseEnter={() => setActive(index)}
                role="option"
              >
                {action.icon ? <Icon name={action.icon} size={16} /> : null}
                <span>{action.label}</span>
                {action.hint ? <small>{action.hint}</small> : null}
              </li>
            ))}
        </ul>
      </div>
    </div>
  );
}
