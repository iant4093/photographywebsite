import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores([
    'dist/**',
    'coverage/**',
    '**/.venv*/**',
    'backend/.aws-sam/**',
    'website_review/**',
  ]),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      // Component identifiers are capitalized; Framer Motion intentionally
      // exposes the lowercase `motion` namespace used directly in JSX.
      'no-unused-vars': ['error', { varsIgnorePattern: '^(?:[A-Z_]|motion$)' }],
    },
  },
  {
    files: ['ops/cloudfront_www_redirect.js'],
    languageOptions: {
      sourceType: 'script',
    },
    rules: {
      // CloudFront Functions discover this required entry point by name.
      'no-unused-vars': ['error', { varsIgnorePattern: '^(handler|[A-Z_])' }],
    },
  },
])
