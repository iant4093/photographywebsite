import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    cacheRandomPhotoSession,
    clearRandomPhotoSessionCache,
    readRandomPhotoSession,
} from './randomPhotoSession'

describe('random photo session cache', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-08-31T12:00:00Z'))
        clearRandomPhotoSessionCache()
    })

    afterEach(() => {
        clearRandomPhotoSessionCache()
        vi.useRealTimers()
    })

    it('keeps whole-site and category pools separate for five minutes', () => {
        const allPhotos = [{ id: 'all' }]
        const birdingPhotos = [{ id: 'birding' }]
        cacheRandomPhotoSession('', allPhotos)
        cacheRandomPhotoSession('Birding', birdingPhotos)

        expect(readRandomPhotoSession('')).toBe(allPhotos)
        expect(readRandomPhotoSession('Birding')).toBe(birdingPhotos)
        expect(readRandomPhotoSession('Hikes')).toBeNull()

        vi.advanceTimersByTime(5 * 60_000 + 1)
        expect(readRandomPhotoSession('')).toBeNull()
        expect(readRandomPhotoSession('Birding')).toBeNull()
    })
})
