import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    cacheFeaturedPhotoSession,
    clearFeaturedPhotoSessionCache,
    readFeaturedPhotoSession,
} from './featuredPhotoSession'

describe('featured photo session cache', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-08-31T12:00:00Z'))
        clearFeaturedPhotoSessionCache()
    })

    afterEach(() => {
        clearFeaturedPhotoSessionCache()
        vi.useRealTimers()
    })

    it('keeps whole-site and category pools separate for five minutes', () => {
        const allPhotos = [{ id: 'all' }]
        const birdingPhotos = [{ id: 'birding' }]
        cacheFeaturedPhotoSession('', allPhotos)
        cacheFeaturedPhotoSession('Birding', birdingPhotos)

        expect(readFeaturedPhotoSession('')).toBe(allPhotos)
        expect(readFeaturedPhotoSession('Birding')).toBe(birdingPhotos)
        expect(readFeaturedPhotoSession('Hikes')).toBeNull()

        vi.advanceTimersByTime(5 * 60_000 + 1)
        expect(readFeaturedPhotoSession('')).toBeNull()
        expect(readFeaturedPhotoSession('Birding')).toBeNull()
    })
})
