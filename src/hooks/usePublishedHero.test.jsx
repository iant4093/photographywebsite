import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import usePublishedHero from './usePublishedHero'
import { fetchHeroManifest } from '../utils/mediaUrls'
import { HERO_PUBLISHED_EVENT } from '../utils/heroPublication'

vi.mock('../utils/mediaUrls', () => ({ fetchHeroManifest: vi.fn(), HERO_PUBLISHED_EVENT: 'gallery-hero-published' }))
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('refreshes a mounted gallery on focus and on the interval, retaining a working cover while offline', async () => {
    fetchHeroManifest.mockResolvedValue({ version: 'first' })
    const { result, unmount } = renderHook(() => usePublishedHero('photo'))
    expect(result.current).toBeNull()
    await act(async () => {})
    expect(result.current.version).toBe('first')
    fetchHeroManifest.mockRejectedValueOnce(new TypeError('offline'))
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(result.current.version).toBe('first')
    fetchHeroManifest.mockResolvedValue({ version: 'second' })
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(result.current.version).toBe('second')
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
    await act(async () => {})
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
