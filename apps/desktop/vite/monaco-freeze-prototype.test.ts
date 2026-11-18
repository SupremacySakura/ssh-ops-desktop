import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { monacoFreezePrototypeCompatibility } from './monaco-freeze-prototype';

type Transform = (
  code: string,
  id: string,
) => { code: string } | null | Promise<{ code: string } | null>;

describe('monacoFreezePrototypeCompatibility', () => {
  it('patches toString assignments when Vite appends a query string', async () => {
    const plugin = monacoFreezePrototypeCompatibility();
    const transform = plugin.transform as unknown as Transform;
    const result = await transform(
      'MarkerSeverity.toString = toString;',
      '/workspace/node_modules/monaco-editor/esm/vs/platform/markers/common/markers.js?v=fixture',
    );

    expect(result?.code).toContain(
      'Object.defineProperty(MarkerSeverity, "toString"',
    );
  });

  it('fails closed when the installed Monaco output changes', () => {
    const plugin = monacoFreezePrototypeCompatibility();
    const transform = plugin.transform as unknown as Transform;

    expect(() => transform(
      'Object.prototype.toString = value;',
      '/workspace/node_modules/monaco-editor/esm/vs/platform/markers/common/markers.js',
    )).toThrow('compatibility target changed');
  });

  it('keeps the frozen-prototype patch targets present in installed Monaco', async () => {
    const markers = await readFile(
      new URL(
        '../node_modules/monaco-editor/esm/vs/platform/markers/common/markers.js',
        import.meta.url,
      ),
      'utf8',
    );
    const monarch = await readFile(
      new URL(
        '../node_modules/monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile.js',
        import.meta.url,
      ),
      'utf8',
    );

    expect(markers).toContain('MarkerSeverity.toString = toString;');
    expect(monarch).toContain('const result = {};');
    expect(monarch).toContain(
      'return hash[word.toLowerCase()] !== undefined && hash.hasOwnProperty(word.toLowerCase());',
    );
  });
});
