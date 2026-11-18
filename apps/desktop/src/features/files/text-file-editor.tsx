import type {
  ConnectionHandle,
  RemoteFileWriteResult,
  RemoteTextFile,
} from '@opspilot/contracts';
import { MAX_EDIT_WRITE_BYTES } from '@opspilot/contracts';
import { RotateCw, Save, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';

import type { CoreClient } from '../../api/core';
import { useDialogFocusTrap } from '../../components/use-dialog-focus-trap';
import { CodeEditor } from './code-editor';
import {
  formatFileSize,
  languageForPath,
  remoteFileErrorMessage,
} from './file-browser-utils';

interface TextFileEditorProps {
  active?: boolean;
  connection: ConnectionHandle;
  core: CoreClient;
  document: RemoteTextFile;
  onClose(): void;
  onReloaded?(document: RemoteTextFile): void;
  onSaved(result: RemoteFileWriteResult): void;
}

export function TextFileEditor({
  active = true,
  connection,
  core,
  document,
  onClose,
  onReloaded,
  onSaved,
}: TextFileEditorProps) {
  const titleId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const [base, setBase] = useState(document);
  const [draft, setDraft] = useState(document.text);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const dirty = draft !== base.text;
  const fileName = base.path.split('/').at(-1) ?? base.path;
  const draftBytes = new TextEncoder().encode(draft).byteLength;
  const tooLarge = draftBytes > MAX_EDIT_WRITE_BYTES;

  useDialogFocusTrap(sectionRef, {
    active,
    onEscape: close,
  });

  async function save() {
    if (saving || reloading || tooLarge) return;
    setSaving(true);
    setError(null);
    setConflict(false);
    setNotice(null);
    const requestedConnectionId = connection.connectionId;
    try {
      const result = await core.writeFile(
        connection,
        base.path,
        draft,
        base.sha256,
      );
      if (connectionRef.current.connectionId !== requestedConnectionId) {
        setError('连接已变化，保存结果未应用到当前编辑器；请重新加载远端内容确认。');
        return;
      }
      setBase({
        ...base,
        text: draft,
        sha256: result.sha256,
        size: result.size,
        modifiedAt: result.modifiedAt,
      });
      setNotice(
        result.warning
          ? `已保存到远程。${result.warning}`
          : '已保存到远程',
      );
      onSaved(result);
    } catch (saveError) {
      if (connectionRef.current.connectionId === requestedConnectionId) {
        setError(remoteFileErrorMessage(saveError));
        setConflict(errorCode(saveError) === 'CONFLICT');
      }
    } finally {
      setSaving(false);
    }
  }

  async function retryAfterConflict() {
    if (saving || reloading || tooLarge) return;
    setSaving(true);
    setError(null);
    setConflict(false);
    setNotice(null);
    const requestedConnectionId = connection.connectionId;
    try {
      const latest = await core.readFile(connection, base.path);
      if (connectionRef.current.connectionId !== requestedConnectionId) {
        setError('连接已变化，重试保存未执行；请重新加载远端内容确认。');
        return;
      }
      const result = await core.writeFile(
        connection,
        base.path,
        draft,
        latest.sha256,
      );
      if (connectionRef.current.connectionId !== requestedConnectionId) {
        setError('连接已变化，保存结果未应用到当前编辑器；请重新加载远端内容确认。');
        return;
      }
      setBase({
        ...latest,
        text: draft,
        sha256: result.sha256,
        size: result.size,
        modifiedAt: result.modifiedAt,
      });
      setNotice(
        result.warning
          ? `已保存到远程。${result.warning}`
          : '已保存到远程',
      );
      onSaved(result);
    } catch (saveError) {
      if (connectionRef.current.connectionId === requestedConnectionId) {
        setError(remoteFileErrorMessage(saveError));
        setConflict(errorCode(saveError) === 'CONFLICT');
      }
    } finally {
      setSaving(false);
    }
  }

  async function reload() {
    if (saving || reloading) return;
    if (
      dirty
      && !window.confirm('重新加载会丢弃当前草稿并采用远端最新内容。仍要继续吗？')
    ) {
      return;
    }
    setReloading(true);
    setError(null);
    setConflict(false);
    setNotice(null);
    const requestedConnectionId = connection.connectionId;
    try {
      const latest = await core.readFile(connection, base.path);
      if (connectionRef.current.connectionId !== requestedConnectionId) {
        setError('连接已变化，未应用重新加载结果；请重试。');
        return;
      }
      setBase(latest);
      setDraft(latest.text);
      setNotice('已重新加载远端内容');
      onReloaded?.(latest);
    } catch (reloadError) {
      if (connectionRef.current.connectionId === requestedConnectionId) {
        setError(remoteFileErrorMessage(reloadError));
      }
    } finally {
      setReloading(false);
    }
  }

  function close() {
    if (
      dirty
      && !window.confirm('仍有未保存的草稿，关闭后草稿会丢失。仍要关闭吗？')
    ) {
      return;
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/45 p-6">
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="flex h-[min(760px,calc(100dvh-48px))] w-[min(980px,calc(100vw-48px))] flex-col border border-ink bg-shell"
        ref={sectionRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="flex shrink-0 items-start gap-4 border-b border-hairline px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[9px] tracking-[0.16em] text-accent">
              REMOTE TEXT / UTF-8
            </p>
            <h2
              className="mt-1 truncate text-[20px] font-semibold tracking-[-0.01em] text-ink"
              id={titleId}
            >
              编辑 {fileName}
            </h2>
            <p className="mt-1 truncate font-mono text-[10px] text-muted">
              {base.path} · {formatFileSize(base.size)} · SHA-256{' '}
              {base.sha256.slice(0, 12)}
            </p>
          </div>
          <button
            aria-label="关闭编辑器"
            className="grid size-7 shrink-0 place-items-center text-muted hover:bg-paper hover:text-ink"
            onClick={close}
            type="button"
          >
            <X aria-hidden className="size-4" strokeWidth={1.5} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-3 border-b border-hairline bg-paper px-4 font-mono text-[9px] tracking-[0.06em] text-muted">
            <span>{languageForPath(base.path).toUpperCase()}</span>
            <span>·</span>
            <span>
              {formatFileSize(draftBytes)} / {formatFileSize(MAX_EDIT_WRITE_BYTES)}
            </span>
            <span className="ml-auto flex items-center gap-2">
              <span
                aria-hidden
                className={`size-1.5 ${dirty ? 'bg-accent' : 'bg-success'}`}
              />
              {dirty ? '有未保存修改' : '与远端一致'}
            </span>
          </div>

          {error ? (
            <div
              className="shrink-0 border-b border-danger/40 bg-[#F4E9E5] px-4 py-2.5"
              role="alert"
            >
              <p className="text-[11px] leading-5 text-danger">{error}</p>
              {conflict ? (
                <div className="mt-1 flex items-center gap-3">
                  <p className="text-[10px] text-muted">
                    草稿仍保留在本编辑器内，没有覆盖远端文件。
                  </p>
                  <button
                    className="inline-flex h-7 items-center gap-1.5 border border-danger px-2 text-[10px] font-medium text-danger hover:bg-paper"
                    onClick={() => void retryAfterConflict()}
                    type="button"
                  >
                    <RotateCw aria-hidden className="size-3" strokeWidth={1.5} />
                    重试保存
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {notice ? (
            <p
              className="shrink-0 border-b border-success/30 bg-[#EDF2EC] px-4 py-2 text-[10px] text-success"
              role="status"
            >
              {notice}
            </p>
          ) : null}

          {tooLarge ? (
            <p
              className="shrink-0 border-b border-danger/40 bg-[#F4E9E5] px-4 py-2 text-[10px] text-danger"
              role="alert"
            >
              草稿超过 4 MiB 保存上限，请缩小内容后再保存。
            </p>
          ) : null}

          <div className="min-h-0 flex-1 border-b border-hairline bg-paper">
            <CodeEditor
              aria-label={`${fileName} 的远程文本内容`}
              language={languageForPath(base.path)}
              onChange={setDraft}
              value={draft}
            />
          </div>
        </div>

        <footer className="flex shrink-0 items-center gap-2 px-5 py-3">
          <p className="mr-auto max-w-[42%] truncate font-mono text-[9px] text-muted">
            保存必须匹配打开时的 SHA-256；冲突时保留草稿。
          </p>
          <button
            className="inline-flex h-8 items-center gap-1.5 border border-hairline bg-paper px-3 text-[11px] font-medium text-ink hover:border-ink disabled:opacity-40"
            disabled={saving || reloading}
            onClick={() => void reload()}
            type="button"
          >
            <RotateCw aria-hidden className="size-3.5" strokeWidth={1.5} />
            重新加载远端内容
          </button>
          <button
            className="h-8 border border-hairline px-4 text-[11px] font-medium text-ink hover:bg-paper"
            onClick={close}
            type="button"
          >
            关闭编辑器
          </button>
          <button
            className="inline-flex h-8 items-center gap-1.5 bg-ink px-4 text-[11px] font-medium text-paper disabled:opacity-40"
            disabled={saving || reloading || !dirty || tooLarge}
            onClick={() => void save()}
            type="button"
          >
            <Save aria-hidden className="size-3.5" strokeWidth={1.5} />
            {saving ? '正在保存…' : '保存到远程'}
          </button>
        </footer>
      </section>
    </div>
  );
}

function errorCode(error: unknown): string | null {
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
  ) {
    return error.code;
  }
  return null;
}
