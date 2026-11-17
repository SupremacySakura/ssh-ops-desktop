export function EmptyWorkspace() {
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
