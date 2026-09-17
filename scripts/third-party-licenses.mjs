import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = path => readFileSync(path, 'utf8')

function packageRoot(moduleId) {
    const id = moduleId.replaceAll('\0', '').replaceAll('\\', '/').split('?')[0]
    const marker = '/node_modules/'
    const at = id.lastIndexOf(marker)
    if (at < 0) return null
    const parts = id.slice(at + marker.length).split('/')
    return id.slice(0, at + marker.length) + parts.slice(0, parts[0].startsWith('@') ? 2 : 1).join('/')
}

function licenseTexts(directory, manifest, overrides) {
    const paths = readdirSync(directory).filter(name => /^(licen[sc]e|copying|copyright|notice|ofl)([.-]|$)/i.test(name))
        .map(name => join(directory, name)).filter(path => statSync(path).isFile())
    const override = overrides[`${manifest.name}@${manifest.version}`]
    if (override) {
        const path = join(root, 'legal/upstream', override.file)
        if (createHash('sha256').update(readFileSync(path)).digest('hex') !== override.sha256) {
            throw new Error(`Upstream license checksum mismatch: ${manifest.name}@${manifest.version}`)
        }
        paths.push(path)
    }
    if (!paths.length) {
        const readme = readdirSync(directory).find(name => /^readme/i.test(name))
        if (readme && /Permission is hereby granted[\s\S]+THE SOFTWARE IS PROVIDED/i.test(read(join(directory, readme)))) paths.push(join(directory, readme))
    }
    return paths.map(path => read(path).trim())
}

export function thirdPartyLicenses() {
    return {
        name: 'distribute-third-party-licenses',
        apply: 'build',
        generateBundle(_options, bundle) {
            const roots = new Set()
            for (const output of Object.values(bundle)) {
                if (output.type !== 'chunk') continue
                for (const [id, info] of Object.entries(output.modules)) {
                    if (info.renderedLength === 0) continue
                    const directory = packageRoot(id)
                    if (directory) roots.add(directory)
                }
            }
            // Font CSS and binary URL imports can be emitted solely as assets.
            for (const id of this.getModuleIds()) {
                if (!id.includes('@fontsource') && !id.includes('rawconvert-wasm/')) continue
                const directory = packageRoot(id)
                if (directory) roots.add(directory)
            }
            const overridesPath = join(root, 'legal/upstream/licenses.json')
            const overrides = existsSync(overridesPath) ? JSON.parse(read(overridesPath)) : {}
            const packages = [...roots].map(directory => {
                const manifest = JSON.parse(read(join(directory, 'package.json')))
                return { name: manifest.name, version: manifest.version, license: manifest.license, texts: licenseTexts(directory, manifest, overrides) }
            }).sort((a, b) => a.name.localeCompare(b.name))
            const missing = packages.filter(pkg => !pkg.texts.length).map(pkg => `${pkg.name}@${pkg.version}`)
            if (missing.length) this.error(`Missing distributed license text: ${missing.join(', ')}. Add version-specific upstream notices in legal/upstream.`)
            const rawManifest = JSON.parse(read(join(root, 'public/licenses/raw-decoder-build.json')))
            for (const [file, expected] of Object.entries(rawManifest.files)) {
                const actual = createHash('sha256').update(readFileSync(join(root, file))).digest('hex')
                if (actual !== expected) this.error(`RAW source/artifact checksum mismatch: ${file}. Rebuild with scripts/build-raw-decoder.py.`)
            }
            const sections = [
                'THIRD-PARTY SOFTWARE NOTICES — Ian Truong Photography',
                'These licenses apply to the identified software, not the photographs. Generated from the packages included in this website build.',
                ...packages.map(pkg => `${pkg.name} ${pkg.version}\nLicense: ${pkg.license || 'See text below'}\n\n${pkg.texts.join('\n\n')}`),
                `RAW decoder: LibRaw ${rawManifest.librawVersion}, distributed under CDDL-1.0.\nUnmodified LibRaw source: /licenses/libraw-source.tar.gz\nSite-authored adapter source: /licenses/raw-decoder-bindings.cpp\nBuild script: /licenses/build-raw-decoder.py\nCompiler, build flags and checksums: /licenses/raw-decoder-build.json\nBuild command: python3 scripts/build-raw-decoder.py (available in the site source repository).\nThe npm rawconvert-wasm JavaScript worker/wrapper is used under MIT; its prebuilt native core is replaced with the core built from these supplied sources.`,
                read(join(root, 'legal/raw-bindings-LICENSE.txt')),
                'This software is based in part on the work of the Independent JPEG Group.',
                ...readdirSync(join(root, 'legal/raw-runtime')).sort().map(name => `${name}\n\n${read(join(root, 'legal/raw-runtime', name))}`),
            ]
            const text = sections.join('\n\n' + '='.repeat(72) + '\n\n') + '\n'
            this.emitFile({ type: 'asset', fileName: 'licenses/THIRD_PARTY_NOTICES.txt', source: text })
            // Keep a snapshot available for local development as well as releases.
            const snapshot = join(root, 'public/licenses/THIRD_PARTY_NOTICES.txt')
            mkdirSync(dirname(snapshot), { recursive: true })
            if (!existsSync(snapshot) || read(snapshot) !== text) writeFileSync(snapshot, text)
            this.emitFile({ type: 'asset', fileName: 'licenses/packages.json', source: JSON.stringify(packages.map(({ name, version, license }) => ({ name, version, license })), null, 2) + '\n' })
        },
    }
}
