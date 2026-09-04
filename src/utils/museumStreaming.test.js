import { describe, expect, it } from 'vitest'
import { MUSEUM_BASE_COVER_WIDTH, museumCoverUploadAllowed, museumPreloadPaintings } from './museumStreaming'

describe('museum artwork streaming', () => {
    const visibleBase = { width: MUSEUM_BASE_COVER_WIDTH, priority: 10000, interactionBusy: true }

    it('makes bounded photographic progress throughout an uninterrupted walk', () => {
        let lastUpload = -Infinity
        const uploads = []
        for (let now = 0; now < 2000; now += 16) {
            if (museumCoverUploadAllowed({ ...visibleBase, sinceLastUpload: now - lastUpload })) {
                uploads.push(now)
                lastUpload = now
            }
        }
        expect(uploads.length).toBeGreaterThan(10)
        expect(uploads.length).toBeLessThanOrEqual(20)
        expect(uploads.slice(1).every((time, index) => time - uploads[index] >= 100)).toBe(true)
    })

    it('keeps larger upgrades and background uploads off movement frames', () => {
        for (const width of [0, 640, 960, 1440]) {
            expect(museumCoverUploadAllowed({ ...visibleBase, width })).toBe(false)
        }
        expect(museumCoverUploadAllowed({ ...visibleBase, priority: 500 })).toBe(false)
        expect(museumCoverUploadAllowed({ ...visibleBase, inputPending: true })).toBe(false)
        expect(museumCoverUploadAllowed({ width: 1440, interactionBusy: false })).toBe(true)
    })

    it('backs off after a slow upload without starving the next preview', () => {
        expect(museumCoverUploadAllowed({ ...visibleBase, lastUploadDuration: 20, sinceLastUpload: 200 })).toBe(false)
        expect(museumCoverUploadAllowed({ ...visibleBase, lastUploadDuration: 20, sinceLastUpload: 320 })).toBe(true)
    })

    it('prepares nearby entrances before the tail of a large archive', () => {
        const room = (prefix, count) => ({ paintings: Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}` })) })
        const rooms = [room('archive', 120), room('nearby', 20), room('next', 10)]
        const jobs = museumPreloadPaintings(rooms, 32)
        expect(jobs).toHaveLength(32)
        expect(jobs.slice(8, 16).every(item => item.id.startsWith('nearby'))).toBe(true)
        expect(jobs.slice(16, 24).every(item => item.id.startsWith('next'))).toBe(true)
        expect(new Set(jobs.map(item => item.id)).size).toBe(32)
        expect(museumPreloadPaintings([room('a', 2), room('a', 2)])).toHaveLength(2)
        expect(museumPreloadPaintings([])).toEqual([])
    })
})
