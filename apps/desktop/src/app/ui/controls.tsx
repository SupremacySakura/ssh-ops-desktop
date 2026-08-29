import { useEffect, useRef, type ReactNode } from 'react';

/* ============================================================
   苹果风格基础控件（样式来自 styles.css，不新增 CSS）
   StatusTag / Toggle / SegmentedControl / Kbd / Toast
   ============================================================ */

export type TagTone = 'success' | 'warning' | 'error' | 'neutral';

export function StatusTag({ children, tone = 'neutral' }: { children: ReactNode; tone?: TagTone }) {
  return <span className={`status-tag ${tone}`}>{children}</span>;
}

export function Toggle({
  'aria-label': ariaLabel,
  checked,
  onChange,
}: {
  'aria-label': string;
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={ariaLabel}
      className={checked ? 'toggle active' : 'toggle'}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span className="sr-only">{ariaLabel}</span>
    </button>
  );
}

export interface SegmentedOption<T extends string = string> {
  label: string;
  value: T;
}

export function SegmentedControl<T extends string = string>({
  'aria-label': ariaLabel,
  onChange,
  options,
  value,
}: {
  'aria-label'?: string;
  onChange(value: T): void;
  options: SegmentedOption<T>[];
  value: T;
}) {
  return (
    <div aria-label={ariaLabel} className="tabs" role="radiogroup">
      {options.map((option) => (
        <button
          aria-checked={option.value === value}
          className={option.value === value ? 'tab active' : 'tab'}
          key={option.value}
          onClick={() => onChange(option.value)}
          role="radio"
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export type ToastTone = 'success' | 'warning' | 'error' | 'neutral';

export function Toast({
  message,
  onClose,
  tone = 'neutral',
}: {
  message: string;
  onClose(): void;
  tone?: ToastTone;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    timerRef.current = setTimeout(onClose, 3000);
    return () => clearTimeout(timerRef.current);
  }, [onClose]);

  return (
    <div
      className={`toast toast-${tone}`}
      onClick={onClose}
      role="status"
    >
      <span>{message}</span>
      <button aria-label="关闭通知" onClick={onClose} type="button">✕</button>
    </div>
  );
}
