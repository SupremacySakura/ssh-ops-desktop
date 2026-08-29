import type { HTMLAttributes, ReactNode } from 'react';

import { Icon, type IconName } from '../icons';

export interface PageHeaderProps {
  actions?: ReactNode;
  description: string;
  eyebrow?: string;
  title: string;
}

export function PageHeader({ actions, description, eyebrow, title }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <p className="ui-eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        <p className="ui-page-description">{description}</p>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export interface PanelProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
}

export function Panel({ children, className = '', ...props }: PanelProps) {
  return <section className={`ui-panel ${className}`.trim()} {...props}>{children}</section>;
}

export function SectionHeader({ actions, count, description, title }: {
  actions?: ReactNode;
  count?: number;
  description?: string;
  title: string;
}) {
  return (
    <header className="ui-section-header">
      <div><h2>{title}</h2>{description ? <p>{description}</p> : null}</div>
      <div className="ui-section-actions">{typeof count === 'number' ? <span className="ui-count-badge">{count}</span> : null}{actions}</div>
    </header>
  );
}

export interface MetricCardProps {
  detail: string;
  icon: IconName;
  label: string;
  tone?: 'primary' | 'success' | 'warning' | 'danger' | 'ai';
  value: ReactNode;
}

export function MetricCard({ detail, icon, label, tone = 'primary', value }: MetricCardProps) {
  return (
    <article className={`ui-metric-card tone-${tone}`}>
      <span className="ui-metric-icon"><Icon name={icon} /></span>
      <div className="ui-metric-copy"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
    </article>
  );
}

export function FilterBar({ children, resultCount }: { children: ReactNode; resultCount?: number }) {
  return (
    <div aria-label="筛选条件" className="ui-filter-bar" role="search">
      {children}
      {typeof resultCount === 'number' ? <span className="ui-filter-count">共 {resultCount} 项</span> : null}
    </div>
  );
}

export interface DetailPaneProps {
  ariaLabel?: string;
  children: ReactNode;
  onClose(): void;
  subtitle?: string;
  title: string;
}

export function DetailPane({ ariaLabel, children, onClose, subtitle, title }: DetailPaneProps) {
  return (
    <aside aria-label={ariaLabel ?? `${title} 详情`} className="ui-detail-pane">
      <header>
        <div><h2>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</div>
        <button aria-label={`关闭 ${title} 详情`} className="ui-icon-button" onClick={onClose} type="button"><Icon name="close" /></button>
      </header>
      <div className="ui-detail-content">{children}</div>
    </aside>
  );
}

export interface ProgressBarProps {
  detail?: string;
  label: string;
  value: number;
}

export function ProgressBar({ detail, label, value }: ProgressBarProps) {
  const safeValue = Math.min(100, Math.max(0, value));
  return (
    <div className="ui-progress-row">
      <div><span>{label}</span><strong>{detail ?? `${safeValue}%`}</strong></div>
      <div aria-label={label} aria-valuemax={100} aria-valuemin={0} aria-valuenow={safeValue} className="ui-progress" role="progressbar"><i style={{ width: `${safeValue}%` }} /></div>
    </div>
  );
}

export function EmptyState({ action, description, icon = 'activity', title }: {
  action?: ReactNode;
  description: string;
  icon?: IconName;
  title: string;
}) {
  return (
    <div className="ui-empty-state">
      <span><Icon name={icon} size={24} /></span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}