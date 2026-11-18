import type { Group, GroupInput } from '@opspilot/contracts';
import { Save, Trash2, X } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';

import { ConfirmDialog } from '../../components/confirm-dialog';
import { useHarborStore } from '../../store/harbor-store';

interface PendingDelete {
  id: string;
  name: string;
}

export function GroupManagerDialog() {
  const catalogBusy = useHarborStore((state) => state.catalogBusy);
  const catalogError = useHarborStore((state) => state.catalogError);
  const closeGroupManager = useHarborStore((state) => state.closeGroupManager);
  const deleteGroup = useHarborStore((state) => state.deleteGroup);
  const groupManagerOpen = useHarborStore((state) => state.groupManagerOpen);
  const groups = useHarborStore((state) => state.groups);
  const saveGroup = useHarborStore((state) => state.saveGroup);
  const servers = useHarborStore((state) => state.servers);
  const [newName, setNewName] = useState('');
  const [newSortOrder, setNewSortOrder] = useState(() => String(nextSortOrder(groups)));
  const [createError, setCreateError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (groupManagerOpen) {
      setNewSortOrder(String(nextSortOrder(useHarborStore.getState().groups)));
      nameRef.current?.focus();
    }
  }, [groupManagerOpen]);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !catalogBusy && !pendingDelete) {
        closeGroupManager();
      }
    }

    if (!groupManagerOpen) return;
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [catalogBusy, closeGroupManager, groupManagerOpen, pendingDelete]);

  if (!groupManagerOpen) return null;

  function submitNewGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const error = validateGroupDraft(newName, newSortOrder);
    setCreateError(error);
    if (error) return;

    const input: GroupInput = {
      name: newName.trim(),
      sortOrder: Number(newSortOrder),
    };
    void saveGroup(null, input).then((saved) => {
      if (!saved) return;
      setNewName('');
      setNewSortOrder(String(nextSortOrder([...groups, saved])));
      setCreateError(null);
      nameRef.current?.focus();
    });
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40 grid place-items-center bg-ink/40 p-6"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !catalogBusy && !pendingDelete) {
            closeGroupManager();
          }
        }}
      >
        <section
          aria-labelledby="group-manager-title"
          aria-modal="true"
          className="flex max-h-[calc(100dvh-48px)] w-[640px] flex-col border border-ink bg-shell"
          role="dialog"
        >
          <header className="flex h-16 shrink-0 items-center justify-between border-b border-hairline px-5">
            <div>
              <p className="font-mono text-[10px] tracking-[0.16em] text-muted">GROUP INDEX</p>
              <h2
                className="mt-1 text-[20px] font-semibold tracking-[-0.01em] text-ink"
                id="group-manager-title"
              >
                分组管理
              </h2>
            </div>
            <button
              aria-label="关闭分组管理"
              className="grid size-7 place-items-center border border-transparent text-muted hover:border-hairline hover:bg-paper hover:text-ink"
              disabled={catalogBusy}
              onClick={closeGroupManager}
              type="button"
            >
              <X aria-hidden className="size-4" strokeWidth={1.5} />
            </button>
          </header>

          <div className="min-h-0 overflow-y-auto px-5 py-4">
            {catalogError ? (
              <p
                className="mb-4 border-l-2 border-danger bg-paper px-3 py-2 text-[11px] leading-5 text-danger"
                role="alert"
              >
                {catalogError}
              </p>
            ) : null}

            <form
              className="grid grid-cols-[1fr_88px_96px] items-end gap-2 border-b border-hairline pb-4"
              noValidate
              onSubmit={submitNewGroup}
            >
              <div>
                <label className="text-[10px] tracking-[0.12em] text-muted" htmlFor="new-group-name">
                  新分组名称
                </label>
                <input
                  aria-invalid={Boolean(createError)}
                  className="mt-1.5 h-8 w-full border border-hairline bg-paper px-2.5 text-[12px] text-ink outline-none focus:border-accent"
                  id="new-group-name"
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="生产"
                  ref={nameRef}
                  value={newName}
                />
              </div>
              <div>
                <label className="text-[10px] tracking-[0.12em] text-muted" htmlFor="new-group-sort">
                  新分组排序
                </label>
                <input
                  className="mt-1.5 h-8 w-full border border-hairline bg-paper px-2.5 font-mono text-[12px] text-ink outline-none focus:border-accent"
                  id="new-group-sort"
                  inputMode="numeric"
                  onChange={(event) => setNewSortOrder(event.target.value)}
                  value={newSortOrder}
                />
              </div>
              <button
                className="h-8 bg-ink px-3 text-[11px] font-medium text-paper disabled:opacity-40"
                disabled={catalogBusy}
                type="submit"
              >
                创建分组
              </button>
              {createError ? (
                <p className="col-span-3 text-[10px] text-danger" role="alert">
                  {createError}
                </p>
              ) : null}
            </form>

            <div className="mt-4 flex items-center gap-2 text-[10px] tracking-[0.16em] text-muted">
              <span>现有分组</span>
              <span aria-hidden className="h-px flex-1 bg-hairline" />
              <span className="font-mono tabular-nums">{groups.length}</span>
            </div>

            {groups.length === 0 ? (
              <p className="mt-6 border-y border-dashed border-hairline py-7 text-center text-[11px] text-muted">
                还没有分组。先创建一个，再把服务器停靠进去。
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {groups.map((group) => (
                  <GroupRow
                    busy={catalogBusy}
                    count={servers.filter((server) => server.groupId === group.id).length}
                    group={group}
                    key={`${group.id}:${group.name}:${group.sortOrder}`}
                    onDelete={() => setPendingDelete({ id: group.id, name: group.name })}
                    onSave={saveGroup}
                  />
                ))}
              </ul>
            )}
          </div>

          <footer className="flex items-center justify-between border-t border-hairline px-5 py-3">
            <p className="max-w-sm text-[10px] leading-4 text-muted">
              单层级分组；删除分组只会让服务器归入未分组，不会删除服务器或凭据。
            </p>
            <button
              className="h-8 border border-hairline px-4 text-[11px] font-medium text-ink hover:bg-paper"
              onClick={closeGroupManager}
              type="button"
            >
              完成
            </button>
          </footer>
        </section>
      </div>

      {pendingDelete ? (
        <ConfirmDialog
          busy={catalogBusy}
          busyLabel="正在删除…"
          confirmLabel="确认删除"
          description={
            <>
              将删除分组 <strong className="font-medium text-ink">{pendingDelete.name}</strong>。
              该分组中的服务器会自动移入“未分组”，服务器与系统凭据保持不变。
            </>
          }
          error={catalogError}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            void deleteGroup(pendingDelete.id).then((deleted) => {
              if (deleted) setPendingDelete(null);
            });
          }}
          title="删除分组？"
        />
      ) : null}
    </>
  );
}

interface GroupRowProps {
  busy: boolean;
  count: number;
  group: Group;
  onDelete: () => void;
  onSave: (id: string, input: GroupInput) => Promise<Group | null>;
}

function GroupRow({ busy, count, group, onDelete, onSave }: GroupRowProps) {
  const [name, setName] = useState(group.name);
  const [sortOrder, setSortOrder] = useState(String(group.sortOrder));
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextError = validateGroupDraft(name, sortOrder);
    setError(nextError);
    if (nextError) return;

    void onSave(group.id, {
      name: name.trim(),
      sortOrder: Number(sortOrder),
    });
  }

  return (
    <li>
      <form
        className="grid grid-cols-[1fr_80px_72px_32px] items-center gap-2 border border-hairline bg-paper/60 p-2"
        noValidate
        onSubmit={submit}
      >
        <div>
          <label className="sr-only" htmlFor={`group-name-${group.id}`}>
            分组名称 {group.name}
          </label>
          <input
            aria-label={`分组名称 ${group.name}`}
            className="h-8 w-full border border-transparent bg-transparent px-2 text-[12px] font-medium text-ink outline-none hover:border-hairline focus:border-accent focus:bg-paper"
            id={`group-name-${group.id}`}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
          <p className="px-2 font-mono text-[9px] text-muted">{count} 台服务器</p>
        </div>
        <div>
          <label className="sr-only" htmlFor={`group-sort-${group.id}`}>
            分组排序 {group.name}
          </label>
          <input
            aria-label={`分组排序 ${group.name}`}
            className="h-8 w-full border border-hairline bg-paper px-2 font-mono text-[11px] text-ink outline-none focus:border-accent"
            id={`group-sort-${group.id}`}
            inputMode="numeric"
            onChange={(event) => setSortOrder(event.target.value)}
            value={sortOrder}
          />
        </div>
        <button
          aria-label={`保存分组 ${group.name}`}
          className="inline-flex h-8 items-center justify-center gap-1 border border-hairline px-2 text-[10px] font-medium text-ink hover:border-ink disabled:opacity-40"
          disabled={busy}
          type="submit"
        >
          <Save aria-hidden className="size-3" strokeWidth={1.5} />
          保存
        </button>
        <button
          aria-label={`删除分组 ${group.name}`}
          className="grid size-8 place-items-center border border-transparent text-muted hover:border-danger hover:text-danger disabled:opacity-40"
          disabled={busy}
          onClick={onDelete}
          type="button"
        >
          <Trash2 aria-hidden className="size-3.5" strokeWidth={1.5} />
        </button>
        {error ? (
          <p className="col-span-4 text-[10px] text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </li>
  );
}

function validateGroupDraft(name: string, sortOrder: string): string | null {
  if (name.trim().length === 0) return '请输入分组名称';
  if (!/^-?\d+$/u.test(sortOrder)) return '排序必须是整数';
  return null;
}

function nextSortOrder(groups: Group[]): number {
  return groups.reduce(
    (highest, group) => Math.max(highest, group.sortOrder),
    0,
  ) + 10;
}
