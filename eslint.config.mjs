import js from '@eslint/js';

export default [
  {
    ignores: [
      'node_modules/',
      'build/',
      '.svelte-kit/',
      'dist/',
      'dist-worker/',
      '**/*.ts',
      '**/*.mts',
      '**/*.cts',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
];

