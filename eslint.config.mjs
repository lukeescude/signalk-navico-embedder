import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';

export default [
  // src/ is React/JSX built by webpack/babel; public/ holds webpack output.
  { ignores: ['node_modules/', 'src/', 'public/'] },
  js.configs.recommended,
  stylistic.configs.customize({
    indent: 2,
    quotes: 'single',
    semi: true,
    arrowParens: true,
    braceStyle: '1tbs',
  }),
  {
    languageOptions: {
      ecmaVersion: 'latest',
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['**/*.{js,cjs}'],
    languageOptions: { sourceType: 'commonjs' },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { sourceType: 'module' },
  },
];
