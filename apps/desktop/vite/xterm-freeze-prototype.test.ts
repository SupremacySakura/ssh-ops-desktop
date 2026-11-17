import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { xtermFreezePrototypeCompatibility } from './xterm-freeze-prototype';

describe('xtermFreezePrototypeCompatibility', () => {
  it('patches the xterm ESM entry when Vite appends a query string', async () => {
    const plugin = xtermFreezePrototypeCompatibility();
    const transform = plugin.transform as unknown as (
      code: string,
      id: string,
    ) => { code: string } | null | Promise<{ code: string } | null>;
    const source = 'function s(l){return Jn.keyCodeToStr(l)}o.toString=s;function t(l){}';

    const result = await transform(
      source,
      '/workspace/node_modules/@xterm/xterm/lib/xterm.mjs?v=fixture',
    );

    expect(result?.code).toContain('Object.defineProperty(o,"toString"');
  });

  it('fails closed when the installed xterm output changes', async () => {
    const plugin = xtermFreezePrototypeCompatibility();
    const transform = plugin.transform as unknown as (
      code: string,
      id: string,
    ) => { code: string } | null | Promise<{ code: string } | null>;

    expect(() => transform(
      'Object.prototype.toString = value;',
      '/workspace/node_modules/@xterm/xterm/lib/xterm.mjs',
    )).toThrow('compatibility target changed');
  });

  it('keeps the frozen-prototype patch target present in the installed xterm', async () => {
    const source = await readFile(
      new URL(
        '../node_modules/@xterm/xterm/lib/xterm.mjs',
        import.meta.url,
      ),
      'utf8',
    );

    expect(source).toContain(
      'function s(l){return Jn.keyCodeToStr(l)}o.toString=s;function t(l)',
    );
  });
});
