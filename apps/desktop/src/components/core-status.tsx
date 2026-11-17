import * as Tooltip from '@radix-ui/react-tooltip';

import { useHarborStore } from '../store/harbor-store';

const statusCopy = {
  loading: {
    label: '正在检查 Core',
    detail: '正在验证数据库与系统凭据库。',
    tone: 'bg-hairline',
  },
  ready: {
    label: 'Core 已就绪',
    detail: '数据库与系统凭据库均可用。',
    tone: 'bg-success',
  },
  unready: {
    label: 'Core 未就绪',
    detail: '数据库或系统凭据库不可用。',
    tone: 'bg-warning',
  },
  unavailable: {
    label: 'Core 不可用',
    detail: '无法读取 Core 状态。',
    tone: 'bg-danger',
  },
} as const;

export function CoreStatus() {
  const coreHealth = useHarborStore((state) => state.coreHealth);
  const health = coreHealth.status === 'ready' ? coreHealth.health : null;
  const ready = health?.databaseReady === true && health.secretStoreReady === true;
  const tone = coreHealth.status === 'loading'
    ? 'loading'
    : coreHealth.status === 'unavailable'
      ? 'unavailable'
      : ready
        ? 'ready'
        : 'unready';
  const copy = statusCopy[tone];

  return (
    <div className="space-y-2">
      <Tooltip.Provider delayDuration={120}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <div
              aria-label="Core 状态"
              aria-live="polite"
              className="flex min-h-8 items-center gap-2 border border-hairline bg-paper px-2.5 py-1.5"
              role="status"
            >
              <span aria-hidden className={`size-2 shrink-0 ${copy.tone}`} />
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-ink">
                {copy.label}
              </span>
              {health ? (
                <span className="shrink-0 font-mono text-[10px] text-muted">{health.version}</span>
              ) : null}
            </div>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              align="start"
              className="z-50 max-w-64 border border-hairline bg-paper px-3 py-2 text-[11px] leading-5 text-ink outline-none"
              side="top"
              sideOffset={6}
            >
              {copy.detail}
              <Tooltip.Arrow className="fill-paper" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
      {coreHealth.status === 'unavailable' ? (
        <p className="border-l-2 border-danger pl-2 text-[10px] leading-4 text-danger" role="alert">
          无法读取 Core 状态
        </p>
      ) : null}
    </div>
  );
}
