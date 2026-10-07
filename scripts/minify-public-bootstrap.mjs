import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { transformWithEsbuild } from 'vite'

// Keep the readable early theme/hero/catalog script in public/, but deliver
// the same minification used for application code in production builds.
export function minifyPublicBootstrap() {
    let output
    return {
        name: 'minify-public-bootstrap',
        apply: 'build',
        configResolved(config) {
            output = resolve(config.root, config.build.outDir, 'theme-init.js')
        },
        async writeBundle() {
            const source = await readFile(output, 'utf8')
            const { code } = await transformWithEsbuild(source, 'theme-init.js', {
                minify: true, target: 'es2020', sourcemap: false,
            })
            await writeFile(output, code)
        },
    }
}
