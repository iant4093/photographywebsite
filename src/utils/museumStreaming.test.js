import { describe, expect, it } from 'vitest'
import {
    MUSEUM_BASE_COVER_WIDTH,
    MUSEUM_DETAIL_BLEND_SECONDS,
    museumArtworkBlend,
    museumArtworkFallbackWidths,
    museumArtworkPreviewCandidates,
    museumArtworkRequestWidth,
    museumArtworkTransitionProgress,
    museumCoverLoadAllowed,
    museumCoverUploadAllowed,
    museumPreloadPaintings,
} from './museumStreaming'

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

    it('stages a fast medium photograph before a cold close inspection', () => {
        expect(museumArtworkRequestWidth(1440, 0)).toBe(640)
        expect(museumArtworkRequestWidth(960, 256)).toBe(640)
        expect(museumArtworkRequestWidth(1440, 640)).toBe(1440)
        expect(museumArtworkRequestWidth(1440, 1440)).toBe(1440)
        expect(museumArtworkRequestWidth(640, 1440)).toBe(640)
        expect(museumArtworkRequestWidth(0, 640)).toBe(0)
    })

    it('shows the best uploaded intermediate on a revisit while a sharper image loads', () => {
        expect(museumArtworkFallbackWidths(1440)).toEqual([1440, 640, 256])
        expect(museumArtworkFallbackWidths(960)).toEqual([960, 640, 256])
        expect(museumArtworkFallbackWidths(640)).toEqual([640, 256])
        expect(museumArtworkFallbackWidths(256)).toEqual([256])
        expect(museumArtworkFallbackWidths(0)).toEqual([])
    })

    it('keeps foreground detail out of movement even after raising its queue priority', () => {
        for (const width of [640, 960, 1440]) {
            expect(museumCoverLoadAllowed({ width, priority: 9900, interactionBusy: true })).toBe(false)
            expect(museumCoverLoadAllowed({ width, priority: 9900 })).toBe(true)
            expect(museumCoverUploadAllowed({ width, priority: 9900, interactionBusy: true })).toBe(false)
        }
        expect(museumCoverLoadAllowed({ ...visibleBase, inputPending: true })).toBe(false)
        expect(museumCoverLoadAllowed(visibleBase)).toBe(true)
        expect(museumCoverLoadAllowed({ width: 256, priority: 100, interactionBusy: true })).toBe(false)
    })

    it('eases the entire quality transition without a start or end flash', () => {
        expect(museumArtworkBlend(-1)).toBe(0)
        expect(museumArtworkBlend(0)).toBe(0)
        expect(museumArtworkBlend(MUSEUM_DETAIL_BLEND_SECONDS / 2)).toBe(0.5)
        expect(museumArtworkBlend(MUSEUM_DETAIL_BLEND_SECONDS)).toBe(1)
        expect(museumArtworkBlend(100)).toBe(1)
        const blend = Array.from({ length: 101 }, (_, i) => museumArtworkBlend(MUSEUM_DETAIL_BLEND_SECONDS * i / 100))
        expect(blend.every((value, i) => !i || value >= blend[i - 1])).toBe(true)
        expect(blend[1]).toBeLessThan(0.001)
        expect(1 - blend[99]).toBeLessThan(0.001)
    })

    it('preserves reveal opacity when a sharp response arrives during the medium fade', () => {
        const beforeUpgrade = museumArtworkTransitionProgress(0.2, 0.2, 0)
        const upgradeStart = museumArtworkTransitionProgress(0, beforeUpgrade.revealElapsed, 0)
        expect(upgradeStart.opacity).toBe(beforeUpgrade.opacity)
        expect(upgradeStart.blend).toBe(0)
        const next = museumArtworkTransitionProgress(upgradeStart.elapsed, upgradeStart.revealElapsed, 0.016)
        expect(next.opacity).toBeGreaterThan(upgradeStart.opacity)
        expect(next.opacity).toBeLessThan(1)
        const resumed = museumArtworkTransitionProgress(0.2, 0.2, 10)
        expect(resumed.elapsed).toBe(0.25)
        expect(resumed.revealElapsed).toBe(0.25)
    })

    it('prepares ahead and around the near view edge, while excluding distant rear walls', () => {
        const candidate = (id, distance, facing, visible = false) => ({ painting: { id }, distance, facing, visible })
        const candidates = [
            candidate('behind', 12, -0.8),
            candidate('ahead', 23, 0.65),
            candidate('side', 7, -0.1),
            candidate('visible', 9, 0.6, true),
            candidate('too-far', 25, 0.7, true),
            candidate('invalid', NaN, 1, true),
        ]
        expect(museumArtworkPreviewCandidates(candidates).map(item => item.painting.id))
            .toEqual(['visible', 'side', 'ahead'])
        expect(museumArtworkPreviewCandidates(candidates, new Set(['too-far'])).map(item => item.painting.id))
            .toContain('too-far')
        expect(museumArtworkPreviewCandidates([candidate('released', 28, 1, true)], new Set(['released'])))
            .toEqual([])
    })

    it('holds a small selection hysteresis when adjacent rows exchange distance order', () => {
        const candidates = [
            { painting: { id: 'new' }, distance: 10, facing: 1, visible: true },
            { painting: { id: 'retained' }, distance: 10.5, facing: 1, visible: true },
        ]
        expect(museumArtworkPreviewCandidates(candidates, new Set(['retained']))[0].painting.id).toBe('retained')
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
