import type { MonitorProcess, MonitorUnavailable } from '@opspilot/contracts';
import { ArrowDown, RotateCw, WifiOff } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import {
  buildMonitorChartSegments,
  diskPercent,
  isMonitorSnapshotStale,
  memoryPercent,
  sortMonitorProcesses,
  useMonitorStore,
  type MonitorPoint,
  type MonitorProcessSort,
  type MonitorViewState,
} from '../../store/monitor-store';
import {
  useTerminalStore,
  type ServerConnectionStatus,
} from '../../store/terminal-store';

interface MonitorPanelProps {
  connectionId: string | null;
  connectionStatus: ServerConnectionStatus;
  serverId: string;
}

export function MonitorPanel({
  connectionId,
  connectionStatus,
  serverId,
}: MonitorPanelProps) {
  const state = useMonitorStore((store) => store.states[serverId]);
  const retrySampling = useMonitorStore((store) => store.retrySampling);
  const retryServer = useTerminalStore((store) => store.retryServer);
  const [sort, setSort] = useState<MonitorProcessSort>('cpu');
  const titleId = useId();
  const current = state?.connectionId === connectionId ? state : null;
  const latest = current?.latest ?? null;
  const samples = state?.samples ?? [];
  const unavailable = state?.unavailable ?? [];
  const processes = sortMonitorProcesses(latest?.topProcesses ?? [], sort);
  const cpuValue = latest?.cpuPercent ?? null;
  const memValue = latest ? memoryPercent(latest) : null;
  const rootDiskValue = latest ? diskPercent(latest) : null;
  const offline = connectionStatus === 'closed'
    || connectionStatus === 'error'
    || connectionStatus === 'blocked'
    || current?.phase === 'offline';
  const failed = current?.phase === 'error';
  const retrying = current?.inFlight === true;
  const warming = latest !== null && unavailable.includes('cpu_warming_up');
  const snapshotStale = useMonitorStale(current?.lastUpdatedAt ?? null);
  const stale = latest !== null && snapshotStale;
  const partialFailures = unavailable.filter(
    (code) => code !== 'cpu_warming_up' && code !== 'processes_partial',
  );

  return (
    <section
      aria-labelledby={titleId}
      className="min-h-0 flex-1 overflow-y-auto bg-shell px-6 py-5"
    >
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-hairline pb-4">
        <div>
          <p className="font-mono text-[9px] tracking-[0.18em] text-accent">
            MONITORING / LIVE SNAPSHOT
          </p>
          <h2
            className="mt-1.5 text-[20px] font-semibold tracking-[-0.01em] text-ink"
            id={titleId}
          >
            系统监控
          </h2>
          <p className="mt-1 text-[11px] text-muted">
            每 2 秒完成一次采样，最近 5 分钟仅保存在本机内存中。
          </p>
        </div>
        <div className="text-right font-mono text-[9px] leading-5 text-muted">
          <p>
            {stale
              ? 'STALE / 快照已过期'
              : samplingStatusLabel(current, connectionStatus)}
          </p>
          <p>
            {latest
              ? `最近采样 ${formatClock(latest.timestamp)}`
              : '尚未收到当前快照'}
          </p>
        </div>
      </header>

      {partialFailures.length > 0 ? (
        <p
          className="mt-4 border border-warning/50 bg-[#F5EEE2] px-3 py-2 text-[10px] leading-4 text-warning"
          role="status"
        >
          部分指标不可用：{partialFailures.map(unavailableLabel).join('、')}。其余指标仍按当前快照展示。
        </p>
      ) : null}

      {offline ? (
        <div
          className="mt-4 flex items-center gap-3 border border-danger/40 bg-[#F4E9E5] px-3 py-2.5"
          role="alert"
        >
          <WifiOff aria-hidden className="size-4 shrink-0 text-danger" strokeWidth={1.5} />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium text-danger">服务器离线，监控已暂停</p>
            <p className="mt-0.5 text-[10px] leading-4 text-muted">
              不会继续展示旧值；重新连接后会从“正在采样”重新开始。
            </p>
          </div>
          <button
            className="h-7 shrink-0 border border-danger px-2.5 text-[10px] font-medium text-danger hover:bg-paper"
            onClick={() => void retryServer(serverId)}
            type="button"
          >
            重新连接
          </button>
        </div>
      ) : null}

      {failed && !offline ? (
        <div
          className="mt-4 flex items-center gap-3 border border-warning/50 bg-[#F5EEE2] px-3 py-2.5"
          role="alert"
        >
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium text-warning">监控采集失败</p>
            <p className="mt-0.5 text-[10px] leading-4 text-muted">
              {current?.error ?? '请稍后重试。'}
            </p>
          </div>
          <button
            className="inline-flex h-7 shrink-0 items-center gap-1.5 border border-warning px-2.5 text-[10px] font-medium text-warning hover:bg-paper disabled:opacity-40"
            disabled={retrying}
            onClick={() => retrySampling(serverId)}
            type="button"
          >
            <RotateCw aria-hidden className="size-3" strokeWidth={1.5} />
            立即重试
          </button>
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-px border border-hairline bg-hairline xl:grid-cols-5">
        <MonitorCard
          chartField="cpuPercent"
          detail={latest?.cpuPercent === undefined
            ? warming
              ? '首次采样已完成，等待下一轮计算'
              : unavailable.includes('cpu')
                ? 'CPU 采集失败'
                : '等待采样'
            : '所有 CPU 核心汇总'}
          label="CPU"
          samples={samples}
          title="CPU 概览"
          unavailable={unavailable.includes('cpu')}
          value={warming ? '正在采样' : formatPercent(cpuValue)}
        />
        <MonitorCard
          chartField="memoryPercent"
          detail={latest?.memory
            ? `${formatBytes(latest.memory.usedBytes)} / ${formatBytes(latest.memory.totalBytes)}`
            : unavailable.includes('memory')
              ? '内存采集失败'
              : '等待采样'}
          label="MEMORY"
          samples={samples}
          title="内存概览"
          unavailable={unavailable.includes('memory')}
          value={formatPercent(memValue)}
        />
        <MonitorCard
          detail={latest?.disk
            ? `${formatBytes(latest.disk.usedBytes)} / ${formatBytes(latest.disk.totalBytes)}`
            : unavailable.includes('disk')
              ? '根文件系统采集失败'
              : '等待采样'}
          label="ROOT DISK"
          samples={samples}
          title="磁盘概览"
          unavailable={unavailable.includes('disk')}
          value={formatPercent(rootDiskValue)}
        />
        <MonitorCard
          detail={latest?.load
            ? `5m ${latest.load.five.toFixed(2)} · 15m ${latest.load.fifteen.toFixed(2)}`
            : unavailable.includes('load')
              ? '负载采集失败'
              : '等待采样'}
          label="LOAD 1M"
          samples={samples}
          title="负载概览"
          unavailable={unavailable.includes('load')}
          value={latest?.load ? latest.load.one.toFixed(2) : '—'}
        />
        <MonitorCard
          detail={latest?.uptimeSeconds !== undefined
            ? '自上次系统启动'
            : unavailable.includes('uptime')
              ? '运行时间采集失败'
              : '等待采样'}
          label="UPTIME"
          samples={samples}
          title="运行时间概览"
          unavailable={unavailable.includes('uptime')}
          value={latest?.uptimeSeconds !== undefined
            ? formatUptime(latest.uptimeSeconds)
            : '—'}
        />
      </div>

      <section className="mt-4 border border-hairline bg-paper">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-4 py-3">
          <div>
            <p className="font-mono text-[9px] tracking-[0.14em] text-muted">
              PROCESSES / TOP 10 UNION
            </p>
            <h3 className="mt-1 text-[14px] font-semibold text-ink">Top 10 进程</h3>
          </div>
          <div className="flex items-stretch border border-hairline text-[10px]">
            <button
              aria-label="按 CPU 排序"
              aria-pressed={sort === 'cpu'}
              className={`inline-flex h-7 items-center gap-1.5 px-2.5 ${
                sort === 'cpu' ? 'bg-ink text-paper' : 'text-muted hover:bg-shell'
              }`}
              onClick={() => setSort('cpu')}
              type="button"
            >
              CPU
              {sort === 'cpu' ? <ArrowDown aria-hidden className="size-3" strokeWidth={1.5} /> : null}
            </button>
            <button
              aria-label="按内存排序"
              aria-pressed={sort === 'memory'}
              className={`inline-flex h-7 items-center gap-1.5 border-l border-hairline px-2.5 ${
                sort === 'memory' ? 'bg-ink text-paper' : 'text-muted hover:bg-shell'
              }`}
              onClick={() => setSort('memory')}
              type="button"
            >
              内存
              {sort === 'memory' ? <ArrowDown aria-hidden className="size-3" strokeWidth={1.5} /> : null}
            </button>
          </div>
        </header>
        {unavailable.includes('processes_partial') ? (
          <p className="border-b border-hairline px-4 py-2 font-mono text-[9px] text-warning">
            部分进程记录无法解析，已跳过坏行。
          </p>
        ) : null}
        {processes.length > 0 ? (
          <ProcessTable processes={processes} sort={sort} />
        ) : (
          <div className="flex min-h-28 flex-col items-start justify-center px-4 py-5">
            <p className="text-[12px] font-medium text-ink">
              {unavailable.includes('processes')
                ? '进程采集失败'
                : '当前没有可显示的进程'}
            </p>
            <p className="mt-1 text-[10px] leading-4 text-muted">
              {unavailable.includes('processes')
                ? 'ps 命令不可用或输出无效，其他指标不受影响。'
                : '服务器返回了空进程列表；可立即重新采样。'}
            </p>
            <button
              className="mt-3 inline-flex h-7 items-center gap-1.5 border border-hairline px-2.5 text-[10px] font-medium text-ink hover:border-ink disabled:opacity-40"
              disabled={retrying || offline}
              onClick={() => retrySampling(serverId)}
              type="button"
            >
              <RotateCw aria-hidden className="size-3" strokeWidth={1.5} />
              重新采样
            </button>
          </div>
        )}
      </section>
    </section>
  );
}

export function MonitorTopbarGauges({
  connectionId,
  serverId,
}: {
  connectionId: string | null;
  serverId: string;
}) {
  const state = useMonitorStore((store) => store.states[serverId]);
  const current = state?.connectionId === connectionId ? state : null;
  const latest = current?.latest ?? null;
  const snapshotStale = useMonitorStale(current?.lastUpdatedAt ?? null);
  const stale = latest !== null && snapshotStale;
  const liveLatest = stale ? null : latest;
  const cpuValue = liveLatest?.cpuPercent ?? null;
  const memValue = liveLatest ? memoryPercent(liveLatest) : null;
  const diskValue = liveLatest ? diskPercent(liveLatest) : null;
  const warming = latest !== null
    && (current?.unavailable.includes('cpu_warming_up') ?? false);

  return (
    <div
      aria-label="服务器实时监控"
      className="hidden items-start gap-4 lg:flex"
      role="group"
      title={stale ? '最近一份快照已过期，正在等待新的采样结果' : undefined}
    >
      <TopbarGauge
        ariaLabel="CPU 使用率"
        label="CPU"
        value={cpuValue}
        valueLabel={stale ? '过期' : warming ? '采样中' : formatPercent(cpuValue)}
      />
      <TopbarGauge
        ariaLabel="内存使用率"
        label="MEM"
        value={memValue}
        valueLabel={stale ? '过期' : formatPercent(memValue)}
      />
      <TopbarGauge
        ariaLabel="磁盘使用率"
        label="DISK"
        value={diskValue}
        valueLabel={stale ? '过期' : formatPercent(diskValue)}
      />
    </div>
  );
}

function useMonitorStale(lastUpdatedAt: number | null): boolean {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (lastUpdatedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [lastUpdatedAt]);

  return isMonitorSnapshotStale(lastUpdatedAt, now);
}

function MonitorCard({
  chartField,
  detail,
  label,
  samples,
  title,
  unavailable,
  value,
}: {
  chartField?: 'cpuPercent' | 'memoryPercent';
  detail: string;
  label: string;
  samples: MonitorPoint[];
  title: string;
  unavailable: boolean;
  value: string;
}) {
  return (
    <section
      aria-label={title}
      className="min-h-[158px] bg-paper px-3.5 py-3"
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[9px] tracking-[0.15em] text-muted">{label}</p>
        <span
          aria-hidden
          className={`size-1.5 ${unavailable ? 'bg-danger' : 'bg-accent'}`}
        />
      </div>
      <p className="mt-1.5 truncate font-mono text-[20px] font-medium tracking-[-0.02em] text-ink">
        {value}
      </p>
      <CalibrationScale
        value={value.endsWith('%') ? Number.parseFloat(value) : null}
      />
      {chartField ? (
        <MonitorSparkline
          field={chartField}
          label={title}
          points={samples}
        />
      ) : null}
      <p className="mt-2 line-clamp-2 font-mono text-[9px] leading-4 text-muted">
        {detail}
      </p>
    </section>
  );
}

function CalibrationScale({ value }: { value: number | null }) {
  return (
    <div className="relative mt-2 h-4 border-b border-ink" aria-hidden>
      <div className="absolute inset-x-0 bottom-0 flex h-[5px] items-end justify-between">
        {Array.from({ length: 21 }, (_, index) => (
          <span
            className={`w-px bg-ink ${index % 5 === 0 ? 'h-[5px]' : 'h-[3px]'}`}
            key={index}
          />
        ))}
      </div>
      {value !== null && Number.isFinite(value) ? (
        <span
          className="absolute bottom-0 h-4 w-0.5 -translate-x-1/2 bg-accent"
          style={{ left: `${Math.min(100, Math.max(0, value))}%` }}
        />
      ) : null}
    </div>
  );
}

function MonitorSparkline({
  field,
  label,
  points,
}: {
  field: 'cpuPercent' | 'memoryPercent';
  label: string;
  points: MonitorPoint[];
}) {
  const segments = buildMonitorChartSegments(points, field, 300, 56);
  return (
    <div className="mt-2 border border-hairline bg-shell/50">
      {segments.length > 0 ? (
        <svg
          aria-label={`${label}近 5 分钟趋势`}
          className="h-14 w-full"
          preserveAspectRatio="none"
          role="img"
          viewBox="0 0 300 56"
        >
          {[0, 28, 56].map((y) => (
            <line
              key={y}
              stroke="var(--color-hairline)"
              strokeWidth="0.75"
              x1="0"
              x2="300"
              y1={y}
              y2={y}
            />
          ))}
          {segments.map((path, index) => (
            <path
              d={path}
              fill="none"
              key={index}
              stroke="var(--color-accent)"
              strokeWidth="1.25"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      ) : (
        <div className="grid h-14 place-items-center font-mono text-[8px] tracking-[0.08em] text-muted">
          暂无趋势
        </div>
      )}
    </div>
  );
}

function TopbarGauge({
  ariaLabel,
  label,
  value,
  valueLabel,
}: {
  ariaLabel: string;
  label: string;
  value: number | null;
  valueLabel: string;
}) {
  return (
    <div aria-label={ariaLabel} className="w-[82px]">
      <div className="flex items-baseline justify-between gap-1">
        <span className="text-[9px] tracking-[0.14em] text-muted">{label}</span>
        <span className="font-mono text-[10px] text-ink">{valueLabel}</span>
      </div>
      <div className="relative mt-1.5 h-3 border-b border-ink" aria-hidden>
        <div className="absolute inset-x-0 bottom-0 flex h-[4px] items-end justify-between">
          {Array.from({ length: 11 }, (_, index) => (
            <span
              className={`w-px bg-ink ${index % 5 === 0 ? 'h-[4px]' : 'h-[2px]'}`}
              key={index}
            />
          ))}
        </div>
        {value !== null ? (
          <span
            className="absolute bottom-0 h-3 w-0.5 -translate-x-1/2 bg-accent"
            style={{ left: `${Math.min(100, Math.max(0, value))}%` }}
          />
        ) : null}
      </div>
    </div>
  );
}

function ProcessTable({
  processes,
  sort,
}: {
  processes: MonitorProcess[];
  sort: MonitorProcessSort;
}) {
  return (
    <div className="overflow-x-auto">
      <table aria-label="Top 10 进程" className="w-full table-fixed border-collapse text-left">
        <thead className="border-b border-hairline font-mono text-[9px] tracking-[0.08em] text-muted">
          <tr>
            <th className="w-16 px-3 py-2 font-normal">PID</th>
            <th className="w-[28%] px-3 py-2 font-normal">名称</th>
            <th className="w-[18%] px-3 py-2 font-normal">用户</th>
            <th aria-sort={sort === 'cpu' ? 'descending' : 'none'} className="w-20 px-3 py-2 text-right font-normal">
              CPU
            </th>
            <th aria-sort={sort === 'memory' ? 'descending' : 'none'} className="w-20 px-3 py-2 text-right font-normal">
              内存
            </th>
          </tr>
        </thead>
        <tbody className="font-mono text-[10px] text-ink">
          {processes.map((process) => (
            <tr className="border-b border-hairline last:border-b-0" key={process.pid}>
              <td className="px-3 py-2 text-muted">{process.pid}</td>
              <td className="truncate px-3 py-2" title={process.name}>{process.name}</td>
              <td className="truncate px-3 py-2 text-muted" title={process.user}>{process.user}</td>
              <td className="px-3 py-2 text-right">{formatPercent(process.cpuPercent)}</td>
              <td className="px-3 py-2 text-right">{formatPercent(process.memoryPercent)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function samplingStatusLabel(
  state: MonitorViewState | null,
  connectionStatus: ServerConnectionStatus,
): string {
  if (state?.phase === 'offline') return 'OFFLINE / 已暂停';
  if (state?.phase === 'error') return 'SAMPLE FAILED / 等待重试';
  if (state?.phase === 'sampling') return 'SAMPLING / 正在采样';
  if (state?.phase === 'ready') return 'LIVE / 采样正常';
  if (connectionStatus === 'connecting') return 'LINKING / 建立连接';
  if (connectionStatus === 'ready') return 'STANDBY / 等待采样';
  return 'OFFLINE / 未连接';
}

function formatPercent(value: number | null | undefined): string {
  return value === null || value === undefined
    ? '—'
    : `${value.toFixed(1)}%`;
}

function formatBytes(bytes: number): string {
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  if (bytes >= gib) return `${(bytes / gib).toFixed(1)} GiB`;
  if (bytes >= mib) return `${(bytes / mib).toFixed(1)} MiB`;
  return `${bytes} B`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分钟`;
}

function formatClock(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
}

function unavailableLabel(code: MonitorUnavailable): string {
  switch (code) {
    case 'cpu':
      return 'CPU 采集失败';
    case 'cpu_warming_up':
      return '正在采样';
    case 'memory':
      return '内存采集失败';
    case 'disk':
      return '磁盘采集失败';
    case 'load':
      return '负载采集失败';
    case 'uptime':
      return '运行时间采集失败';
    case 'processes':
      return '进程采集失败';
    case 'processes_partial':
      return '部分进程无法解析';
  }
}
