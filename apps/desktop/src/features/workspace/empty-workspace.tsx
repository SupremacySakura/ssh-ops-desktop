import { Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { ConfirmDialog } from '../../components/confirm-dialog';
import { formatLastConnectedAt, useHarborStore } from '../../store/harbor-store';

export function EmptyWorkspace() {
  const catalogBusy = useHarborStore((state) => state.catalogBusy);
  const catalogError = useHarborStore((state) => state.catalogError);
  const deleteServer = useHarborStore((state) => state.deleteServer);
  const groups = useHarborStore((state) => state.groups);
  const openEditServer = useHarborStore((state) => state.openEditServer);
  const selectedServerId = useHarborStore((state) => state.selectedServerId);
  const selectedServer = useHarborStore((state) => (
    state.servers.find((server) => server.id === state.selectedServerId) ?? null
  ));
  const group = selectedServer?.groupId
    ? groups.find((candidate) => candidate.id === selectedServer.groupId)
    : null;
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  if (selectedServer && selectedServer.id === selectedServerId) {
    return (
      <>
        <main className="flex min-w-0 flex-1">
          <div className="hidden w-[30px] shrink-0 items-center justify-center border-r border-hairline bg-[#E2DED6] xl:flex">
            <span className="font-mono text-[10px] tracking-[0.18em] text-muted [writing-mode:vertical-rl]">
              {selectedServer.name.toLocaleUpperCase('en-US')} · 已选择
            </span>
          </div>

          <section className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-24 shrink-0 items-center justify-between border-b border-hairline px-6">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span aria-hidden className="size-1.5 bg-accent" />
                  <p className="font-mono text-[10px] tracking-[0.14em] text-muted">
                    {group?.name ?? '未分组'}
                  </p>
                </div>
                <h2 className="mt-2 truncate text-[22px] font-semibold tracking-[-0.01em] text-ink">
                  {selectedServer.name}
                </h2>
                <p className="mt-1 font-mono text-[11px] text-muted">
                  {selectedServer.user}@{selectedServer.host}:{selectedServer.port} ·{' '}
                  {selectedServer.authType === 'key' ? '私钥认证' : '密码认证'}
                </p>
              </div>
              <div className="ml-6 flex shrink-0 items-center gap-2">
                <span className="font-mono text-[10px] tracking-[0.1em] text-muted">
                  {formatLastConnectedAt(selectedServer.lastConnectedAt)}
                </span>
                <button
                  className="inline-flex h-8 items-center gap-1.5 border border-hairline bg-paper px-2.5 text-[11px] font-medium text-ink hover:border-ink disabled:opacity-40"
                  disabled={catalogBusy}
                  onClick={() => openEditServer(selectedServer.id)}
                  type="button"
                >
                  <Pencil aria-hidden className="size-3.5" strokeWidth={1.5} />
                  编辑服务器
                </button>
                <button
                  className="inline-flex h-8 items-center gap-1.5 border border-hairline bg-transparent px-2.5 text-[11px] font-medium text-danger hover:border-danger disabled:opacity-40"
                  disabled={catalogBusy}
                  onClick={() => setConfirmingDelete(true)}
                  type="button"
                >
                  <Trash2 aria-hidden className="size-3.5" strokeWidth={1.5} />
                  删除服务器
                </button>
              </div>
            </header>

            <nav aria-label="服务器工作区视图" className="flex gap-1.5 px-6 pt-3.5">
              {['终端', '文件', '监控', 'Docker'].map((label, index) => (
                <span
                  className={`border px-4 py-2 text-[12px] tracking-[0.08em] ${
                    index === 0
                      ? 'border-ink bg-ink text-paper'
                      : 'border-hairline text-muted'
                  }`}
                  key={label}
                >
                  {label}
                </span>
              ))}
            </nav>

            <div className="mx-6 my-3.5 flex min-h-0 flex-1 border border-[#000] bg-screen px-5 py-5 text-screen-text">
              <div className="max-w-xl self-center font-mono text-[12px] leading-7">
                <p className="text-[#8E8A80]">harbor://{selectedServer.host}:{selectedServer.port}</p>
                <p className="mt-2 text-screen-text">服务器目录已就绪。</p>
                <p className="text-[#B9B4A8]">
                  SSH 连接、终端、文件、监控与 Docker 将在后续议题接入；当前工作区保留服务器上下文。
                </p>
                <div aria-hidden className="mt-4 flex items-center gap-2">
                  <span className="h-px w-12 bg-accent" />
                  <span className="size-1.5 bg-accent" />
                  <span className="h-px flex-1 bg-[#3B3934]" />
                </div>
              </div>
            </div>
          </section>
        </main>
        {confirmingDelete ? (
          <ConfirmDialog
            busy={catalogBusy}
            confirmLabel="确认删除"
            description={
              <>
                将从 Harbor 删除 <strong className="font-medium text-ink">{selectedServer.name}</strong>
                （{selectedServer.user}@{selectedServer.host}:{selectedServer.port}）。系统凭据库中的对应凭据也会一并清理，此操作无法撤销。
              </>
            }
            error={catalogError}
            onCancel={() => setConfirmingDelete(false)}
            onConfirm={() => {
              void deleteServer(selectedServer.id).then((deleted) => {
                if (deleted) setConfirmingDelete(false);
              });
            }}
            title="删除服务器？"
          />
        ) : null}
      </>
    );
  }

  return (
    <main className="flex min-w-0 flex-1">
      <div className="hidden w-[30px] shrink-0 items-center justify-center border-r border-hairline bg-[#E2DED6] xl:flex">
        <span className="font-mono text-[10px] tracking-[0.18em] text-muted [writing-mode:vertical-rl]">
          NO SERVER · STANDBY
        </span>
      </div>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-24 shrink-0 items-center justify-between border-b border-hairline px-6">
          <div>
            <p className="text-[10px] tracking-[0.18em] text-muted">WORKSPACE</p>
            <p className="mt-2 font-mono text-[11px] text-muted">未建立 SSH 连接</p>
          </div>
          <p className="font-mono text-[10px] tracking-[0.12em] text-muted">HARBOR / 00</p>
        </header>

        <div className="grid min-h-0 flex-1 place-items-center px-10 py-12">
          <div className="max-w-md">
            <div className="mb-5 flex items-center gap-2" aria-hidden>
              <span className="h-px w-10 bg-accent" />
              <span className="size-1.5 bg-accent" />
              <span className="h-px flex-1 bg-hairline" />
            </div>
            <h2 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-ink">
              未选择服务器
            </h2>
            <p className="mt-4 max-w-sm text-[13px] leading-6 text-muted">
              从左侧选择一台服务器。终端、文件、监控与 Docker 会在同一个工作区中展开。
            </p>
            <div className="mt-8 grid grid-cols-4 border-y border-hairline text-center font-mono text-[10px] tracking-[0.1em] text-muted">
              {['终端', '文件', '监控', 'DOCKER'].map((label) => (
                <span className="border-r border-hairline px-2 py-3 last:border-r-0" key={label}>
                  {label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
