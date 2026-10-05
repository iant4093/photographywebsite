import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { chooseHeroReelRendition, chooseHeroReelSource, fetchHeroReel, HERO_REEL_MEMORY_KEY, heroReelAllowed, heroStillChoice, heroStillSrcSet, heroStillUrl, normalizeHeroReel, pickHeroReelCut, rememberHeroReel } from './heroReel'
import { canPlayHlsNatively, isHlsUrl, loadHlsLibrary } from './hlsSource'

const VERSION = 'a'.repeat(24)
const rendition = (width, height) => ({
    key: `site/hero/versions/video/reel/v1/${VERSION}/reel-${width}x${height}.mp4`,
    width,
    height,
    bytes: 1000,
})
const pointer = {
    schemaVersion: 1,
    version: VERSION,
    renditions: [rendition(1920, 1080), rendition(1280, 720), rendition(608, 1080)],
}

describe('hero reel pointer', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('accepts only the exact keys the reel worker writes', () => {
        const reel = normalizeHeroReel(pointer)
        expect(reel.version).toBe(VERSION)
        expect(reel.cuts).toHaveLength(1)
        expect(reel.cuts[0].renditions.map(({ width }) => width)).toEqual([1920, 1280, 608])
        expect(reel.cuts[0].renditions[0].url).toBe(`https://media.example.invalid/site/hero/versions/video/reel/v1/${VERSION}/reel-1920x1080.mp4`)

        expect(normalizeHeroReel(null)).toBeNull()
        expect(normalizeHeroReel({ ...pointer, schemaVersion: 2 })).toBeNull()
        expect(normalizeHeroReel({ ...pointer, version: null, renditions: [] })).toBeNull()
        expect(normalizeHeroReel({ ...pointer, renditions: 'nope' })).toBeNull()
        expect(normalizeHeroReel({
            ...pointer,
            renditions: [
                { ...rendition(1920, 1080), key: 'https://evil.example/x.mp4' },
                { ...rendition(1280, 720), width: 1281 },
                { ...rendition(9000, 720) },
                { ...rendition(1280, 720), height: 0 },
                null,
                { ...rendition(1280, 720), width: '1280' },
            ],
        })).toBeNull()
    })

    it('reads every cut of a multi-cut pointer and picks one at random', () => {
        const cutRendition = (cut, width, height) => ({
            key: `site/hero/versions/video/reel/v1/${VERSION}/reel-${cut}-${width}x${height}.mp4`,
            width,
            height,
            bytes: 1,
        })
        const reel = normalizeHeroReel({
            schemaVersion: 2,
            version: VERSION,
            cuts: [
                { renditions: [cutRendition(0, 1920, 1080), cutRendition(0, 608, 1080)] },
                { renditions: [cutRendition(1, 1920, 1080)] },
                // A rendition labelled with another cut's number is rejected.
                { renditions: [cutRendition(0, 1280, 720)] },
                null,
            ],
        })
        expect(reel.cuts).toHaveLength(2)
        expect(reel.cuts[1].renditions[0].url).toContain('/reel-1-1920x1080.mp4')
        expect(pickHeroReelCut(reel, () => 0).cut).toBe(0)
        expect(pickHeroReelCut(reel, () => 0.99)).toMatchObject({ cut: 1, version: VERSION })
        expect(pickHeroReelCut(reel, () => 1).cut).toBe(1)
        expect(pickHeroReelCut(null)).toBeNull()
        expect(normalizeHeroReel({ schemaVersion: 2, version: VERSION, cuts: 'nope' })).toBeNull()
        expect(normalizeHeroReel({ schemaVersion: 3, version: VERSION, cuts: [] })).toBeNull()
    })

    it('reads adaptive cuts by their exact master playlist keys, next to older MP4 cuts', () => {
        const master = (cut, orientation) => ({ key: `site/hero/versions/video/reel/v1/${VERSION}/reel-${cut}-${orientation}.m3u8`, maxWidth: 2560, maxHeight: 1440 })
        const streams = cut => ({ landscape: master(cut, 'landscape'), portrait: master(cut, 'portrait') })
        const reel = normalizeHeroReel({
            schemaVersion: 3,
            version: VERSION,
            cuts: [
                { duration: 60, streams: streams(0) },
                { duration: 60, streams: { ...streams(1), portrait: { key: 'https://evil.example/x.m3u8' } } },
                { duration: 60, streams: { landscape: master(2, 'landscape') } },
                { duration: 60, renditions: [{ ...rendition(1920, 1080), key: `site/hero/versions/video/reel/v1/${VERSION}/reel-3-1920x1080.mp4` }] },
                { duration: 60, streams: streams(1) },
            ],
        })
        expect(reel.cuts).toHaveLength(2)
        expect(reel.cuts[0].streams).toEqual({
            landscape: `https://media.example.invalid/site/hero/versions/video/reel/v1/${VERSION}/reel-0-landscape.m3u8`,
            portrait: `https://media.example.invalid/site/hero/versions/video/reel/v1/${VERSION}/reel-0-portrait.m3u8`,
        })
        expect(reel.cuts[1].renditions[0].width).toBe(1920)
        expect(reel.cuts[1].streams).toBeUndefined()
        // Schema 2 never carries streams.
        expect(normalizeHeroReel({ schemaVersion: 2, version: VERSION, cuts: [{ streams: streams(0) }] })).toBeNull()

        const picked = pickHeroReelCut(reel, () => 0)
        expect(picked.streams.portrait).toContain('reel-0-portrait.m3u8')
        expect(chooseHeroReelSource(picked, { width: 390, height: 740 })).toBe(picked.streams.portrait)
        expect(chooseHeroReelSource(picked, { width: 1440, height: 780 })).toBe(picked.streams.landscape)
        expect(chooseHeroReelSource(picked, { width: 0, height: 780 })).toBe('')
        const older = pickHeroReelCut(reel, () => 0.99)
        expect(older.streams).toBeNull()
        expect(chooseHeroReelSource(older, { width: 1440, height: 780 })).toContain('reel-3-1920x1080.mp4')
        expect(chooseHeroReelSource({ renditions: [] }, { width: 1440, height: 780 })).toBe('')
    })

    it('remembers which cuts have stills and plays the cut whose still is showing', () => {
        const master = (cut, orientation) => ({ key: `site/hero/versions/video/reel/v1/${VERSION}/reel-${cut}-${orientation}.m3u8` })
        const cut = (index, stills) => ({ stills, streams: { landscape: master(index, 'landscape'), portrait: master(index, 'portrait') } })
        const reel = normalizeHeroReel({
            schemaVersion: 3,
            version: VERSION,
            cuts: [cut(0, true), { streams: {} }, cut(2, true), cut(3, false)],
        })
        expect(reel.cuts.map(item => [item.index, item.stills])).toEqual([[0, true], [2, true], [3, false]])

        rememberHeroReel(reel)
        expect(JSON.parse(localStorage.getItem(HERO_REEL_MEMORY_KEY))).toEqual({ version: VERSION, stills: [0, 2] })
        rememberHeroReel({ version: VERSION, cuts: [{ index: 0 }] })
        expect(localStorage.getItem(HERO_REEL_MEMORY_KEY)).toBeNull()
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
        expect(() => rememberHeroReel(reel)).not.toThrow()

        expect(pickHeroReelCut(reel, () => 0, { version: VERSION, cut: 2 }).streams.landscape).toContain('reel-2-landscape')
        // A still from another version, or a cut no longer published, falls back to random.
        expect(pickHeroReelCut(reel, () => 0, { version: 'f'.repeat(24), cut: 2 }).streams.landscape).toContain('reel-0-landscape')
        expect(pickHeroReelCut(reel, () => 0.99, { version: VERSION, cut: 1 }).streams.landscape).toContain('reel-3-landscape')

        expect(heroStillUrl(VERSION, 2)).toBe(`https://media.example.invalid/site/hero/versions/video/reel/v1/${VERSION}/still-2-1280.jpg`)
        expect(heroStillSrcSet(VERSION, 2, 'avif').split(', ')).toHaveLength(5)

        expect(heroStillChoice()).toBeNull()
        Object.assign(document.documentElement.dataset, { heroStillVersion: VERSION, heroStillCut: '2' })
        expect(heroStillChoice()).toEqual({ version: VERSION, cut: 2 })
        document.documentElement.dataset.heroStillCut = '12'
        expect(heroStillChoice()).toBeNull()
        delete document.documentElement.dataset.heroStillVersion
        delete document.documentElement.dataset.heroStillCut
        localStorage.clear()
    })

    it('recognises HLS playback support', async () => {
        expect(isHlsUrl('https://x/a.m3u8')).toBe(true)
        expect(isHlsUrl('https://x/a.m3u8?v=1')).toBe(true)
        expect(isHlsUrl('https://x/a.mp4')).toBe(false)
        expect(isHlsUrl(null)).toBe(false)
        expect(canPlayHlsNatively({ canPlayType: () => 'maybe' })).toBe(true)
        expect(canPlayHlsNatively({ canPlayType: () => '' })).toBe(false)
        expect(canPlayHlsNatively({ canPlayType: () => { throw new Error('no') } })).toBe(false)
        expect(canPlayHlsNatively(null)).toBe(false)
        const Hls = await loadHlsLibrary()
        expect(Hls === null || typeof Hls === 'function').toBe(true)
    })

    it('fetches the pointer without credentials and tolerates bad responses', async () => {
        const fetch = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify(pointer)))
            .mockResolvedValueOnce(new Response('', { status: 404 }))
            .mockResolvedValueOnce(new Response('not json'))
        vi.stubGlobal('fetch', fetch)
        await expect(fetchHeroReel()).resolves.toMatchObject({ version: VERSION })
        expect(fetch).toHaveBeenCalledWith(
            'https://media.example.invalid/site/hero/video/reel.json',
            expect.objectContaining({ credentials: 'omit', cache: 'no-cache', mode: 'cors' }),
        )
        await expect(fetchHeroReel()).resolves.toBeNull()
        await expect(fetchHeroReel()).resolves.toBeNull()
    })

    it('picks the portrait cut for phones and the smallest sufficient landscape file elsewhere', () => {
        const reel = pickHeroReelCut(normalizeHeroReel(pointer))
        expect(chooseHeroReelRendition(reel, { width: 380, height: 700, pixelRatio: 3 }).width).toBe(608)
        expect(chooseHeroReelRendition(reel, { width: 1000, height: 780, pixelRatio: 1 }).width).toBe(1280)
        expect(chooseHeroReelRendition(reel, { width: 1440, height: 780, pixelRatio: 2 }).width).toBe(1920)
        expect(chooseHeroReelRendition(reel, { width: 3000, height: 900, pixelRatio: 1 }).width).toBe(1920)
        const landscapeOnly = { renditions: reel.renditions.filter(({ width, height }) => width > height) }
        expect(chooseHeroReelRendition(landscapeOnly, { width: 380, height: 700 }).width).toBe(1280)
        expect(chooseHeroReelRendition(reel, { width: 0, height: 700 })).toBeNull()
        expect(chooseHeroReelRendition(null, { width: 10, height: 10 })).toBeNull()
    })

    it('respects reduced motion and data saving', () => {
        const original = window.matchMedia
        onTestFinished(() => { window.matchMedia = original })
        const media = (reduced) => vi.fn(() => ({ matches: reduced }))
        window.matchMedia = media(false)
        expect(heroReelAllowed()).toBe(true)
        window.matchMedia = media(true)
        expect(heroReelAllowed()).toBe(false)
        window.matchMedia = media(false)
        const connection = (value) => Object.defineProperty(navigator, 'connection', { configurable: true, value })
        connection({ saveData: true })
        expect(heroReelAllowed()).toBe(false)
        connection({ effectiveType: '2g' })
        expect(heroReelAllowed()).toBe(false)
        connection({ effectiveType: '4g' })
        expect(heroReelAllowed()).toBe(true)
        delete navigator.connection
        window.matchMedia = undefined
        expect(heroReelAllowed()).toBe(false)
    })
})
