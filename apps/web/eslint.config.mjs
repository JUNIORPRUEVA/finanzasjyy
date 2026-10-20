import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * ESLint de la PWA de FINANZA (flat config de typescript-eslint).
 *
 * El plugin de reglas de React Hooks es necesario, no opcional: el código usa
 * directivas `// eslint-disable-next-line react-hooks/exhaustive-deps` en los
 * pocos sitios donde la omisión de dependencias es deliberada. Sin el plugin,
 * ESLint 9 trata esas directivas como «regla desconocida» y rompe el lint
 * completo con 5 errores… aunque el código estuviera bien.
 *
 * Severidades: `rules-of-hooks` en ERROR (un hook condicional es un fallo real)
 * y `exhaustive-deps` en AVISO (ayuda sin bloquear por omisiones intencionadas).
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'dev-dist/**', 'node_modules/**', 'coverage/**'],
  },
  ...tseslint.configs.recommended,
  {
    plugins: {
      'react-hooks': reactHooks,
    },
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      // Sólo las dos reglas clásicas del plugin. Las que añade su preset
      // «recommended» moderno (por ejemplo `set-state-in-effect`) son del
      // compilador de React y marcarían como error patrones que aquí son
      // deliberados; activarlas ahora convertiría la revisión en una refactorización
      // entera, no en un arreglo del lint.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
