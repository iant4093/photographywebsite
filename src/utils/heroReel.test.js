import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { chooseHeroReelRendition, fetchHeroReel, heroReelAllowed, normalizeHeroReel } from './heroReel'

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
        expect(reel.renditions.map(({ width }) => width)).toEqual([1920, 1280, 608])
        expect(reel.renditions[0].url).toBe(`https://media.example.invalid/site/hero/versions/video/reel/v1/${VERSION}/reel-1920x1080.mp4`)

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
        const reel = normalizeHeroReel(pointer)
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
