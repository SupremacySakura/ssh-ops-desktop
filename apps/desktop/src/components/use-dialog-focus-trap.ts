import { useEffect, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface DialogFocusTrapOptions {
  active?: boolean;
  canEscape?: boolean;
  onEscape?(): void;
}

export function useDialogFocusTrap(
  sectionRef: RefObject<HTMLElement | null>,
  {
    active = true,
    canEscape = true,
    onEscape,
  }: DialogFocusTrapOptions,
) {
  useEffect(() => {
    const previousFocus = document.activeElement;
    return () => {
      if (
        previousFocus instanceof HTMLElement
        && previousFocus.isConnected
        && !sectionRef.current?.contains(previousFocus)
      ) {
        previousFocus.focus();
      }
    };
  }, [sectionRef]);

  useEffect(() => {
    if (!active) return;
    const section = sectionRef.current;
    if (!section) return;
    const dialog = section;
    if (!dialog.contains(document.activeElement)) dialog.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && canEscape && onEscape) {
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement as HTMLElement | null;
      const currentIndex = activeElement ? focusable.indexOf(activeElement) : -1;

      if (event.shiftKey) {
        if (currentIndex <= 0) {
          event.preventDefault();
          last.focus();
        }
      } else if (currentIndex === -1 || currentIndex === focusable.length - 1) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [active, canEscape, onEscape, sectionRef]);
}
