import { describe, expect, it } from 'vitest';

import { monacoFreezePrototypeCompatibility } from './monaco-freeze-prototype';

describe('monacoFreezePrototypeCompatibility', () => {
  it('patches namespace toString initializers in Monaco modules', async () => {
    const plugin = monacoFreezePrototypeCompatibility();
    const transform = plugin.transform as unknown as (
      code: string,
      id: string,
    ) => { code: string } | null | Promise<{ code: string } | null>;
    const source = 'function toString() { return "x"; } Severity.toString = toString;';

    const result = await transform(
      source,
      '/workspace/node_modules/monaco-editor/esm/vs/base/common/severity.js?v=fixture',
    );

    expect(result?.code).toContain('Object.defineProperty(Severity, "toString"');
  });

  it('rewrites the Monarch keyword hash to a null-prototype object', async () => {
    const plugin = monacoFreezePrototypeCompatibility();
    const transform = plugin.transform as unknown as (
      code: string,
      id: string,
    ) => { code: string } | null | Promise<{ code: string } | null>;
    const source = [
      'const result = {};',
      'return hash[word.toLowerCase()] !== undefined && hash.hasOwnProperty(word.toLowerCase());',
      'return hash[word] !== undefined && hash.hasOwnProperty(word);',
    ].join('\n');

    const result = await transform(
      source,
      '/workspace/node_modules/monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile.js',
    );

    expect(result?.code).toContain('Object.create(null)');
    expect(result?.code).not.toContain('hash.hasOwnProperty');
  });

  it('ignores files outside the patch list', async () => {
    const plugin = monacoFreezePrototypeCompatibility();
    const transform = plugin.transform as unknown as (
      code: string,
      id: string,
    ) => { code: string } | null | Promise<{ code: string } | null>;

    const result = await transform(
      'Severity.toString = toString;',
      '/workspace/node_modules/monaco-editor/esm/vs/editor/editor.api.js',
    );

    expect(result).toBeNull();
  });
});
