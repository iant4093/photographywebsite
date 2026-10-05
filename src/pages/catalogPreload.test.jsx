import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Home from './Home'
import Videos from './Videos'
import { clearApiCache } from '../utils/api'
import { clearCatalogSnapshots, setCatalogSnapshot } from '../utils/catalogState'

// Production serves the API at /api; theme-init.js cannot read Vite env.
const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api'

function themeInitLinks(pathname) {
    const links = []
    runInNewContext(readFileSync('public/theme-init.js', 'utf8'), {
        document: {
            documentElement: { dataset: {}, style: {} },
            currentScript: { dataset: {} },
            querySelector: () => null,
            createElement: () => ({}),
            head: { appendChild: link => links.push(link) },
        },
        window: { location: { pathname }, localStorage: { getItem: () => null }, sessionStorage: window.sessionStorage },
        Date,
    })
    return links.filter(link => link.as === 'fetch')
}

function themeInitHero(pathname, memory, random = 0.6) {
    const links = []
    const dataset = {}
    runInNewContext(readFileSync('public/theme-init.js', 'utf8'), {
        document: {
            documentElement: { dataset, style: {} },
            currentScript: { dataset: { mediaOrigin: 'https://media.example.test' } },
            querySelector: () => null,
            createElement: () => ({}),
            head: { appendChild: link => links.push(link) },
        },
        window: {
            location: { pathname },
            localStorage: { getItem: key => (key === 'ian:hero-reel-stills:v1' ? memory : null) },
            sessionStorage: window.sessionStorage,
        },
        Math: { ...Math, random: () => random, floor: Math.floor },
        Number,
        Array,
        JSON,
        Date,
    })
    return { image: links.find(link => link.as === 'image'), dataset }
}

it('preloads a random remembered reel cut still on the Videos page only', () => {
    const version = 'e'.repeat(24)
    const memory = JSON.stringify({ version, stills: [0, 2, 4, 'x', 9] })
    const { image, dataset } = themeInitHero('/videos', memory)
    expect(dataset).toMatchObject({ heroStillVersion: version, heroStillCut: '2' })
    expect(image.href).toBe(`https://media.example.test/site/hero/versions/video/reel/v1/${version}/still-2-960.avif`)
    expect(image.imageSrcset).toContain(`still-2-2560.avif 2560w`)

    for (const bad of [null, 'not json', JSON.stringify({ version: 'nope', stills: [0] }), JSON.stringify({ version, stills: [] })]) {
        const fallback = themeInitHero('/videos', bad)
        expect(fallback.image.href).toBe('https://media.example.test/site/hero/video/current/hero-960.avif')
        expect(fallback.dataset.heroStillCut).toBeUndefined()
    }
    const home = themeInitHero('/', memory)
    expect(home.image.href).toBe('https://media.example.test/site/hero/current/hero-960.avif')
    expect(home.dataset.heroStillCut).toBeUndefined()
})

beforeEach(() => {
    clearApiCache()
    clearCatalogSnapshots()
    sessionStorage.clear()
    window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it.each([['/', Home], ['/videos', Videos]])('preloads exactly the first catalog request on %s', async (pathname, Page) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [], nextCursor: null }), {
        headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    render(<MemoryRouter initialEntries={[pathname]}><Page /></MemoryRouter>)
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith(API_BASE))).toBe(true))
    const [url, init] = fetchMock.mock.calls.find(([candidate]) => String(candidate).startsWith(API_BASE))

    // A same-origin GET with default mode and credentials and no Authorization
    // header is what a crossorigin="anonymous" fetch preload matches.
    expect(init.method).toBeUndefined()
    expect(init.mode).toBeUndefined()
    expect(init.credentials).toBeUndefined()
    expect(init.cache).toBeUndefined()
    expect(init.headers).toEqual({})
    const [preload, ...others] = themeInitLinks(pathname)
    expect(others).toEqual([])
    expect(preload).toEqual({
        rel: 'preload',
        as: 'fetch',
        crossOrigin: 'anonymous',
        href: `/api${String(url).slice(API_BASE.length)}`,
    })
    expect(preload.href).toMatch(/^\/api\/public\/albums\?/)
})

it.each([['/', 'public-photos'], ['/videos/', 'public-videos']])('skips the hint on %s while the app would reuse its fresh tab snapshot', (pathname, key) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    setCatalogSnapshot(key, { items: [{ albumId: 'one' }], nextCursor: null })
    window.dispatchEvent(new Event('pagehide'))
    expect(themeInitLinks(pathname)).toEqual([])

    // The app refetches once its snapshot is stale.
    vi.advanceTimersByTime(5 * 60_000 + 1)
    expect(themeInitLinks(pathname)).toHaveLength(1)
})

it.each(['/album/7a6afb4d-a5f2-426d-91ba-b5245ebd189b', '/search', '/explore'])('adds no catalog hint on %s', (pathname) => {
    expect(themeInitLinks(pathname)).toEqual([])
})
