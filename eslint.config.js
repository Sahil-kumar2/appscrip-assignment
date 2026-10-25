export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'],
  },
  {
    rules: {
      'no-unused-vars': 'off',
      'prefer-const': 'warn',
    },
  },
];
