import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'src-tauri/gen/**',
      'target/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ['packages/contracts/src/**/*.{ts,tsx}'],
    rules: {
      // Contract schemas intentionally reject ASCII control characters at trust boundaries.
      'no-control-regex': 'off',
    },
  },
);
