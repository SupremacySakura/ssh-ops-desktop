import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';

const LIGHT_TERMINAL_THEME = { background: '#16161A', foreground: '#F2F2F7' };
const DARK_TERMINAL_THEME = { background: '#0B0B0D', foreground: '#E8E8ED' };

function currentTerminalTheme() {
  return document.documentElement.dataset.theme === 'dark' ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME;
}

interface XtermViewportProps {
  content: string;
  onInput(value: string): void;
  onResize(columns: number, rows: number): void;
  sessionId: string;
}

export function XtermViewport({ content, onInput, onResize, sessionId }: XtermViewportProps) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const written = useRef('');
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  onInputRef.current = onInput;
  onResizeRef.current = onResize;

  useEffect(() => {
    const element = container.current;
    if (!element || typeof window.matchMedia !== 'function') return;
    const nextTerminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'SFMono-Regular, Consolas, monospace',
      fontSize: 13,
      scrollback: 10_000,
      theme: currentTerminalTheme(),
    });
    const fit = new FitAddon();
    nextTerminal.loadAddon(fit);
    nextTerminal.open(element);
    terminal.current = nextTerminal;
    written.current = '';
    const inputSubscription = nextTerminal.onData((value) => onInputRef.current(value));
    const fitAndReport = () => {
      try {
        fit.fit();
        if (nextTerminal.cols >= 2 && nextTerminal.rows >= 2) {
          onResizeRef.current(nextTerminal.cols, nextTerminal.rows);
        }
      } catch {
        // The containing WebView can briefly report zero geometry while switching tabs.
      }
    };
    fitAndReport();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(fitAndReport);
    observer?.observe(element);
    /* 跟随浅色/暗色主题 */
    const themeObserver = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(() => {
      if (nextTerminal.options) nextTerminal.options.theme = currentTerminalTheme();
    });
    themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      observer?.disconnect();
      themeObserver?.disconnect();
      inputSubscription.dispose();
      nextTerminal.dispose();
      terminal.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    const activeTerminal = terminal.current;
    if (!activeTerminal || content === written.current) return;
    if (content.startsWith(written.current)) {
      activeTerminal.write(content.slice(written.current.length));
    } else {
      activeTerminal.reset();
      activeTerminal.write(content);
    }
    written.current = content;
  }, [content]);

  return <div aria-label="终端输出" className="xterm-viewport" role="log">
    <div aria-hidden="true" className="xterm-host" ref={container} />
    <span className="sr-only">{content || '等待远端输出…'}</span>
  </div>;
}
