import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import usePublishedHero from './usePublishedHero'
import { fetchHeroManifest } from '../utils/mediaUrls'
import { HERO_PUBLISHED_EVENT } from '../utils/heroPublication'

vi.mock('../utils/mediaUrls', () => ({ fetchHeroManifest: vi.fn(), HERO_PUBLISHED_EVENT: 'gallery-hero-published' }))
beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('refreshes a mounted gallery on focus and on the interval, retaining a working cover while offline', async () => {
    fetchHeroManifest.mockResolvedValue({ version: 'first' })
    const { result, unmount } = renderHook(() => usePublishedHero('photo'))
    expect(result.current).toBeNull()
    await act(async () => { await vi.dynamicImportSettled() })
    expect(result.current).toMatchObject({ version: 'first', useAlias: true })
    fetchHeroManifest.mockRejectedValueOnce(new TypeError('offline'))
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(result.current).toMatchObject({ version: 'first', useAlias: true })
    fetchHeroManifest.mockResolvedValue({ version: 'second' })
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(result.current).toMatchObject({ version: 'second', useAlias: false })
    unmount()
    expect(vi.getTimerCount()).toBe(0)
})

it('isolates photo and video publications and ignores a pending response after unmount', async () => {
    let resolve
    fetchHeroManifest.mockImplementation(() => new Promise((finish) => { resolve = finish }))
    const { result, unmount } = renderHook(() => usePublishedHero('video'))
    await act(async () => { window.dispatchEvent(new CustomEvent(HERO_PUBLISHED_EVENT, { detail: { heroType: 'photo' } })) })
    expect(fetchHeroManifest).toHaveBeenCalledTimes(1)
    unmount()
    await act(async () => { resolve({ version: 'late' }) })
    expect(result.current).toBeNull()
    expect(fetchHeroManifest.mock.calls[0][0].signal.aborted).toBe(true)
})

it('refreshes its own publication and visibility restoration without overlapping fetches', async () => {
    fetchHeroManifest.mockResolvedValue({ version: 'first' })
    const { result } = renderHook(() => usePublishedHero('video'))
    await act(async () => { await vi.dynamicImportSettled() })
    fetchHeroManifest.mockResolvedValue({ version: 'published' })
    await act(async () => { window.dispatchEvent(new CustomEvent(HERO_PUBLISHED_EVENT, { detail: { heroType: 'video' } })) })
    expect(result.current.version).toBe('published')
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(fetchHeroManifest).toHaveBeenCalledTimes(2)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(fetchHeroManifest).toHaveBeenCalledTimes(3)
})


it('detects publications between route visits without reusing a stale in-document alias', async () => {
    fetchHeroManifest.mockResolvedValue({ version: 'one' })
    const first = renderHook(() => usePublishedHero('remount-test'))
    await act(async () => { await vi.dynamicImportSettled() })
    expect(first.result.current.useAlias).toBe(true)
    first.unmount()
    fetchHeroManifest.mockResolvedValue({ version: 'two' })
    const next = renderHook(() => usePublishedHero('remount-test'))
    await act(async () => { await vi.dynamicImportSettled() })
    expect(next.result.current).toMatchObject({ version: 'two', useAlias: false })
    fetchHeroManifest.mockResolvedValue({ version: 'one' })
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(next.result.current.useAlias).toBe(false)
})


it('pauses distant hero checks, refreshes before return, and still accepts publication events', async () => {
    let notify
    const observe = vi.fn(), disconnect = vi.fn()
    vi.stubGlobal('IntersectionObserver', class {
        constructor(callback, options) {
            notify = callback
            expect(options.rootMargin).toBe('600px 0px')
        }
        observe = observe
        disconnect = disconnect
    })
    const section = document.createElement('section')
    const hero = document.createElement('img')
    section.append(hero)
    const ref = { current: hero }
    fetchHeroManifest.mockResolvedValue({ version: 'initial' })
    const { result, unmount } = renderHook(() => usePublishedHero('viewport-test', ref))
    await act(async () => { await vi.dynamicImportSettled() })
    expect(observe).toHaveBeenCalledWith(section)
    expect(fetchHeroManifest).toHaveBeenCalledTimes(1)
    await act(async () => {
        notify([{ isIntersecting: false }])
        window.dispatchEvent(new Event('focus'))
        document.dispatchEvent(new Event('visibilitychange'))
        await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(fetchHeroManifest).toHaveBeenCalledTimes(1)
    fetchHeroManifest.mockResolvedValue({ version: 'published-offscreen' })
    await act(async () => window.dispatchEvent(new CustomEvent(HERO_PUBLISHED_EVENT, { detail: { heroType: 'viewport-test' } })))
    expect(result.current.version).toBe('published-offscreen')
    fetchHeroManifest.mockResolvedValue({ version: 'return' })
    await act(async () => notify([{ isIntersecting: true }]))
    expect(result.current).toMatchObject({ version: 'return', useAlias: false })
    await act(async () => {
        notify([{ isIntersecting: true }])
        await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(fetchHeroManifest).toHaveBeenCalledTimes(4)
    unmount()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
})

it('retains polling without viewport observers and does not overlap refreshes on reentry', async () => {
    let notify, finish
    vi.stubGlobal('IntersectionObserver', class {
        constructor(callback) { notify = callback }
        observe() {}
        disconnect() {}
    })
    const ref = { current: document.createElement('img') }
    fetchHeroManifest.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = renderHook(() => usePublishedHero('pending-viewport', ref))
    await act(async () => { await vi.dynamicImportSettled() })
    await act(async () => {
        notify([{ isIntersecting: false }])
        notify([{ isIntersecting: true }])
        await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(fetchHeroManifest).toHaveBeenCalledTimes(1)
    await act(async () => finish({ version: 'pending' }))
    view.unmount()
    vi.stubGlobal('IntersectionObserver', undefined)
    fetchHeroManifest.mockResolvedValue({ version: 'fallback' })
    const fallback = renderHook(() => usePublishedHero('fallback-viewport', ref))
    await act(async () => { await vi.dynamicImportSettled() })
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(fetchHeroManifest).toHaveBeenCalledTimes(4)
    fallback.unmount()
})

it('does not install background work after a route unmounts before its metadata module resolves', async () => {
    fetchHeroManifest.mockResolvedValue({ version: 'initial' })
    const view = renderHook(() => usePublishedHero('early-unmount'))
    view.unmount()
    await act(async () => { await vi.dynamicImportSettled() })
    expect(vi.getTimerCount()).toBe(0)
    expect(fetchHeroManifest.mock.calls[0][0].signal.aborted).toBe(true)
})
