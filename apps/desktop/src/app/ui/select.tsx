import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

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

export function Select({ 'aria-label': ariaLabel, className, onChange, options, placeholder, value }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const choose = (option: SelectOption) => {
    onChange(option.value);
    setOpen(false);
  };

  const toggle = () => {
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen((current) => !current);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(options.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) choose(option);
    }
  };

  return (
    <div className={`ui-select${open ? ' open' : ''}${className ? ` ${className}` : ''}`} onKeyDown={onKeyDown} ref={root}>
      <button aria-expanded={open} aria-haspopup="listbox" aria-label={ariaLabel} className="ui-select-trigger" type="button" onClick={toggle}>
        <span className={selected ? 'ui-select-value' : 'ui-select-value placeholder'}>{selected?.label ?? placeholder ?? '请选择'}</span>
        <Icon name="chevron-down" size={14} />
      </button>
      {open ? <ul aria-label={`${ariaLabel}选项`} className="ui-select-menu" role="listbox">
        {options.map((option, index) => (
          <li
            aria-selected={option.value === value}
            className={index === activeIndex ? 'ui-select-option active' : 'ui-select-option'}
            key={`${option.value}-${index}`}
            onClick={() => choose(option)}
            onMouseEnter={() => setActiveIndex(index)}
            ref={index === activeIndex ? (element) => element?.scrollIntoView?.({ block: 'nearest' }) : undefined}
            role="option"
          >
            {option.label}
          </li>
        ))}
      </ul> : null}
    </div>
  );
}
