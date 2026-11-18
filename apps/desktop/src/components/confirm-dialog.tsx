import { AlertTriangle, X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';

import { useDialogFocusTrap } from './use-dialog-focus-trap';

interface ConfirmDialogProps {
  active?: boolean;
  busy?: boolean;
  busyLabel?: string;
  cancelLabel?: string;
  confirmLabel: string;
  confirmDisabled?: boolean;
  description: ReactNode;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
  tone?: 'danger' | 'warning';
}

export function ConfirmDialog({
  active = true,
  busy = false,
  busyLabel = '处理中…',
  cancelLabel = '取消',
  confirmLabel,
  confirmDisabled = false,
  description,
  error,
  onCancel,
  onConfirm,
  title,
  tone = 'danger',
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const warning = tone === 'warning';
  const titleId = useId();

  useDialogFocusTrap(sectionRef, {
    active,
    canEscape: !busy,
    onEscape: onCancel,
  });

  useEffect(() => {
    if (active) cancelRef.current?.focus();
  }, [active]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy && active) onCancel();
      }}
    >
      <section
        aria-busy={busy}
        aria-labelledby={titleId}
        aria-modal="true"
        className="w-[440px] border border-ink bg-shell"
        ref={sectionRef}
        role="alertdialog"
        tabIndex={-1}
      >
        <header className="flex items-start gap-3 border-b border-hairline px-5 py-4">
          <span
            className={`mt-0.5 grid size-8 shrink-0 place-items-center border ${
              warning ? 'border-warning text-warning' : 'border-danger text-danger'
            }`}
          >
            <AlertTriangle aria-hidden className="size-4" strokeWidth={1.5} />
          </span>
          <div className="min-w-0 flex-1">
            <p
              className={`font-mono text-[9px] tracking-[0.16em] ${
                warning ? 'text-warning' : 'text-danger'
              }`}
            >
              {warning ? 'CONFIRM ACTION' : 'DANGER ACTION'}
            </p>
            <h2
              className="mt-1 text-[18px] font-semibold tracking-[-0.01em] text-ink"
              id={titleId}
            >
              {title}
            </h2>
          </div>
          <button
            aria-label="关闭确认对话框"
            className="grid size-7 place-items-center text-muted hover:bg-paper hover:text-ink"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            <X aria-hidden className="size-4" strokeWidth={1.5} />
          </button>
        </header>

        <div className="px-5 py-4">
          <div className="text-[12px] leading-6 text-muted">{description}</div>
          {error ? (
            <p className="mt-3 border-l-2 border-danger pl-2 text-[11px] leading-5 text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-hairline px-5 py-3">
          <button
            className="h-8 border border-hairline px-4 text-[11px] font-medium text-ink hover:bg-paper disabled:opacity-40"
            disabled={busy}
            onClick={onCancel}
            ref={cancelRef}
            type="button"
          >
            {cancelLabel}
          </button>
          <button
            className={`h-8 px-4 text-[11px] font-medium text-paper disabled:opacity-40 ${
              warning ? 'bg-warning' : 'bg-danger'
            }`}
            disabled={busy || confirmDisabled}
            onClick={onConfirm}
            type="button"
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}
