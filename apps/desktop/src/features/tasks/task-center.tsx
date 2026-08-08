import { useEffect, useState } from 'react';
import type { AuditRecord, TaskEvent } from '@opspilot/contracts';

import type { CoreClient } from '../../api/core';

export function TasksPage({ core }: { core: CoreClient }) {
  const [tab, setTab] = useState<'tasks' | 'audit'>('tasks');
  const [tasks, setTasks] = useState<TaskEvent[]>([]);
  const [audits, setAudits] = useState<AuditRecord[]>([]);
  const [message, setMessage] = useState('');

  const refresh = async () => {
    try {
      const [nextTasks, nextAudits] = await Promise.all([
        core.tasks?.(200) ?? Promise.resolve([]), core.audits?.(200) ?? Promise.resolve([]),
      ]);
      setTasks(nextTasks); setAudits(nextAudits); setMessage('');
    } catch { setMessage('任务或审计记录读取失败'); }
  };
  useEffect(() => { void refresh(); }, [core]);

  return <div className="page-stack"><div className="page-heading"><div><p className="eyebrow">ACTIVITY & AUDIT</p><h1>任务与日志</h1><p>任务状态来自持久化事件；审计 payload 已在 Rust 写入前脱敏。</p></div><button onClick={() => void refresh()} type="button">刷新</button></div>
    <div className="segmented"><button className={tab === 'tasks' ? 'active' : ''} onClick={() => setTab('tasks')} type="button">任务中心</button><button className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')} type="button">审计日志</button></div>
    {message ? <div className="alert warning-alert" role="alert">{message}</div> : null}
    {tab === 'tasks' ? <section className="panel"><div className="table-wrap"><table aria-label="任务中心"><thead><tr><th>任务</th><th>状态</th><th>进度</th><th>当前步骤</th><th>错误</th><th>时间</th></tr></thead><tbody>{tasks.length === 0 ? <tr><td className="empty-cell" colSpan={6}>暂无任务</td></tr> : tasks.map((task) => <tr key={task.taskId}><td><code>{task.taskId}</code></td><td><span className="status-badge"><i />{task.status}</span></td><td><progress max={100} value={task.progress} /> {task.progress}%</td><td>{task.currentStep ?? '—'}</td><td>{task.errorCode ?? '—'}</td><td>{task.createdAt}</td></tr>)}</tbody></table></div></section> : <section className="panel"><div className="table-wrap"><table aria-label="审计日志"><thead><tr><th>动作</th><th>资源</th><th>结果</th><th>脱敏详情</th><th>时间</th></tr></thead><tbody>{audits.length === 0 ? <tr><td className="empty-cell" colSpan={5}>暂无审计记录</td></tr> : audits.map((audit) => <tr key={audit.id}><td><strong>{audit.action}</strong><small>{audit.serverId ?? 'local'}</small></td><td>{audit.resourceType}</td><td>{audit.result}</td><td><code>{JSON.stringify(audit.redactedPayload)}</code></td><td>{audit.createdAt}</td></tr>)}</tbody></table></div></section>}
  </div>;
}
