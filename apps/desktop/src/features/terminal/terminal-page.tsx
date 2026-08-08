import { useEffect, useMemo, useState } from 'react';
import type { ConnectionHandle, ServerSummary, TerminalSession } from '@opspilot/contracts';

import type { CoreClient } from '../../api/core';
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
  const [input, setInput] = useState('');
  const [pendingPaste, setPendingPaste] = useState('');
  const [message, setMessage] = useState('');
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
      setInput('');
      setPendingPaste('');
    } catch { setMessage('终端写入失败，输入没有自动重放'); }
  };

  const send = () => {
    if (requiresPasteConfirmation(input, false)) setPendingPaste(input); else void transmit(input);
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

  const reconnect = async () => {
    if (!active) return;
    const serverId = active.serverId;
    await close(active.id);
    setSelectedServerId(serverId);
    await open(serverId);
  };

  void revision;
  return <div className="page-stack">
    <div className="page-heading"><div><p className="eyebrow">SECURE SHELL</p><h1>远程终端</h1><p>每个标签独立接收有序字节流；断线后输入不会自动重放。</p></div><div className="heading-actions"><select aria-label="选择已连接服务器" onChange={(event) => setSelectedServerId(event.target.value)} value={selectedServerId}><option value="">选择服务器</option>{connections.map(({ server }) => <option key={server.id} value={server.id}>{server.name} · {environmentLabel(server.environment)}</option>)}</select><button className="primary" onClick={() => void open()} type="button">新建终端会话</button></div></div>
    {message ? <div className="alert success-alert" role="status">{message}</div> : null}
    <div className="terminal-shell"><div className="terminal-tabs">{sessions.length === 0 ? <span>尚无会话</span> : sessions.map((session) => <button className={session.id === activeId ? 'active' : ''} key={session.id} onClick={() => setActiveId(session.id)} type="button">{session.title}<span aria-hidden="true" onClick={(event) => { event.stopPropagation(); void close(session.id); }}> ×</span></button>)}</div>{active ? <><XtermViewport content={active.output} onInput={terminalInput} onResize={resize} sessionId={active.id} />{active.outputMayHaveGap ? <div className="terminal-gap" role="alert">输出可能缺段；已从后续序号继续，不会伪造缺失内容。</div> : null}<div className="terminal-input"><textarea aria-label="终端输入" onChange={(event) => setInput(event.target.value)} value={input} /><button disabled={!input} onClick={send} type="button">发送到终端</button><button onClick={() => void reconnect()} type="button">手动重连</button></div></> : <pre>请先从已建立可信连接的服务器创建会话。</pre>}</div>
    {pendingPaste ? <section aria-label="确认粘贴内容" aria-modal="true" className="risk-dialog" role="alertdialog"><h2>确认粘贴内容</h2><p>目标：{active?.title} · {pendingPaste.split(/\r?\n/u).length} 行 · {new TextEncoder().encode(pendingPaste).byteLength} 字节</p><pre className="paste-preview">{pendingPaste.slice(0, 4_096)}</pre><footer><button onClick={() => setPendingPaste('')} type="button">取消</button><button className="primary" onClick={() => void transmit(pendingPaste)} type="button">确认发送</button></footer></section> : null}
  </div>;
}

function requiresPasteConfirmation(value: string, allowSingleControl: boolean): boolean {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > 4_096) return true;
  if (allowSingleControl && value.length === 1) return false;
  return value.includes('\n') || value.includes('\r') || [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && code !== 9) || code === 127;
  });
}

function environmentLabel(environment: ServerSummary['environment']): string {
  return environment === 'production' ? '生产环境' : environment === 'staging' ? '预发布' : environment === 'development' ? '开发环境' : '其他';
}
