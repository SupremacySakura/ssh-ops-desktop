import type {
  SshConfigImportItem,
  SshConfigImportPreview,
  SshConfigImportStatus,
} from '@opspilot/contracts';
import {
  Check,
  FileInput,
  RefreshCw,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';

import { useHarborStore } from '../../store/harbor-store';

export function SshConfigImportDialog() {
  const applySshConfigImport = useHarborStore((state) => state.applySshConfigImport);
  const closeSshConfigImport = useHarborStore((state) => state.closeSshConfigImport);
  const open = useHarborStore((state) => state.sshConfigImportOpen);
  const preview = useHarborStore((state) => state.sshConfigImportPreview);
  const refresh = useHarborStore((state) => state.refreshSshConfigImport);
  const result = useHarborStore((state) => state.sshConfigImportResult);
  const error = useHarborStore((state) => state.sshConfigImportError);
  const status = useHarborStore((state) => state.sshConfigImportStatus);
  const dialogRef = useRef<HTMLElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const readyItems = preview?.items.filter((item) => item.status === 'ready') ?? [];
  const readyIds = readyItems.map((item) => item.id);
  const selectedSet = new Set(selectedIds);
  const selectedReadyCount = readyIds.filter((id) => selectedSet.has(id)).length;
  const allReadySelected = readyIds.length > 0 && selectedReadyCount === readyIds.length;
  const someReadySelected = selectedReadyCount > 0 && !allReadySelected;
  const busy = status === 'applying' || status === 'loading';

  useEffect(() => {
    if (!open || !preview) {
      setSelectedIds([]);
      return;
    }
    setSelectedIds(
      preview.items
        .filter((item) => item.status === 'ready')
        .map((item) => item.id),
    );
  }, [open, preview]);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
  }, [open, preview?.previewId]);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someReadySelected;
    }
  }, [someReadySelected]);

  useEffect(() => {
    if (!open) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) closeSshConfigImport();
    }

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [busy, closeSshConfigImport, open]);

  if (!open) return null;

  function toggleReady() {
    setSelectedIds(allReadySelected ? [] : readyIds);
  }

  function toggleRow(id: string) {
    setSelectedIds((current) => (
      current.includes(id)
        ? current.filter((candidate) => candidate !== id)
        : [...current, id]
    ));
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          closeSshConfigImport();
        }
      }}
    >
      <section
        aria-describedby="ssh-config-import-description"
        aria-labelledby="ssh-config-import-title"
        aria-modal="true"
        className="flex max-h-[calc(100dvh-48px)] w-[860px] flex-col border border-ink bg-shell outline-none"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-hairline px-5">
          <div className="flex items-center gap-3">
            <span className="grid size-8 place-items-center border border-ink bg-paper">
              <FileInput aria-hidden className="size-4" strokeWidth={1.5} />
            </span>
            <div>
              <p className="font-mono text-[10px] tracking-[0.16em] text-muted">
                SSH CONFIG / IMPORT
              </p>
              <h2
                className="mt-1 text-[20px] font-semibold tracking-[-0.01em] text-ink"
                id="ssh-config-import-title"
              >
                导入 SSH Config
              </h2>
            </div>
          </div>
          <button
            aria-label="关闭 SSH Config 导入"
            className="grid size-7 place-items-center border border-transparent text-muted hover:border-hairline hover:bg-paper hover:text-ink disabled:opacity-40"
            disabled={status === 'applying'}
            onClick={closeSshConfigImport}
            type="button"
          >
            <X aria-hidden className="size-4" strokeWidth={1.5} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <p
            className="text-[11px] leading-5 text-muted"
            id="ssh-config-import-description"
          >
            读取 <span className="font-mono text-ink">~/.ssh/config</span> 中的明确 Host。
            导入只保存主机、端口、用户名与待配置状态，不复制私钥，也不会信任主机指纹。
          </p>

          {error ? (
            <div
              className="mt-4 border-l-2 border-danger bg-paper px-3 py-2.5"
              role="alert"
            >
              <div className="flex items-start gap-2">
                <TriangleAlert
                  aria-hidden
                  className="mt-0.5 size-3.5 shrink-0 text-danger"
                  strokeWidth={1.5}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] leading-5 text-danger">{error}</p>
                  <button
                    className="mt-2 inline-flex items-center gap-1 text-[10px] font-medium text-ink underline decoration-hairline underline-offset-2 disabled:opacity-40"
                    disabled={busy}
                    onClick={() => void refresh()}
                    type="button"
                  >
                    <RefreshCw aria-hidden className="size-3" strokeWidth={1.5} />
                    重新读取
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {status === 'loading' ? <LoadingPreview /> : null}

          {status === 'error' && !preview ? (
            <div className="mt-6 border-y border-dashed border-hairline px-4 py-10 text-center">
              <p className="text-[13px] font-medium text-ink">无法读取 SSH Config</p>
              <p className="mt-2 text-[11px] leading-5 text-muted">
                确认文件存在且当前用户可读，然后重新尝试。
              </p>
            </div>
          ) : null}

          {preview && status !== 'loading' ? (
            <PreviewContent
              allReadySelected={allReadySelected}
              onToggleAll={toggleReady}
              onToggleRow={toggleRow}
              preview={preview}
              readyIds={readyIds}
              selectAllRef={selectAllRef}
              selectedSet={selectedSet}
            />
          ) : null}

          {status === 'complete' && result ? (
            <ImportComplete result={result} />
          ) : null}
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-hairline px-5 py-3">
          <p className="max-w-md text-[10px] leading-4 text-muted">
            {status === 'complete'
              ? '导入后的服务器会显示“凭据待配置”，请从目录逐台补充密码或私钥。'
              : '已存在与同批次重复项会自动跳过；Proxy、Include、Match 等未支持语义不会静默直连。'}
          </p>
          {status === 'complete' ? (
            <button
              className="h-8 bg-ink px-4 text-[11px] font-medium text-paper"
              onClick={closeSshConfigImport}
              type="button"
            >
              完成
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button
                className="h-8 border border-hairline px-4 text-[11px] font-medium text-ink hover:bg-paper disabled:opacity-40"
                disabled={status === 'applying'}
                onClick={closeSshConfigImport}
                type="button"
              >
                取消
              </button>
              <button
                className="inline-flex h-8 items-center gap-1.5 bg-ink px-4 text-[11px] font-medium text-paper disabled:opacity-40"
                disabled={
                  busy
                  || readyIds.length === 0
                  || selectedReadyCount === 0
                }
                onClick={() => void applySshConfigImport(selectedIds)}
                type="button"
              >
                {status === 'applying' ? null : (
                  <Check aria-hidden className="size-3.5" strokeWidth={1.5} />
                )}
                {status === 'applying'
                  ? '正在导入…'
                  : `导入 ${selectedReadyCount} 台服务器`}
              </button>
            </div>
          )}
        </footer>
      </section>
    </div>
  );
}

interface PreviewContentProps {
  allReadySelected: boolean;
  onToggleAll: () => void;
  onToggleRow: (id: string) => void;
  preview: SshConfigImportPreview;
  readyIds: string[];
  selectAllRef: RefObject<HTMLInputElement | null>;
  selectedSet: Set<string>;
}

function PreviewContent({
  allReadySelected,
  onToggleAll,
  onToggleRow,
  preview,
  readyIds,
  selectAllRef,
  selectedSet,
}: PreviewContentProps) {
  return (
    <>
      <div className="mt-4 grid grid-cols-[1fr_88px_88px] border border-hairline bg-paper">
        <div className="border-r border-hairline px-3 py-2">
          <p className="font-mono text-[9px] tracking-[0.14em] text-muted">SOURCE</p>
          <p className="mt-1 truncate font-mono text-[11px] text-ink">
            {preview.sourcePath}
          </p>
        </div>
        <div className="border-r border-hairline px-3 py-2">
          <p className="font-mono text-[9px] tracking-[0.14em] text-muted">可导入</p>
          <p className="mt-1 font-mono text-[13px] tabular-nums text-ink">
            {preview.importableCount}
          </p>
        </div>
        <div className="px-3 py-2">
          <p className="font-mono text-[9px] tracking-[0.14em] text-muted">已存在</p>
          <p className="mt-1 font-mono text-[13px] tabular-nums text-ink">
            {preview.existingCount}
          </p>
        </div>
      </div>

      {preview.warningCount > 0 ? (
        <details className="mt-3 border border-hairline bg-paper/70 px-3 py-2">
          <summary className="cursor-pointer text-[10px] font-medium text-warning">
            文件提示 {preview.warningCount} 条
          </summary>
          <ul className="mt-2 max-h-24 space-y-1 overflow-y-auto pr-1">
            {preview.warnings.map((warning, index) => (
              <li
                className="font-mono text-[9px] leading-4 text-muted"
                key={`${warning.line}:${index}`}
              >
                第 {warning.line} 行 · {warning.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="mt-4 flex items-center gap-2 text-[10px] tracking-[0.16em] text-muted">
        <span>明确 Host</span>
        <span aria-hidden className="h-px flex-1 bg-hairline" />
        <span className="font-mono tabular-nums">{preview.items.length}</span>
      </div>

      {preview.items.length === 0 ? (
        <div className="mt-3 border-y border-dashed border-hairline px-4 py-10 text-center">
          <p className="text-[13px] font-medium text-ink">没有可导入的明确 Host</p>
          <p className="mt-2 text-[11px] leading-5 text-muted">
            通配 Host、Match 与不完整条目不会生成服务器。
          </p>
        </div>
      ) : (
        <div className="mt-2 border border-hairline bg-paper">
          <div className="grid grid-cols-[32px_1.2fr_0.9fr_1.4fr_78px_92px] items-center border-b border-hairline px-3 py-2 font-mono text-[9px] tracking-[0.1em] text-muted">
            <label className="grid place-items-center">
              <input
                aria-label="全选可导入服务器"
                checked={allReadySelected}
                className="size-3.5 accent-accent disabled:opacity-40"
                disabled={readyIds.length === 0}
                onChange={onToggleAll}
                ref={selectAllRef}
                type="checkbox"
              />
            </label>
            <span>名称</span>
            <span>用户</span>
            <span>主机</span>
            <span>端口</span>
            <span>状态</span>
          </div>
          <ul aria-label="SSH Config 预览" className="divide-y divide-hairline">
            {preview.items.map((item) => (
              <ImportRow
                item={item}
                key={item.id}
                onToggle={() => onToggleRow(item.id)}
                selected={selectedSet.has(item.id)}
              />
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function ImportRow({
  item,
  onToggle,
  selected,
}: {
  item: SshConfigImportItem;
  onToggle: () => void;
  selected: boolean;
}) {
  const selectable = item.status === 'ready';
  return (
    <li className={selectable ? 'bg-paper' : 'bg-[#F3F1EC]'}>
      <div className="grid grid-cols-[32px_1.2fr_0.9fr_1.4fr_78px_92px] items-center px-3 py-2.5">
        <label className="grid place-items-center">
          <input
            aria-label={`选择 ${item.alias}`}
            checked={selected}
            className="size-3.5 accent-accent disabled:opacity-40"
            disabled={!selectable}
            onChange={onToggle}
            type="checkbox"
          />
        </label>
        <div className="min-w-0 pr-3">
          <p className="truncate text-[12px] font-medium text-ink">{item.alias}</p>
          {item.identityFile ? (
            <p className="mt-0.5 truncate font-mono text-[9px] text-muted">
              私钥提示 {item.identityFile} · 不复制
            </p>
          ) : null}
        </div>
        <span className="truncate font-mono text-[10px] text-muted">
          {item.username}
        </span>
        <span className="truncate pr-2 font-mono text-[10px] text-ink">
          {item.host}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-muted">
          {item.port}
        </span>
        <StatusMark status={item.status} />
      </div>
      {item.warnings.length > 0 ? (
        <ul className="space-y-0.5 px-12 pb-2">
          {item.warnings.map((warning, index) => (
            <li className="text-[9px] leading-4 text-warning" key={`${warning}:${index}`}>
              {warning}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function StatusMark({ status }: { status: SshConfigImportStatus }) {
  const copy = {
    ready: { label: '可导入', className: 'text-success' },
    existing: { label: '已存在', className: 'text-muted' },
    duplicateInBatch: { label: '同批重复', className: 'text-warning' },
    unsupported: { label: '暂不支持', className: 'text-danger' },
  } as const;
  const current = copy[status];

  return (
    <span className={`font-mono text-[9px] tracking-[0.06em] ${current.className}`}>
      {current.label}
    </span>
  );
}

function LoadingPreview() {
  return (
    <div className="mt-6" role="status">
      <div className="h-0.5 w-full overflow-hidden bg-hairline">
        <div className="h-full w-1/3 animate-pulse bg-accent" />
      </div>
      <p className="mt-3 text-[11px] text-muted">正在读取并校准 SSH Config…</p>
      <div className="mt-4 space-y-1.5">
        {[0, 1, 2, 3].map((row) => (
          <div className="h-11 border border-hairline bg-paper/60" key={row} />
        ))}
      </div>
    </div>
  );
}

function ImportComplete({
  result,
}: {
  result: {
    importedCount: number;
    skippedCount: number;
  };
}) {
  return (
    <div className="mt-6 border border-success bg-paper px-5 py-6">
      <div className="flex items-center gap-2 text-success">
        <Check aria-hidden className="size-4" strokeWidth={1.7} />
        <p className="text-[13px] font-semibold">导入完成</p>
      </div>
      <p className="mt-3 text-[13px] leading-6 text-ink">
        已导入 <span className="font-mono font-medium">{result.importedCount}</span> 台服务器，
        跳过 <span className="font-mono font-medium">{result.skippedCount}</span> 台重复记录。
      </p>
      <p className="mt-2 text-[10px] leading-5 text-muted">
        新服务器尚未配置密码或私钥。编辑服务器并保存凭据后，连接能力才会就绪。
      </p>
    </div>
  );
}
