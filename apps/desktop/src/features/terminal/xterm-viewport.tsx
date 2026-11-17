import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';

import { subscribeTerminalOutput } from '../../store/terminal-store';
import type { TerminalSessionView } from '../../store/terminal-store';
import {
  commandAppearsInTerminalEcho,
  trackExecutedCommands,
} from './command-tracking';
import {
  exceedsTerminalPasteLimit,
  inspectTerminalPaste,
} from './paste-guard';

export type PasteOutcome =
  | { kind: 'pasted' }
  | { kind: 'empty' }
  | { kind: 'too-large'; bytes: number }
  | { kind: 'confirmation-cancelled' }
  | { kind: 'unavailable' };

export interface TerminalActions {
  copy(): Promise<boolean>;
  paste(): Promise<PasteOutcome>;
  insertCommand(command: string): void;
  focus(): void;
}

interface XtermViewportProps {
  active: boolean;
  onCommand(command: string): void;
  onInput(bytes: Uint8Array): void;
  onOpenHistory(): void;
  onRegisterActions(sessionId: string, actions: TerminalActions | null): void;
  onResize(columns: number, rows: number): void;
  session: TerminalSessionView;
}

export function XtermViewport({
  active,
  onCommand,
  onInput,
  onOpenHistory,
  onRegisterActions,
  onResize,
  session,
}: XtermViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onCommandRef = useRef(onCommand);
  const onInputRef = useRef(onInput);
  const onOpenHistoryRef = useRef(onOpenHistory);
  const onRegisterActionsRef = useRef(onRegisterActions);
  const onResizeRef = useRef(onResize);
  const statusRef = useRef(session.status);
  onCommandRef.current = onCommand;
  onInputRef.current = onInput;
  onOpenHistoryRef.current = onOpenHistory;
  onRegisterActionsRef.current = onRegisterActions;
  onResizeRef.current = onResize;
  statusRef.current = session.status;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      allowTransparency: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: '"IBM Plex Mono", "SFMono-Regular", monospace',
      fontSize: 13,
      lineHeight: 1.35,
      scrollback: 10_000,
      theme: {
        background: '#141311',
        foreground: '#EDEAE2',
        cursor: '#E85D04',
        cursorAccent: '#141311',
        selectionBackground: '#5A2B0C',
        black: '#141311',
        red: '#C96A5A',
        green: '#7FA184',
        yellow: '#C9A25A',
        blue: '#7D98B2',
        magenta: '#B28CA3',
        cyan: '#7FA6A1',
        white: '#EDEAE2',
        brightBlack: '#6F6B62',
        brightRed: '#DF826E',
        brightGreen: '#9CB89F',
        brightYellow: '#DDB978',
        brightBlue: '#9CB3CA',
        brightMagenta: '#C7A6B7',
        brightCyan: '#9DBFBA',
        brightWhite: '#FAF9F6',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;
    const lineState = { current: '', inEscape: false };
    let draftBaseline: string | null = null;
    let lastSize = { columns: 0, rows: 0 };

    const sendTracked = (text: string) => {
      const hadDraft = lineState.current.length > 0;
      const baseline = hadDraft ? draftBaseline : currentVisibleLine(terminal);
      const commands = trackExecutedCommands(text, lineState);
      if (!hadDraft && lineState.current.length > 0) draftBaseline = baseline;
      const currentLine = currentVisibleLine(terminal);
      if (statusRef.current === 'open' && baseline !== null) {
        for (const command of commands) {
          if (commandAppearsInTerminalEcho(baseline, currentLine, command)) {
            onCommandRef.current(command);
          }
        }
      }
      if (lineState.current.length === 0) draftBaseline = null;
      onInputRef.current(new TextEncoder().encode(text));
    };
    const fitAndReport = () => {
      if (!terminal.element || terminal.element.offsetWidth === 0) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (
        terminal.cols >= 2
        && terminal.rows >= 2
        && (
          terminal.cols !== lastSize.columns
          || terminal.rows !== lastSize.rows
        )
      ) {
        lastSize = { columns: terminal.cols, rows: terminal.rows };
        onResizeRef.current(terminal.cols, terminal.rows);
      }
    };
    const copy = async () => {
      const selection = terminal.getSelection();
      if (!selection) return false;
      return writeClipboardText(selection);
    };
    const pasteText = (text: string): PasteOutcome => {
      if (statusRef.current !== 'open') return { kind: 'unavailable' };
      if (text.length === 0) return { kind: 'empty' };

      const inspection = inspectTerminalPaste(text);
      if (exceedsTerminalPasteLimit(text)) {
        return {
          kind: 'too-large',
          bytes: inspection.bytes,
        };
      }
      if (
        inspection.requiresConfirmation
        && !window.confirm(
          `剪贴板内容包含 ${inspection.lines} 行或控制字符（${inspection.bytes} 字节），`
          + '粘贴到远程终端后可能立即执行。仍要发送吗？',
        )
      ) {
        return { kind: 'confirmation-cancelled' };
      }
      terminal.paste(text);
      terminal.focus();
      return { kind: 'pasted' };
    };
    const paste = async (): Promise<PasteOutcome> => {
      if (statusRef.current !== 'open') return { kind: 'unavailable' };
      const text = await readClipboardText();
      return text === null ? { kind: 'unavailable' } : pasteText(text);
    };
    const insertCommand = (command: string) => {
      if (statusRef.current !== 'open') return;
      if (lineState.current.length === 0) draftBaseline = currentVisibleLine(terminal);
      lineState.current += command;
      onInputRef.current(new TextEncoder().encode(command));
      terminal.focus();
    };
    const handleNativePaste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const text = event.clipboardData?.getData('text/plain');
      if (text !== undefined) pasteText(text);
    };
    terminal.element?.addEventListener('paste', handleNativePaste, {
      capture: true,
    });

    const input = terminal.onData((value) => {
      if (value === '\u0012') return;
      if (statusRef.current !== 'open') return;
      sendTracked(value);
    });
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const commandKey = event.metaKey || event.ctrlKey;
      if (!commandKey) return true;
      const key = event.key.toLocaleLowerCase('en-US');
      if (key === 'r') {
        event.preventDefault();
        onOpenHistoryRef.current();
        return false;
      }
      if (key === 'c' && (event.metaKey || event.shiftKey) && terminal.hasSelection()) {
        event.preventDefault();
        void copy();
        return false;
      }
      if (key === 'v') {
        event.preventDefault();
        void paste();
        return false;
      }
      return true;
    });
    const unsubscribeOutput = subscribeTerminalOutput(session.id, (bytes) => {
      terminal.write(bytes);
    });
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => fitAndReport());
    resizeObserver?.observe(host);
    onRegisterActionsRef.current(session.id, {
      copy,
      paste,
      insertCommand,
      focus: () => terminal.focus(),
    });
    requestAnimationFrame(fitAndReport);

    return () => {
      onRegisterActionsRef.current(session.id, null);
      terminal.element?.removeEventListener('paste', handleNativePaste, {
        capture: true,
      });
      resizeObserver?.disconnect();
      unsubscribeOutput();
      input.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [session.id]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const terminal = terminalRef.current;
      const fit = fitRef.current;
      if (!terminal || !fit) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (terminal.cols >= 2 && terminal.rows >= 2) {
        onResizeRef.current(terminal.cols, terminal.rows);
      }
      terminal.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return (
    <div
      aria-label={session.title}
      className="harbor-xterm absolute inset-0 bg-screen"
      role="log"
    >
      <div className="h-full w-full px-4 py-3" ref={hostRef} />
    </div>
  );
}

async function writeClipboardText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  }
}

async function readClipboardText(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

function currentVisibleLine(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  return buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? '';
}
