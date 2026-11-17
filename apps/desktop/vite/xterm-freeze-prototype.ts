import type { Plugin } from 'vite';

const XTERM_ENTRY_SUFFIX = '/@xterm/xterm/lib/xterm.mjs';
const INCOMPATIBLE_INITIALIZER = 'function s(l){return Jn.keyCodeToStr(l)}o.toString=s;function t(l)';
const COMPATIBLE_INITIALIZER = 'function s(l){return Jn.keyCodeToStr(l)}Object.defineProperty(o,"toString",{value:s,writable:!0,enumerable:!0,configurable:!0});function t(l)';

export function xtermFreezePrototypeCompatibility(): Plugin {
  return {
    enforce: 'pre',
    name: 'opspilot-xterm-freeze-prototype-compatibility',
    transform(code, id) {
      const normalizedId = id.replaceAll('\\', '/');
      const moduleId = normalizedId.split('?', 1)[0];
      if (!moduleId.endsWith(XTERM_ENTRY_SUFFIX)) return null;

      const occurrences = code.split(INCOMPATIBLE_INITIALIZER).length - 1;
      if (occurrences !== 1) {
        throw new Error(
          `@xterm/xterm compatibility target changed: expected one initializer, found ${occurrences}`,
        );
      }

      return {
        code: code.replace(INCOMPATIBLE_INITIALIZER, COMPATIBLE_INITIALIZER),
        map: null,
      };
    },
  };
}
