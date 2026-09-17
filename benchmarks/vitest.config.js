import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        include: ['benchmarks/*.bench.js'], environment: 'node',
        testTimeout: 120_000, fileParallelism: false,
    },
})
