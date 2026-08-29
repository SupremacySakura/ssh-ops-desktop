import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../icons';

export interface SelectOption {
  label: string;
  value: string;
}

interface SelectProps {
  'aria-label': string;
  className?: string;
  onChange(value: string): void;
  options: SelectOption[];
  placeholder?: string;
  value: string;
}

/** 同一时间只允许一个下拉打开 */
let closeActive: ((focusTrigger: boolean) => void) | null = null;

export function Select({
  'aria-label': ariaLabel,
  className,
  onChange,
  options,
  placeholder,
  value,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const selected = options.find((option) => option.value === value);

  const close = useCallback((focusTrigger = true) => {
    setOpen(false);
    if (closeActive === close) closeActive = null;
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  const openMenu = useCallback(() => {
    closeActive?.(false);
    closeActive = close;
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  }, [close, options, value]);

  const choose = useCallback((option: SelectOption) => {
    onChange(option.value);
    close(true);
  }, [close, onChange]);

  const toggle = useCallback(() => {
    if (open) close(true);
    else openMenu();
  }, [close, open, openMenu]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape') {
      close(true);
      return;
    }
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((index) => Math.min(options.length - 1, index + 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((index) => Math.max(0, index - 1));
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        {
          const option = options[activeIndex];
          if (option) choose(option);
        }
        break;
    }
  };

  /* 打开时把菜单定位到触发器正下方（viewport 坐标，portal 挂到 body） */
  useLayoutEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!menu || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    const menuWidth = Math.min(Math.max(menu.offsetWidth, rect.width), 320);
    let left = rect.left;
    if (rect.left + menuWidth > window.innerWidth - 8) left = rect.right - menuWidth;
    let top = rect.bottom + 6;
    if (top + menu.offsetHeight > window.innerHeight - 8 && rect.top > menu.offsetHeight + 6 + 8) {
      top = rect.top - menu.offsetHeight - 6;
    }
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
    menu.style.width = `${menuWidth}px`;
    menu.style.maxWidth = '320px';
  }, [activeIndex, open]);

  /* 外部点击 / 滚动 / 缩放关闭 */
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) close(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('mousedown', onDown);
    const onScroll = () => close(false);
    window.addEventListener('scroll', onScroll, true);
    const onResize = () => close(false);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [close, open]);

  /* 键盘高亮项滚入视野 */
  useEffect(() => {
    if (!open) return;
    const active = menuRef.current?.querySelector<HTMLElement>('.ui-select-option.active');
    try { active?.scrollIntoView?.({ block: 'nearest' }); } catch { /* ignore */ }
  }, [activeIndex, open]);

  /* 卸载时清空全局引用 */
  useEffect(() => () => {
    if (closeActive === close) closeActive = null;
  }, [close]);

  return (
    <div className={`ui-select${open ? ' open' : ''}${className ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="ui-select-trigger"
        onClick={toggle}
        onKeyDown={onKeyDown}
        ref={triggerRef}
        type="button"
      >
        <span className={selected ? 'ui-select-value' : 'ui-select-value placeholder'}>
          {selected?.label ?? placeholder ?? '请选择'}
        </span>
        <Icon name="chevron-down" size={14} />
      </button>
      {open ? createPortal(
        <ul aria-label={`${ariaLabel}选项`} className="ui-select-menu" ref={menuRef} role="listbox">
          {options.map((option, index) => (
            <li
              aria-selected={option.value === value}
              className={index === activeIndex ? 'ui-select-option active' : 'ui-select-option'}
              key={`${option.value}-${index}`}
              onClick={() => choose(option)}
              onMouseEnter={() => setActiveIndex(index)}
              role="option"
            >
              <span>{option.label}</span>
              {option.value === value ? <Icon name="check" size={14} /> : null}
            </li>
          ))}
        </ul>,
        document.body,
      ) : null}
    </div>
  );
}
