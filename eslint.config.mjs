// @ts-check

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['out/**', 'lsp-proxy/out/**', '.github/**'],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // TODO: We shouldn't be doing this.
      '@typescript-eslint/no-explicit-any': 'off',

      // We deliberately specify unused function parameters prefixed with _
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
