import { useEffect, useMemo, useState } from 'react';
import type { ConnectionHandle, ServerSummary, TerminalSession } from '@opspilot/contracts';

import type { CoreClient } from '../../api/core';
import { Modal } from '../../app/ui/modal';
import { PageHeader } from '../../app/ui/layout';
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
  const [input, setInput] = useState('');
  const [pendingPaste, setPendingPaste] = useState('');
  const [message, setMessage] = useState('');
  const sessions = store.list();
  const active = store.get(activeId);
  const activeConnection = connections.find((item) => item.server.id === (active?.serverId ?? selectedServerId));

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
  return <div className="page-stack terminal-page">
    <PageHeader
      actions={<><Select aria-label="选择已连接服务器" onChange={(value) => setSelectedServerId(value)} options={[{ value: '', label: '选择服务器' }, ...connections.map(({ server }) => ({ value: server.id, label: `${server.name} · ${environmentLabel(server.environment)}` }))]} value={selectedServerId} /><button className="primary" onClick={() => void open()} type="button">新建终端会话</button></>}
      description="每个标签独立接收有序字节流；断线后输入不会自动重放。"
      eyebrow="Secure shell"
      title="远程终端"
    />
    {message ? <div className="alert success-alert" role="status">{message}</div> : null}
    <div aria-label="终端连接摘要" className="terminal-connection-strip">
      <div><span className="status-dot" /><small>当前连接</small><strong>{activeConnection?.server.name ?? '未建立会话'}</strong></div>
      <div><small>主机</small><strong>{activeConnection ? `${activeConnection.server.host}:${activeConnection.server.port}` : '—'}</strong></div>
      <div><small>环境</small><strong>{activeConnection ? environmentLabel(activeConnection.server.environment) : '—'}</strong></div>
      <div><small>用户</small><strong>{activeConnection?.server.username ?? '—'}</strong></div>
      <div><small>会话</small><strong>{sessions.length}</strong></div>
    </div>
    <div className="terminal-workspace">
      <section className="terminal-primary" aria-label="终端工作区">
        <div className="terminal-shell"><div className="terminal-tabs">{sessions.length === 0 ? <span>尚无会话</span> : sessions.map((session) => <button className={session.id === activeId ? 'active' : ''} key={session.id} onClick={() => setActiveId(session.id)} type="button">{session.title}<span aria-hidden="true" onClick={(event) => { event.stopPropagation(); void close(session.id); }}> ×</span></button>)}</div>{active ? <><XtermViewport content={active.output} onInput={terminalInput} onResize={resize} sessionId={active.id} />{active.outputMayHaveGap ? <div className="terminal-gap" role="alert">输出可能缺段；已从后续序号继续，不会伪造缺失内容。</div> : null}<div className="terminal-input"><textarea aria-label="终端输入" onChange={(event) => setInput(event.target.value)} value={input} /><button disabled={!input} onClick={send} type="button">发送到终端</button><button onClick={() => void reconnect()} type="button">手动重连</button></div></> : <pre>请先从已建立可信连接的服务器创建会话。</pre>}</div>
      </section>
      <aside aria-label="终端 AI 助手" className="terminal-assistant ui-panel">
        <header><span className="assistant-mark">AI</span><div><h2>AI 运维助手</h2><p>基于当前连接上下文</p></div></header>
        <div className="assistant-context"><span>作用域</span><strong>{activeConnection?.server.name ?? '尚未选择服务器'}</strong><small>{activeConnection ? `${activeConnection.server.username}@${activeConnection.server.host}` : '建立可信连接后可使用 Agent'}</small></div>
        <div className="assistant-note"><strong>安全边界保持不变</strong><p>Agent 只调用 Rust Core 发布的工具。任何写操作仍会进入风险审批，不会直接注入终端。</p></div>
        <a className="assistant-link" href="#agent">前往 AI Agent 工作区</a>
      </aside>
    </div>
    <Modal onClose={() => setPendingPaste('')} open={!!pendingPaste}>
      <section aria-label="确认粘贴内容" aria-modal="true" className="risk-dialog" role="alertdialog">
        <h2>确认粘贴内容</h2>
        <p>目标：{active?.title} · {pendingPaste.split(/\r?\n/u).length} 行 · {new TextEncoder().encode(pendingPaste).byteLength} 字节</p>
        <pre className="paste-preview">{pendingPaste.slice(0, 4_096)}</pre>
        <footer>
          <button onClick={() => setPendingPaste('')} type="button">取消</button>
          <button className="primary" onClick={() => void transmit(pendingPaste)} type="button">确认发送</button>
        </footer>
      </section>
    </Modal>
  </div>;
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

// xterm 的方向键、Home/End、Delete、翻页等功能键会发出 CSI/SS3 转义序列（如 ↑ = "\x1b[A"），
// 它们是单个按键而非粘贴，不应触发粘贴确认。括号粘贴标记除外，以免绕过多行粘贴的安全确认；
// 排除必须同时覆盖带修饰符的变体（如 "\x1b[200;1~"），它们也属于粘贴标记而非功能键。
// eslint-disable-next-line no-control-regex -- 匹配 xterm 功能键的 ESC 转义序列是预期行为
const KEY_ESCAPE_SEQUENCE = /^\x1b(?:\[\d*(?:;\d+)?[~A-Za-z]|O[A-Za-z])$/u;
// eslint-disable-next-line no-control-regex -- 匹配括号粘贴标记（含 xterm 修改版粘贴的修饰符变体）是预期行为
const BRACKETED_PASTE_MARKER = /^\x1b\[20[01];?\d*~$/u;

function isKeyEscapeSequence(value: string): boolean {
  return !BRACKETED_PASTE_MARKER.test(value) && KEY_ESCAPE_SEQUENCE.test(value);
}

function environmentLabel(environment: ServerSummary['environment']): string {
  return environment === 'production' ? '生产环境' : environment === 'staging' ? '预发布' : environment === 'development' ? '开发环境' : '其他';
}
