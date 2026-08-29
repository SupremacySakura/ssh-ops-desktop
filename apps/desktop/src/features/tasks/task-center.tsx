import { useEffect, useState } from 'react';
import type { TaskEvent } from '@opspilot/contracts';

import type { CoreClient } from '../../api/core';
import { Icon, type IconName } from '../../app/icons';
import { PageHeader } from '../../app/ui/layout';

export function TasksPage({ core }: { core: CoreClient }) {
  const [tab, setTab] = useState<'running' | 'completed' | 'failed'>('running');
  const [tasks, setTasks] = useState<TaskEvent[]>([]);
  const [message, setMessage] = useState('');

  const refresh = async () => {
    try {
      const nextTasks = await (core.tasks?.(200) ?? Promise.resolve([]));
      setTasks(nextTasks);
      setMessage('');
    } catch { setMessage('任务记录读取失败'); }
  };

  useEffect(() => { void refresh(); }, [core]);

  const visible = tasks.filter((task) => {
    if (tab === 'running') return ['pending', 'running', 'rolling_back'].includes(task.status);
    if (tab === 'completed') return ['succeeded', 'rolled_back'].includes(task.status);
    return ['failed', 'rollback_failed', 'cancelled', 'interrupted'].includes(task.status);
  });

  const toneOf = (task: TaskEvent): 'success' | 'warning' | 'neutral' | 'error' => {
    if (task.status === 'succeeded' || task.status === 'rolled_back') return 'success';
    if (task.status === 'failed' || task.status === 'rollback_failed' || task.status === 'cancelled' || task.status === 'interrupted') return 'error';
    if (task.status === 'rolling_back') return 'warning';
    return 'neutral';
  };

  const labelOf = (task: TaskEvent): string => {
    if (task.status === 'succeeded') return '成功';
    if (task.status === 'failed' || task.status === 'rollback_failed') return '失败';
    if (task.status === 'cancelled' || task.status === 'interrupted') return '已取消';
    return `${task.progress}%`;
  };

  const iconOf = (task: TaskEvent): IconName => {
    if (task.status === 'succeeded' || task.status === 'rolled_back') return 'check';
    if (task.status === 'failed' || task.status === 'rollback_failed' || task.status === 'cancelled' || task.status === 'interrupted') return 'close';
    return 'activity';
  };

  const latest = tasks[0];

  return (
    <div className="page-stack tasks-page">
      <PageHeader
        actions={<button className="btn btn-secondary" onClick={() => void refresh()} type="button"><Icon name="download" size={15} />导出日志</button>}
        description="追踪异步任务与执行历史"
        title="任务与日志"
      />

      {message ? <div className="alert warning-alert" role="alert">{message}</div> : null}

      <div className="tabs">
        <button className={tab === 'running' ? 'tab active' : 'tab'} onClick={() => setTab('running')} type="button">运行中</button>
        <button className={tab === 'completed' ? 'tab active' : 'tab'} onClick={() => setTab('completed')} type="button">已完成</button>
        <button className={tab === 'failed' ? 'tab active' : 'tab'} onClick={() => setTab('failed')} type="button">失败</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">任务列表</h3>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            {visible.length === 0
              ? <div className="conversation-empty" style={{ padding: 16 }}>该分类下暂无任务</div>
              : visible.map((task) => (
                <div className="list-item" key={task.taskId}>
                  <div className="list-item-icon"><Icon name={iconOf(task)} size={18} /></div>
                  <div className="list-item-content">
                    <div className="list-item-title">{task.currentStep ?? task.taskId}</div>
                    <div className="list-item-meta">#{task.taskId.slice(0, 6)} · {task.createdAt}</div>
                  </div>
                  <span className={`status-tag ${toneOf(task)}`}>{labelOf(task)}</span>
                </div>
              ))}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">{latest ? `任务 #${latest.taskId.slice(0, 6)} 输出` : '任务输出'}</h3>
            {latest ? <span className={`status-tag ${toneOf(latest)}`}>{labelOf(latest)}</span> : null}
          </div>
          <div className="card-body log-view">
            <div style={{ padding: 16, minHeight: 280, fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap', color: 'var(--label-secondary)' }}>
              {latest
                ? [
                    `[${latest.createdAt}] 任务 ${latest.taskId} 状态：${latest.status}`,
                    latest.currentStep ? `[step] ${latest.currentStep}` : null,
                    latest.errorCode ? `[error] ${latest.errorCode}` : null,
                    `[progress] ${latest.progress}%`,
                  ].filter(Boolean).join('\n')
                : '暂无任务输出'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
