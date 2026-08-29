import { useEffect, useMemo, useState } from 'react';
import type { ConnectionHandle, ServerSummary, TerminalSession } from '@opspilot/contracts';

import type { CoreClient } from '../../api/core';
import { Modal } from '../../app/ui/modal';
import { Select } from '../../app/ui/select';
import { createTerminalSessionStore } from './session-store';
import { XtermViewport } from './xterm-viewport';

export interface ConnectedServer {
  server: ServerSummary;
  connection: ConnectionHandle;
}

export interface PendingTerminalSession {
  server: ServerSummary;
  session: TerminalSession;
}

export function TerminalPage({ connections, core, onPendingSessionClaimed, pendingSession }: {
  connections: ConnectedServer[];
  core: CoreClient;
  onPendingSessionClaimed?(): void;
  pendingSession?: PendingTerminalSession;
}) {
  const store = useMemo(createTerminalSessionStore, []);
  const [revision, setRevision] = useState(0);
  const [activeId, setActiveId] = useState('');
  const [selectedServerId, setSelectedServerId] = useState(connections[0]?.server.id ?? '');
  const [pendingPaste, setPendingPaste] = useState('');
  const [message, setMessage] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const sessions = store.list();
  const active = store.get(activeId);

  useEffect(() => {
    if (!selectedServerId && connections[0]) setSelectedServerId(connections[0].server.id);
  }, [connections, selectedServerId]);

  useEffect(() => {
    if (!pendingSession || store.get(pendingSession.session.id)) return;
    store.open(pendingSession.session.id, pendingSession.server.id, `${pendingSession.server.name} · Docker Exec`);
    setActiveId(pendingSession.session.id);
    setSelectedServerId(pendingSession.server.id);
    setRevision((value) => value + 1);
    setMessage(`已连接 · ${pendingSession.server.name} · Docker Exec`);
    onPendingSessionClaimed?.();
  }, [onPendingSessionClaimed, pendingSession, store]);

  useEffect(() => {
    let stopData: (() => void) | undefined;
    let stopGap: (() => void) | undefined;
    let activeSubscription = true;
    void core.subscribeTerminalData?.((event) => {
      if (!activeSubscription) return;
      if (store.accept(event) !== 'unknown') setRevision((value) => value + 1);
    }).then((stop) => { if (activeSubscription) stopData = stop; else stop(); });
    void core.subscribeTerminalGap?.(() => {
      if (!activeSubscription) return;
      store.markAllGapped();
      setRevision((value) => value + 1);
    }).then((stop) => { if (activeSubscription) stopGap = stop; else stop(); });
    return () => { activeSubscription = false; stopData?.(); stopGap?.(); };
  }, [core, store]);

  const open = async (targetServerId = selectedServerId) => {
    const connected = connections.find((item) => item.server.id === targetServerId);
    if (!connected || !core.openTerminal) { setMessage('请先在服务器页面建立可信连接'); return; }
    try {
      const session = await core.openTerminal(connected.connection, 120, 32);
      store.open(session.id, connected.server.id, connected.server.name);
      setActiveId(session.id);
      setRevision((value) => value + 1);
      setMessage(`已连接 · ${connected.server.name}`);
    } catch { setMessage('终端会话创建失败'); }
  };

  const transmit = async (value: string) => {
    if (!active || !core.writeTerminal) return;
    try {
      await core.writeTerminal(active.id, [...new TextEncoder().encode(value)]);
      setPendingPaste('');
    } catch { setMessage('终端写入失败，输入没有自动重放'); }
  };

  const terminalInput = (value: string) => {
    if (requiresPasteConfirmation(value, true)) setPendingPaste(value);
    else void transmit(value);
  };

  const resize = (columns: number, rows: number) => {
    if (!active || !core.resizeTerminal) return;
    void core.resizeTerminal(active.id, columns, rows).catch(() => {
      setMessage('终端尺寸同步失败；会话仍保持连接');
    });
  };

  const close = async (sessionId: string) => {
    try { await core.closeTerminal?.(sessionId); } finally {
      store.close(sessionId);
      const next = store.list()[0]?.id ?? '';
      setActiveId(next);
      setRevision((value) => value + 1);
    }
  };

  void revision;
  return (
    <div className={fullscreen ? 'terminal-page fullscreen' : 'terminal-page'}>
      <div className="page-header">
        <div>
          <h1>终端</h1>
          <p>安全的 SSH 会话管理</p>
        </div>
        <div className="page-actions">
          <div style={{ width: 200 }}>
            <Select
              aria-label="选择服务器"
              onChange={(value) => setSelectedServerId(value)}
              options={connections.map(({ server }) => ({ value: server.id, label: server.name }))}
              placeholder={connections.length === 0 ? '选择服务器' : '请选择服务器'}
              value={selectedServerId}
            />
          </div>
          <button className="btn btn-primary" onClick={() => void open()} type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
            <span>新建会话</span>
          </button>
        </div>
      </div>

      {message ? <div className="alert success-alert" role="status" style={{ marginBottom: 16 }}>{message}</div> : null}

      <div className="tabs" style={{ marginBottom: 20 }}>
        {sessions.length === 0
          ? <span className="tab" style={{ background: 'transparent', color: 'var(--label-secondary)' }}>尚无会话</span>
          : sessions.map((session) => (
            <button
              aria-label={`会话 ${session.title}`}
              className={session.id === activeId ? 'tab active' : 'tab'}
              key={session.id}
              onClick={() => setActiveId(session.id)}
              type="button"
            >
              {session.title}
              <span
                aria-label={`关闭 ${session.title}`}
                onClick={(event) => { event.stopPropagation(); void close(session.id); }}
                style={{ marginLeft: 6, opacity: 0.7 }}
              >×</span>
            </button>
          ))}
        <button className="tab" onClick={() => void open()} title="新建会话" type="button">+</button>
      </div>

      <div className="terminal">
        {active ? (
          <XtermViewport content={active.output} onInput={terminalInput} onResize={resize} sessionId={active.id} />
        ) : (
          <pre style={{ margin: 0, color: 'var(--terminal-dim)' }}>请先从已建立可信连接的服务器创建会话。</pre>
        )}
      </div>

      <div style={{ marginTop: 12, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button className="btn btn-secondary" disabled={!active} onClick={() => { if (active) void close(active.id); }} type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
          <span>断开</span>
        </button>
        <button className="btn btn-secondary" onClick={() => setFullscreen((value) => !value)} type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M8 12h8M12 8v8" /></svg>
          <span>{fullscreen ? '退出全屏' : '全屏'}</span>
        </button>
      </div>

      <Modal onClose={() => setPendingPaste('')} open={!!pendingPaste}>
        <section aria-label="确认粘贴内容" aria-modal="true" className="risk-dialog" role="alertdialog">
          <h2>确认粘贴内容</h2>
          <p>目标：{active?.title} · {pendingPaste.split(/\r?\n/u).length} 行 · {new TextEncoder().encode(pendingPaste).byteLength} 字节</p>
          <pre className="paste-preview">{pendingPaste.slice(0, 4_096)}</pre>
          <footer>
            <button className="btn btn-secondary" onClick={() => setPendingPaste('')} type="button">取消</button>
            <button className="btn btn-primary" onClick={() => void transmit(pendingPaste)} type="button">确认发送</button>
          </footer>
        </section>
      </Modal>
    </div>
  );
}

function requiresPasteConfirmation(value: string, allowSingleControl: boolean): boolean {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > 4_096) return true;
  if (allowSingleControl && (value.length === 1 || isKeyEscapeSequence(value))) return false;
  return value.includes('\n') || value.includes('\r') || [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && code !== 9) || code === 127;
  });
}

// eslint-disable-next-line no-control-regex -- 匹配 xterm 功能键的 ESC 转义序列是预期行为
const KEY_ESCAPE_SEQUENCE = /^\x1b(?:\[\d*(?:;\d+)?[~A-Za-z]|O[A-Za-z])$/u;
// eslint-disable-next-line no-control-regex -- 匹配括号粘贴标记是预期行为
const BRACKETED_PASTE_MARKER = /^\x1b\[20[01];?\d*~$/u;

function isKeyEscapeSequence(value: string): boolean {
  return !BRACKETED_PASTE_MARKER.test(value) && KEY_ESCAPE_SEQUENCE.test(value);
}
