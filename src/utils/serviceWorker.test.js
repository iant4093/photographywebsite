import fs from 'node:fs'
import { URL as NodeURL } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
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
    const context = vm.createContext({ URL, Request, Promise, Set, setTimeout, clearTimeout,
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
    it('uses the cached shell on transient server errors and stalled requests', async () => {
        vi.useFakeTimers()
        try {
            const w = worker()
            const cached = w.response
            w.entries.set('https://site.test/index.html', cached)
            w.setResponse({ ...cached, ok: false, status: 503 })
            expect(await w.context.networkFirst(new Request('https://site.test/contact'))).toBe(cached)
            w.context.fetch = () => new Promise(() => {})
            const pending = w.context.networkFirst(new Request('https://site.test/contact'))
            await vi.advanceTimersByTimeAsync(4000)
            expect(await pending).toBe(cached)
        } finally { vi.useRealTimers() }
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
    it('caches only successful responses whose content type is HTML', async () => {
        const w = worker()
        const cases = [
            ['https://site.test/gallery', { ok: true, type: 'text/html; charset=utf-8' }],
            ['https://site.test/json', { ok: true, type: 'application/json; charset=utf-8' }],
            ['https://site.test/embedded', { ok: true, type: 'application/json; profile="text/html"' }],
            ['https://site.test/missing', { ok: false, status: 404, type: 'text/html' }],
        ]
        for (const [url, { ok, status = 200, type }] of cases) {
            w.setResponse({ ...w.response, ok, status, headers: new Headers({ 'content-type': type }) })
            await w.context.networkFirst(new Request(url))
        }
        expect([...w.entries.keys()]).toEqual(['https://site.test/gallery'])
    })
    it('handles HTML navigations but leaves every /api request to the network', () => {
        const w = worker()
        const handled = []
        const dispatch = request => w.handlers.fetch({ request, respondWith: () => handled.push(request.url) })
        dispatch({ method: 'GET', mode: 'navigate', url: 'https://site.test/album/one', headers: new Headers() })
        for (const url of ['https://site.test/api', 'https://site.test/api/public/albums', 'https://site.test/api/albums/one']) {
            dispatch({ method: 'GET', mode: 'navigate', url, headers: new Headers() })
            dispatch({ method: 'GET', mode: 'cors', url, headers: new Headers() })
        }
        expect(handled).toEqual(['https://site.test/album/one'])
    })
    it('leaves signed-cookie /private-media requests, including navigations, to the network', () => {
        const w = worker()
        const handled = []
        const dispatch = request => w.handlers.fetch({ request, respondWith: () => handled.push(request.url) })
        const base = 'https://site.test/private-media/albums/a1'
        for (const url of [`${base}/preview/v3/p-960.webp`, `${base}/hls/master.m3u8`, `${base}/hls/segment-001.ts`]) {
            dispatch({ method: 'GET', mode: 'no-cors', url, headers: new Headers() })
            dispatch({ method: 'GET', mode: 'cors', url, headers: new Headers() })
            dispatch({ method: 'GET', mode: 'navigate', url, headers: new Headers() })
        }
        expect(handled).toEqual([])
    })
})
