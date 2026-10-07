import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

const original = await readFile('public/theme-init.js', 'utf8')
const built = await readFile(resolve(process.env.BOOTSTRAP_BUILD_ROOT || 'dist', 'theme-init.js'), 'utf8')
assert.ok(built.length < original.length)

function observe(source, path, theme, snapshot, reel, blocked) {
    const links = [], root = { dataset: {}, style: {} }, color = {}
    const storage = values => ({ getItem(key) { if (blocked) throw new Error('Blocked storage'); return values[key] ?? null } })
    class FixedDate extends Date { static now() { return 1_800_000_000_000 } }
    runInNewContext(source, {
        Date: FixedDate, Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
        window: { location: { pathname: path }, localStorage: storage({ 'ian-photography-theme': theme, 'ian:hero-reel-stills:v1': reel }),
            sessionStorage: storage({ 'ian:public-catalog:v6:public-photos': snapshot, 'ian:public-catalog:v6:public-videos': snapshot }) },
        document: { documentElement: root, currentScript: { dataset: { mediaOrigin: 'https://media.example.invalid' } },
            querySelector: () => ({ setAttribute(key, value) { color[key] = value } }), createElement: tag => ({ tag }), head: { appendChild(link) { links.push(link) } } },
    })
    return JSON.parse(JSON.stringify({ root, color, links }))
}

let count = 0
for (const path of ['/', '/videos', '/videos/', '/album/example']) {
    for (const scenario of [
        { theme: null }, { theme: 'dark' }, { theme: 'invalid', blocked: true },
        { theme: 'dark', snapshot: JSON.stringify({ version: 6, savedAt: 1_799_999_999_000 }) },
        { snapshot: JSON.stringify({ version: 6, savedAt: 1_799_000_000_000 }), reel: JSON.stringify({ version: 'a'.repeat(24), stills: [0, 2, 4] }) },
        { snapshot: 'malformed', reel: JSON.stringify({ version: 'invalid', stills: [99] }) },
    ]) {
        const args = [path, scenario.theme, scenario.snapshot, scenario.reel, scenario.blocked]
        assert.deepEqual(observe(built, ...args), observe(original, ...args), `${path}: bootstrap behavior changed`)
        count++
    }
}
console.log(`${count} built bootstrap compatibility cases passed.`)
