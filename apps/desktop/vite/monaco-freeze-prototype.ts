import type { Plugin } from 'vite';

// Tauri 的 freezePrototype 会冻结 Object.prototype。Monaco 的 TS 命名空间对象
// （var X; (function (X) { ... X.toString = toString; })(X ||= {})）在严格模式下
// 给继承自冻结原型的 toString 赋值会直接抛 TypeError；Monarch 分词器的
// arrayToHash 用普通对象当哈希表，关键词里含 "constructor" 等原型属性名时同样抛错。
// 与 xterm 兼容层同理做构建期改写，目标字符串变化时直接报错以便跟进升级。
interface PatchTarget {
  readonly replacement: string;
  readonly source: string;
  readonly suffix: string;
}

const defineToString = (name: string) =>
  `Object.defineProperty(${name}, "toString", { value: toString, writable: true, enumerable: true, configurable: true });`;

const MONARCH_COMPILE = '/monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile.js';

const PATCHES: readonly PatchTarget[] = [
  {
    suffix: '/monaco-editor/esm/vs/platform/markers/common/markers.js',
    source: 'MarkerSeverity.toString = toString;',
    replacement: defineToString('MarkerSeverity'),
  },
  {
    suffix: '/monaco-editor/esm/vs/base/common/severity.js',
    source: 'Severity.toString = toString;',
    replacement: defineToString('Severity'),
  },
  {
    suffix: '/monaco-editor/esm/vs/base/common/keyCodes.js',
    source: 'KeyCodeUtils.toString = toString;',
    replacement: defineToString('KeyCodeUtils'),
  },
  {
    suffix: '/monaco-editor/esm/vs/editor/contrib/inlineCompletions/browser/model/InlineSuggestAlternativeAction.js',
    source: 'InlineSuggestAlternativeAction.toString = toString;',
    replacement: defineToString('InlineSuggestAlternativeAction'),
  },
  {
    suffix: MONARCH_COMPILE,
    source: 'const result = {};',
    replacement: 'const result = Object.create(null);',
  },
  {
    suffix: MONARCH_COMPILE,
    source: 'return hash[word.toLowerCase()] !== undefined && hash.hasOwnProperty(word.toLowerCase());',
    replacement: 'return hash[word.toLowerCase()] !== undefined && Object.prototype.hasOwnProperty.call(hash, word.toLowerCase());',
  },
  {
    suffix: MONARCH_COMPILE,
    source: 'return hash[word] !== undefined && hash.hasOwnProperty(word);',
    replacement: 'return hash[word] !== undefined && Object.prototype.hasOwnProperty.call(hash, word);',
  },
];

export function monacoFreezePrototypeCompatibility(): Plugin {
  return {
    enforce: 'pre',
    name: 'opspilot-monaco-freeze-prototype-compatibility',
    transform(code, id) {
      const normalizedId = id.replaceAll('\\', '/');
      const moduleId = normalizedId.split('?', 1)[0];
      const patches = PATCHES.filter((target) => moduleId.endsWith(target.suffix));
      if (patches.length === 0) return null;

      let patched = code;
      for (const patch of patches) {
        const occurrences = patched.split(patch.source).length - 1;
        if (occurrences !== 1) {
          throw new Error(
            `monaco-editor compatibility target changed in ${patch.suffix}: expected one occurrence of ${JSON.stringify(patch.source)}, found ${occurrences}`,
          );
        }
        patched = patched.replace(patch.source, patch.replacement);
      }
      return { code: patched, map: null };
    },
  };
}
