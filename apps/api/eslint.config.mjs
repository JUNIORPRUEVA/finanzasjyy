import tseslint from 'typescript-eslint';

/**
 * ESLint de la API de FINANZA.
 * Se usa la configuración recomendada de typescript-eslint (flat config).
 *
 * Nota: `@typescript-eslint/consistent-type-imports` está DESACTIVADA a
 * propósito. NestJS resuelve la inyección de dependencias con los metadatos del
 * decorador (`design:paramtypes`), así que convertir una clase inyectada en
 * `import type` rompería la aplicación en tiempo de ejecución.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'src/generated/**', 'prisma/migrations/**'],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/consistent-type-imports': 'off',
      'no-console': ['warn', { allow: ['warn', 'error', 'log'] }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
  {
    // Las pruebas y los scripts pueden usar `console` con libertad.
    files: ['test/**/*.ts', 'src/**/*.spec.ts', 'src/scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
