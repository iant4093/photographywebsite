import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
    cachedExploreRequest,
    clearExploreClientState,
    readExploreBrowseState,
    saveExploreBrowseScroll,
    writeExploreBrowseState,
} from './exploreState'

function photo(index = 0) {
    return {
        albumId: `album-${index}`,
        albumTitle: `Album ${index}`,
        albumCategory: 'Travel',
        mediaId: `media-${index}`,
        id: `media-${index}`,
        url: `https://media.test/${index}-full.webp`,
        thumbnailUrl: `https://media.test/${index}-thumb.webp`,
        previewSrcSet: [{ width: 640, url: `https://media.test/${index}-640.webp` }],
        width: 1920,
        height: 1280,
        blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
        palette: ['#123456'],
        exif: { model: 'Camera', gps: 'private' },
        downloadUrl: 'https://download.test/private-capability',
    }
}

describe('Explore state', () => {
    beforeEach(() => {
        vi.useRealTimers()
        clearExploreClientState()
        sessionStorage.clear()
    })

    it('deduplicates responses and prevents an invalidated in-flight request from repopulating the cache', async () => {
        let resolve
        const loader = vi.fn(() => new Promise(done => { resolve = done }))
        const first = cachedExploreRequest('/one', loader)
        const second = cachedExploreRequest('/one', loader)
        await Promise.resolve()
        expect(loader).toHaveBeenCalledTimes(1)
        clearExploreClientState()
        resolve({ value: 1 })
        await expect(Promise.all([first, second])).resolves.toEqual([{ value: 1 }, { value: 1 }])

        const replacement = vi.fn(() => Promise.resolve({ value: 2 }))
        await expect(cachedExploreRequest('/one', replacement)).resolves.toEqual({ value: 2 })
        expect(replacement).toHaveBeenCalledTimes(1)
    })

    it('expires response entries and bounds unique shuffle pages with LRU eviction', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
        const expiring = vi.fn(() => Promise.resolve('fresh'))
        await cachedExploreRequest('/expires', expiring)
        await cachedExploreRequest('/expires', expiring)
        expect(expiring).toHaveBeenCalledTimes(1)
        vi.advanceTimersByTime(5 * 60_000 + 1)
        await cachedExploreRequest('/expires', expiring)
        expect(expiring).toHaveBeenCalledTimes(2)

        const oldest = vi.fn(() => Promise.resolve('oldest'))
        await cachedExploreRequest('/page-0', oldest)
        for (let index = 1; index <= 64; index += 1) {
            await cachedExploreRequest(`/page-${index}`, () => Promise.resolve(index))
        }
        await cachedExploreRequest('/page-0', oldest)
        expect(oldest).toHaveBeenCalledTimes(2)
    })

    it('persists only allowlisted public photo fields and restores nested values by copy', () => {
        writeExploreBrowseState('time:morning', {
            items: [photo(1)],
            total: 4,
            nextCursor: 'safe-cursor',
            seed: '0123456789abcdef',
            scrollY: 320,
        })
        const restored = readExploreBrowseState('time:morning')
        expect(restored).toMatchObject({ total: 4, nextCursor: 'safe-cursor', scrollY: 320, stale: false })
        expect(restored.items[0]).not.toHaveProperty('downloadUrl')
        expect(restored.items[0].exif).toEqual({ model: 'Camera' })
        restored.items[0].exif.model = 'Changed'
        expect(readExploreBrowseState('time:morning').items[0].exif.model).toBe('Camera')
    })

    it('normalizes optional cached fields without retaining invalid private-shaped values', () => {
        const minimal = photo(2)
        delete minimal.mediaId
        delete minimal.previewSrcSet
        delete minimal.palette
        minimal.exif = null

        writeExploreBrowseState('time:afternoon', {
            items: [minimal], nextCursor: null, seed: '', scrollY: undefined,
        })
        expect(readExploreBrowseState('time:afternoon')).toMatchObject({
            scrollY: 0,
            items: [{ id: 'media-2', mediaId: 'media-2', previewSrcSet: [], exif: {} }],
        })
        expect(readExploreBrowseState('time:afternoon').items[0].palette).toBeUndefined()
        expect(() => saveExploreBrowseScroll('time:afternoon', -1)).not.toThrow()
    })

    it('uses five-minute freshness, thirty-minute expiry, and does not refresh data age on scroll', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
        writeExploreBrowseState('season:winter', { items: [photo()], nextCursor: null, seed: '', scrollY: 0 })

        vi.setSystemTime(new Date('2026-01-01T00:06:00Z'))
        saveExploreBrowseScroll('season:winter', 900)
        expect(readExploreBrowseState('season:winter')).toMatchObject({ stale: true, scrollY: 900 })

        vi.setSystemTime(new Date('2026-01-01T00:31:00Z'))
        expect(readExploreBrowseState('season:winter')).toBeNull()
    })

    it('keeps an eight-entry LRU and refuses to pair a later cursor with a truncated grid', () => {
        for (let index = 0; index < 9; index += 1) {
            writeExploreBrowseState(`time:key-${index}`, {
                items: [photo(index)], nextCursor: `cursor-${index}`, seed: '', scrollY: 0,
            })
        }
        expect(readExploreBrowseState('time:key-0')).toBeNull()
        expect(readExploreBrowseState('time:key-8')).not.toBeNull()

        const firstThreePages = Array.from({ length: 72 }, (_, index) => photo(index + 100))
        writeExploreBrowseState('season:autumn', {
            items: firstThreePages, nextCursor: 'cursor-after-72', seed: '0123456789abcdef', scrollY: 0,
        })
        writeExploreBrowseState('season:autumn', {
            items: [...firstThreePages, photo(999)], nextCursor: 'cursor-after-73', seed: '0123456789abcdef', scrollY: 0,
        })
        const restored = readExploreBrowseState('season:autumn')
        expect(restored.items).toHaveLength(72)
        expect(restored.nextCursor).toBe('cursor-after-72')
    })

    it('rejects unsafe snapshots and tolerates unavailable storage', () => {
        expect(writeExploreBrowseState('time:morning', {
            items: [{ ...photo(), url: 'http://insecure.test/photo' }], nextCursor: null, seed: '', scrollY: 0,
        })).toBeNull()
        expect(readExploreBrowseState('time:morning')).toBeNull()

        const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('full', 'QuotaExceededError')
        })
        expect(() => writeExploreBrowseState('time:night', {
            items: [photo()], nextCursor: null, seed: '', scrollY: 0,
        })).not.toThrow()
        expect(readExploreBrowseState('time:night')).not.toBeNull()
        setItem.mockRestore()
    })
})
