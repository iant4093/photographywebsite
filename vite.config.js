import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    global: 'globalThis',
  },
  build: {
    target: 'es2020',
    cssCodeSplit: true,
    assetsInlineLimit: 4096,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('amazon-cognito-identity-js') || id.includes('@aws-crypto') || id.includes('/buffer/')) return 'vendor-auth'
          if (id.includes('hls.js')) return 'vendor-hls'
          if (id.includes('@marsidev/react-turnstile')) return 'vendor-turnstile'
          if (id.includes('framer-motion') || id.includes('motion-dom') || id.includes('motion-utils')) return 'vendor-motion'
          if (id.includes('react-blurhash') || id.includes('/blurhash/')) return 'vendor-imaging'
          if (id.includes('react-dom') || id.includes('react-router') || /node_modules\/react\//.test(id)) return 'vendor-react'
          return undefined
        },
      },
    },
  },
})
