import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { gallerySessionSeed } from './gallerySeed'
import { warmDirectAlbum } from './albumEntry'
import { prefetchPublicAlbum } from './api'
vi.mock('./api', () => ({ prefetchPublicAlbum: vi.fn() }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each(['/', '/videos/', '/album/example', '/search', '/explore/immersive-gallery'])('preloads only the current route hero: %s', pathname => {
    const links = []
    const document = {
        documentElement: { dataset: {}, style: {} },
        currentScript: { dataset: { mediaOrigin: 'https://media.test' } },
        querySelector: () => null,
        createElement: () => ({}),
        head: { appendChild: link => links.push(link) },
    }
    runInNewContext(readFileSync('public/theme-init.js', 'utf8'), {
        document, window: { setTimeout: () => {}, addEventListener: () => {}, location: { pathname }, localStorage: { getItem: () => 'light' } },
    })
    if (pathname === '/' || pathname === '/videos/') {
        expect(links).toHaveLength(1)
        expect(links[0]).toMatchObject({ rel: 'preload', as: 'image', fetchPriority: 'high' })
        expect(links[0].href).toBe(`https://media.test/site/hero/${pathname === '/' ? '' : 'video/'}current/hero-960.avif`)
        expect(links[0].imageSrcset).toContain('2560w')
        expect(links[0].imageSizes).toContain('138svh')
    } else expect(links).toEqual([])
})

it('keeps featured selections stable for a tab session and tolerates blocked storage', () => {
    sessionStorage.clear()
    const first = gallerySessionSeed()
    expect(gallerySessionSeed()).toBe(first)
    sessionStorage.setItem('ian-photography-featured-seed', '<corrupt>')
    expect(gallerySessionSeed()).not.toBe('<corrupt>')
    vi.stubGlobal('sessionStorage', { getItem() { throw Error('blocked') }, setItem() { throw Error('blocked') } })
    vi.stubGlobal('crypto', {})
    expect(gallerySessionSeed()).toMatch(/^\d+-/)
})

it('warms only valid direct public album routes', () => {
    prefetchPublicAlbum.mockClear()
    const id = '7a6afb4d-a5f2-426d-91ba-b5245ebd189b'
    warmDirectAlbum(`/album/${id}`)
    warmDirectAlbum(`/video/${id}/`)
    for (const route of ['/admin', '/album/bad', `/sharedalbum/${id}`, `/album/${id}/edit`]) warmDirectAlbum(route)
    expect(prefetchPublicAlbum.mock.calls).toEqual([[id], [id]])
})

it('offers a manual startup retry after module failure or delay, and leaves a mounted app alone', () => {
    const retry = { hidden: true }
    let mounted = false, onError, onTimeout
    const document = {
        documentElement: { dataset: {}, style: {} }, readyState: 'complete',
        querySelector: () => null,
        getElementById: () => mounted ? null : retry,
    }
    const window = {
        location: { pathname: '/editor' }, localStorage: { getItem: () => 'light' },
        setTimeout: callback => { onTimeout = callback },
        addEventListener: (name, callback) => { if (name === 'error') onError = callback },
    }
    runInNewContext(readFileSync('public/theme-init.js', 'utf8'), { document, window })
    onError({ target: { type: 'image' } })
    expect(retry.hidden).toBe(true)
    onError({ target: { type: 'module' } })
    expect(retry.hidden).toBe(false)
    retry.hidden = true
    onTimeout()
    expect(retry.hidden).toBe(false)
    mounted = true
    retry.hidden = true
    onError({ target: window })
    onTimeout()
    expect(retry.hidden).toBe(true)
})
