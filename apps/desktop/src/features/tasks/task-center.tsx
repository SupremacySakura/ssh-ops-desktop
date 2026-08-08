import { useEffect, useState } from 'react';
import type { AuditRecord, TaskEvent } from '@opspilot/contracts';

import type { CoreClient } from '../../api/core';
import { PageHeader, Panel, SectionHeader } from '../../app/ui/layout';

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

  return <div className="page-stack tasks-page"><PageHeader actions={<button onClick={() => void refresh()} type="button">刷新数据</button>} description="任务状态来自持久化事件；审计 payload 已在 Rust 写入前脱敏。" eyebrow="Activity & audit" title="任务与日志" />
    <div aria-label="日志类型" className="segmented" role="group"><button aria-pressed={tab === 'tasks'} className={tab === 'tasks' ? 'active' : ''} onClick={() => setTab('tasks')} type="button">任务中心</button><button aria-pressed={tab === 'audit'} className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')} type="button">审计日志</button></div>
    {message ? <div className="alert warning-alert" role="alert">{message}</div> : null}
    {tab === 'tasks' ? <Panel className="task-table-panel"><SectionHeader count={tasks.length} description="Core 持久化任务事件" title="任务中心" /><div className="table-wrap"><table aria-label="任务与日志"><thead><tr><th>任务</th><th>状态</th><th>进度</th><th>当前步骤</th><th>错误</th><th>时间</th></tr></thead><tbody>{tasks.length === 0 ? <tr><td className="empty-cell" colSpan={6}>暂无任务</td></tr> : tasks.map((task) => <tr key={task.taskId}><td><code>{task.taskId}</code></td><td><span className={`status-badge task-status-${task.status}`}><i />{task.status}</span></td><td><div className="task-progress"><progress aria-label={`${task.taskId} 进度`} max={100} value={task.progress} /><span>{task.progress}%</span></div></td><td>{task.currentStep ?? '—'}</td><td>{task.errorCode ?? '—'}</td><td>{task.createdAt}</td></tr>)}</tbody></table></div></Panel> : <Panel className="task-table-panel"><SectionHeader count={audits.length} description="敏感字段已由 Rust Core 脱敏" title="审计日志" /><div className="table-wrap"><table aria-label="审计日志"><thead><tr><th>动作</th><th>资源</th><th>结果</th><th>脱敏详情</th><th>时间</th></tr></thead><tbody>{audits.length === 0 ? <tr><td className="empty-cell" colSpan={5}>暂无审计记录</td></tr> : audits.map((audit) => <tr key={audit.id}><td><strong>{audit.action}</strong><small>{audit.serverId ?? 'local'}</small></td><td>{audit.resourceType}</td><td><span className={`status-badge task-status-${audit.result}`}><i />{audit.result}</span></td><td><code>{JSON.stringify(audit.redactedPayload)}</code></td><td>{audit.createdAt}</td></tr>)}</tbody></table></div></Panel>}
  </div>;
}
