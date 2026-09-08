import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root,
  envDir: root,
  publicDir: false,
  server: { host: '127.0.0.1', port: 4177, strictPort: true },
  // Keep disposable output out of both the live site's dist and source linting.
  build: { outDir: '../../node_modules/.cache/cursor-study', emptyOutDir: true },
})
