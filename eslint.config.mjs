import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'out/**',
      'node_modules/**',
      '.vscode-test/**',
      'coverage/**',
      'esbuild.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      curly: 'warn',
      eqeqeq: ['warn', 'always'],
      'no-throw-literal': 'warn',
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          selector: 'import',
          format: ['camelCase', 'PascalCase'],
        },
      ],
    },
  },
);
