import fs from 'node:fs'
import { URL as NodeURL } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
const source = fs.readFileSync(new NodeURL('../../public/service-worker.js', import.meta.url), 'utf8')
function worker({ unavailable = false, full = false } = {}) {
    const entries = new Map()
    const handlers = {}
    const href = request => new URL(typeof request === 'string' ? request : request.url, 'https://site.test').href
    const cache = {
        async put(request, response) { if (full) throw new DOMException('Full', 'QuotaExceededError'); entries.set(href(request), response) },
        async match(request) { return entries.get(href(request)) },
        async delete(request) { return entries.delete(href(request)) },
        async keys() { return [...entries.keys()].map(url => new Request(url)) },
    }
    let response = { ok: true, type: 'basic', headers: new Headers({ 'content-type': 'text/html' }), clone() { return this } }
    const context = vm.createContext({ URL, Request, Promise, Set,
        self: { location: { href: 'https://site.test/service-worker.js?v=test', origin: 'https://site.test' }, addEventListener(name, handler) { handlers[name] = handler } },
        caches: { async open() { if (unavailable) throw new Error('blocked'); return cache } },
        fetch: async () => response,
    })
    vm.runInContext(source, context)
    return { context, entries, handlers, setResponse(value) { response = value }, response }
}
describe('optional bounded offline caching', () => {
    it.each([{ full: true }, { unavailable: true }])('returns healthy network responses when cache fails: %j', async options => {
        const w = worker(options)
        const request = new Request('https://site.test/assets/app.js')
        expect(await w.context.networkFirst(request)).toBe(w.response)
        expect(await w.context.cacheFirstAsset(request)).toBe(w.response)
    })
    it('bounds navigation caches including query variants on the home route', async () => {
        const w = worker()
        for (let index = 0; index < 65; index++) await w.context.networkFirst(new Request(`https://site.test/?q=${index}`))
        expect(w.entries.size).toBe(40)
        expect(w.entries.has('https://site.test/?q=64')).toBe(true)
    })
    it('never intercepts API navigation or authorization-bearing requests', () => {
        const w = worker()
        for (const request of [{ method: 'GET', mode: 'navigate', url: 'https://site.test/api/private', headers: new Headers() },
            new Request('https://site.test/assets/a.js', { headers: { authorization: 'Bearer private' } })]) {
            w.handlers.fetch({ request, respondWith() { throw new Error('Intercepted private request') } })
        }
    })
    it('does not persist private responses or JSON navigation', async () => {
        const w = worker()
        for (const headers of [{ 'content-type': 'application/json' }, { 'content-type': 'text/html', 'cache-control': 'private, no-store' }]) {
            w.setResponse({ ...w.response, headers: new Headers(headers) })
            await w.context.networkFirst(new Request('https://site.test/'))
        }
        expect(w.entries.size).toBe(0)
    })
})
