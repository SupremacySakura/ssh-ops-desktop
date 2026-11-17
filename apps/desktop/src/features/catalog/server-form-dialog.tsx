import type {
  Group,
  Server,
  ServerAuthType,
  ServerCredentialInput,
  ServerInput,
} from '@opspilot/contracts';
import { X } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';

import { useHarborStore } from '../../store/harbor-store';

interface FieldErrors {
  name?: string;
  host?: string;
  port?: string;
  user?: string;
  credential?: string;
}

export function ServerFormDialog() {
  const catalogBusy = useHarborStore((state) => state.catalogBusy);
  const catalogError = useHarborStore((state) => state.catalogError);
  const closeServerForm = useHarborStore((state) => state.closeServerForm);
  const groups = useHarborStore((state) => state.groups);
  const saveServer = useHarborStore((state) => state.saveServer);
  const serverForm = useHarborStore((state) => state.serverForm);
  const servers = useHarborStore((state) => state.servers);
  const existing = serverForm?.mode === 'edit'
    ? servers.find((server) => server.id === serverForm.serverId) ?? null
    : null;

  if (!serverForm || (serverForm.mode === 'edit' && !existing)) return null;

  return (
    <ServerFormModal
      busy={catalogBusy}
      error={catalogError}
      existing={existing}
      groups={groups}
      key={serverForm.mode === 'edit' ? serverForm.serverId : 'create'}
      onClose={closeServerForm}
      onSave={saveServer}
    />
  );
}

interface ServerFormModalProps {
  busy: boolean;
  error: string | null;
  existing: Server | null;
  groups: Group[];
  onClose: () => void;
  onSave: (
    id: string | null | undefined,
    input: ServerInput,
    credential?: ServerCredentialInput,
  ) => Promise<Server | null>;
}

function ServerFormModal({
  busy,
  error,
  existing,
  groups,
  onClose,
  onSave,
}: ServerFormModalProps) {
  const [name, setName] = useState(existing?.name ?? '');
  const [host, setHost] = useState(existing?.host ?? '');
  const [port, setPort] = useState(String(existing?.port ?? 22));
  const [user, setUser] = useState(existing?.user ?? '');
  const [groupId, setGroupId] = useState(existing?.groupId ?? '');
  const [favorite, setFavorite] = useState(existing?.favorite ?? false);
  const [authType, setAuthType] = useState<ServerAuthType>(existing?.authType ?? 'key');
  const [credential, setCredential] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const nameRef = useRef<HTMLInputElement>(null);
  const editing = existing !== null;

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) onClose();
    }

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [busy, onClose]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validate({
      name,
      host,
      port,
      user,
      credential,
      editing,
      authType,
      authChanged: existing !== null && authType !== existing.authType,
    });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const input: ServerInput = {
      name: name.trim(),
      host: host.trim(),
      port: Number(port),
      user: user.trim(),
      authType,
      groupId: groupId || null,
      favorite,
    };
    const nextCredential = credential.length > 0 ? { credential } : undefined;
    void onSave(existing?.id ?? null, input, nextCredential);
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        aria-labelledby="server-form-title"
        aria-modal="true"
        className="flex max-h-[calc(100dvh-48px)] w-[620px] flex-col border border-ink bg-shell"
        role="dialog"
      >
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-hairline px-5">
          <div>
            <p className="font-mono text-[10px] tracking-[0.16em] text-muted">SERVER RECORD</p>
            <h2
              className="mt-1 text-[20px] font-semibold tracking-[-0.01em] text-ink"
              id="server-form-title"
            >
              {editing ? '编辑服务器' : '添加服务器'}
            </h2>
          </div>
          <button
            aria-label="关闭服务器表单"
            className="grid size-7 place-items-center border border-transparent text-muted hover:border-hairline hover:bg-paper hover:text-ink"
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            <X aria-hidden className="size-4" strokeWidth={1.5} />
          </button>
        </header>

        <form className="min-h-0 overflow-y-auto px-5 py-4" noValidate onSubmit={handleSubmit}>
          {error ? (
            <p
              className="mb-4 border-l-2 border-danger bg-paper px-3 py-2 text-[11px] leading-5 text-danger"
              role="alert"
            >
              {error}
            </p>
          ) : null}

          <div className="grid grid-cols-[1fr_1fr] gap-3">
            <Field
              error={errors.name}
              id="server-name"
              label="名称"
            >
              <input
                aria-describedby={errors.name ? 'server-name-error' : undefined}
                aria-invalid={Boolean(errors.name)}
                className={inputClass(Boolean(errors.name))}
                id="server-name"
                onChange={(event) => setName(event.target.value)}
                placeholder="prod-web-01"
                ref={nameRef}
                value={name}
              />
            </Field>
            <Field
              error={errors.host}
              id="server-host"
              label="主机"
            >
              <input
                aria-describedby={errors.host ? 'server-host-error' : undefined}
                aria-invalid={Boolean(errors.host)}
                autoCapitalize="none"
                autoCorrect="off"
                className={inputClass(Boolean(errors.host))}
                id="server-host"
                onChange={(event) => setHost(event.target.value)}
                placeholder="example.com"
                spellCheck={false}
                value={host}
              />
            </Field>
            <Field
              error={errors.port}
              id="server-port"
              label="端口"
            >
              <input
                aria-describedby={errors.port ? 'server-port-error' : undefined}
                aria-invalid={Boolean(errors.port)}
                className={`${inputClass(Boolean(errors.port))} font-mono`}
                id="server-port"
                inputMode="numeric"
                onChange={(event) => setPort(event.target.value)}
                value={port}
              />
            </Field>
            <Field
              error={errors.user}
              id="server-user"
              label="用户名"
            >
              <input
                aria-describedby={errors.user ? 'server-user-error' : undefined}
                aria-invalid={Boolean(errors.user)}
                autoCapitalize="none"
                autoCorrect="off"
                className={inputClass(Boolean(errors.user))}
                id="server-user"
                onChange={(event) => setUser(event.target.value)}
                placeholder="deploy"
                spellCheck={false}
                value={user}
              />
            </Field>
          </div>

          <div className="mt-3 grid grid-cols-[1fr_1fr] gap-3">
            <Field id="server-group" label="分组">
              <select
                className={inputClass(false)}
                id="server-group"
                onChange={(event) => setGroupId(event.target.value)}
                value={groupId}
              >
                <option value="">未分组</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </Field>
            <label className="mt-5 flex h-8 items-center gap-2 border border-hairline bg-paper px-2.5 text-[11px] text-ink">
              <input
                checked={favorite}
                className="accent-accent"
                onChange={(event) => setFavorite(event.target.checked)}
                type="checkbox"
              />
              收藏并置顶
            </label>
          </div>

          <fieldset className="mt-5">
            <legend className="text-[10px] tracking-[0.14em] text-muted">认证方式</legend>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {[
                { value: 'key' as const, label: '私钥认证' },
                { value: 'password' as const, label: '密码认证' },
              ].map((option) => (
                <label
                  className={`flex h-9 items-center gap-2 border px-3 text-[12px] ${
                    authType === option.value
                      ? 'border-ink bg-ink text-paper'
                      : 'border-hairline bg-paper text-ink'
                  }`}
                  key={option.value}
                >
                  <input
                    checked={authType === option.value}
                    className="accent-accent"
                    name="auth-type"
                    onChange={() => {
                      setAuthType(option.value);
                      setCredential('');
                    }}
                    type="radio"
                    value={option.value}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>

          <Field
            className="mt-4"
            error={errors.credential}
            hint={editing ? '留空则保留现有凭据；更换认证方式时必须重新输入。' : undefined}
            id="server-credential"
            label={authType === 'key' ? '私钥' : '密码'}
          >
            {authType === 'key' ? (
              <textarea
                aria-describedby={errors.credential ? 'server-credential-error' : undefined}
                aria-invalid={Boolean(errors.credential)}
                autoCapitalize="none"
                autoCorrect="off"
                className={`${inputClass(Boolean(errors.credential))} h-28 resize-none py-2 font-mono leading-5`}
                id="server-credential"
                onChange={(event) => setCredential(event.target.value)}
                placeholder={editing ? '留空保留现有私钥' : '-----BEGIN OPENSSH PRIVATE KEY-----'}
                spellCheck={false}
                value={credential}
              />
            ) : (
              <input
                aria-describedby={errors.credential ? 'server-credential-error' : undefined}
                aria-invalid={Boolean(errors.credential)}
                autoComplete="off"
                className={inputClass(Boolean(errors.credential))}
                id="server-credential"
                onChange={(event) => setCredential(event.target.value)}
                placeholder={editing ? '留空保留现有密码' : '输入密码'}
                type="password"
                value={credential}
              />
            )}
          </Field>

          <p className="mt-3 text-[10px] leading-4 text-muted">
            密码与私钥只写入系统凭据库，不会进入 SQLite、日志或错误消息。
          </p>

          <div className="mt-5 flex items-center justify-end gap-2 border-t border-hairline pt-4">
            <button
              className="h-8 border border-hairline px-4 text-[11px] font-medium text-ink hover:bg-paper disabled:opacity-40"
              disabled={busy}
              onClick={onClose}
              type="button"
            >
              取消
            </button>
            <button
              className="h-8 bg-ink px-4 text-[11px] font-medium text-paper disabled:opacity-40"
              disabled={busy}
              type="submit"
            >
              {busy ? '正在保存…' : '保存服务器'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

interface FieldProps {
  children: ReactNode;
  className?: string;
  error?: string;
  hint?: string;
  id: string;
  label: string;
}

function Field({ children, className = '', error, hint, id, label }: FieldProps) {
  return (
    <div className={className}>
      <label
        className="block text-[10px] tracking-[0.12em] text-muted"
        htmlFor={id}
      >
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
      {error ? (
        <p className="mt-1 text-[10px] leading-4 text-danger" id={`${id}-error`}>
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-[10px] leading-4 text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

function inputClass(hasError: boolean): string {
  return `h-8 w-full border bg-paper px-2.5 text-[12px] text-ink outline-none placeholder:text-muted ${
    hasError ? 'border-danger' : 'border-hairline focus:border-accent'
  }`;
}

function validate({
  authType,
  authChanged,
  credential,
  editing,
  host,
  name,
  port,
  user,
}: {
  authType: ServerAuthType;
  authChanged: boolean;
  credential: string;
  editing: boolean;
  host: string;
  name: string;
  port: string;
  user: string;
}): FieldErrors {
  const errors: FieldErrors = {};
  const trimmedName = name.trim();
  const trimmedHost = host.trim();
  const trimmedUser = user.trim();

  if (trimmedName.length === 0) errors.name = '请输入服务器名称';
  if (trimmedHost.length === 0) {
    errors.host = '请输入主机地址';
  } else if (trimmedHost.includes('://') || /\s/u.test(trimmedHost)) {
    errors.host = '主机地址不能包含协议或空格';
  }
  if (!/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65_535) {
    errors.port = '端口必须在 1–65535 之间';
  }
  if (trimmedUser.length === 0) {
    errors.user = '请输入用户名';
  } else if (/\s/u.test(trimmedUser)) {
    errors.user = '用户名不能包含空格';
  }
  if (!editing && credential.length === 0) {
    errors.credential = authType === 'key' ? '请输入私钥' : '请输入密码';
  } else if (authChanged && credential.length === 0) {
    errors.credential = '更改认证方式时必须提供新凭据';
  }

  return errors;
}
