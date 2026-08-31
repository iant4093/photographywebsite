import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  const mediaDomain = env.VITE_CLOUDFRONT_DOMAIN || 'd1twwtwfz1yeo4.cloudfront.net'
  const mediaOrigin = `https://${mediaDomain}`

  return {
    plugins: [react(), tailwindcss()],
    define: {
      global: 'globalThis',
    },
    optimizeDeps: {
      exclude: ['rawconvert-wasm'],
    },
    server: {
      proxy: {
        '/api': {
          target: 'https://iantruongphotography.com',
          changeOrigin: true,
        },
        '/public-previews': {
          target: mediaOrigin,
          changeOrigin: true,
        },
        '/albums': {
          target: mediaOrigin,
          changeOrigin: true,
        },
      },
    },
    build: {
      target: 'es2020',
      cssCodeSplit: true,
      assetsInlineLimit: 4096,
      modulePreload: { polyfill: false },
      rollupOptions: {
        input: {
          main: 'index.html',
          print: 'print.html',
        },
        output: {
          entryFileNames: 'assets/app-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined
            if (id.includes('amazon-cognito-identity-js') || id.includes('@aws-crypto') || id.includes('/buffer/')) return 'vendor-auth'
            if (id.includes('hls.js')) return 'vendor-hls'
            // Keep the renderer and its React bindings in separate lazy chunks.
            // The immersive gallery is route-loaded, and combining both large
            // dependency trees made a single cold-download bottleneck.
            if (id.includes('/three/examples/')) return 'vendor-three-extras'
            if (id.includes('/three/')) return 'vendor-three-core'
            if (id.includes('@react-three/')) return 'vendor-react-three'
            if (id.includes('@marsidev/react-turnstile')) return 'vendor-turnstile'
            if (id.includes('framer-motion') || id.includes('motion-dom') || id.includes('motion-utils')) return 'vendor-motion'
            if (id.includes('react-blurhash') || id.includes('/blurhash/')) return 'vendor-imaging'
            if (id.includes('react-dom') || id.includes('react-router') || /node_modules\/react\//.test(id)) return 'vendor-react'
            return undefined
          },
        },
      },
    },
    test: {
      include: ['src/**/*.test.{js,jsx}'],
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.js'],
      // The editor's full-slider interaction case can exceed Vitest's 5 s default
      // when the complete suite is competing for CPU in CI.
      testTimeout: 10000,
      coverage: {
        provider: 'v8',
        include: ['src/**/*.{js,jsx}'],
        exclude: [
          'src/**/*.test.{js,jsx}',
          'src/test/**',
          // WebGL rendering is browser-QA'd; its catalog, layout, collision, and device logic remain unit tested.
          'src/pages/ImmersiveGalleryDesktop.jsx',
          'src/components/museum/**',
        ],
        reporter: ['text', 'json-summary', 'lcov', 'html'],
        reportsDirectory: 'coverage/frontend',
        thresholds: {
          lines: 80,
          statements: 80,
          functions: 80,
          branches: 80,
        },
      },
    },
  }
})
