import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    albumCoverPreviewSrcSet,
    albumCoverUrl,
    annotateMediaExpiry,
    cdnUrl,
    currentHeroSrcSet,
    currentHeroUrl,
    fetchHeroManifest,
    heroCoverUrl,
    heroManifestSrcSet,
    mediaDisplayUrl,
    mediaBeforeCandidates,
    mediaBeforeDisplayUrl,
    mediaBeforeSrcSet,
    mediaExpiresAt,
    mediaFileName,
    mediaHlsUrl,
    mediaId,
    mediaPreviewCandidates,
    mediaPreviewSrcSet,
    mediaThumbnailUrl,
    normalizeHeroManifest,
    resolveMediaDownloadUrl,
    signedUrlExpiresAt,
    uploadOriginalFilename,
} from './mediaUrls'

const HERO_VERSION = '0123456789abcdef0123456789abcdef'
const heroManifest = {
    schemaVersion: 1,
    version: HERO_VERSION,
    source: { width: 3000, height: 2000 },
    variants: Object.fromEntries(['avif', 'webp', 'jpeg'].map((format) => [
        format,
        [640, 1280].map((width) => ({
            width,
            height: Math.round(width * (2 / 3)),
            key: `site/hero/versions/v1/${HERO_VERSION}/hero-${width}.${format === 'jpeg' ? 'jpg' : format}`,
        })),
    ])),
}

describe('media URL compatibility', () => {
    afterEach(() => vi.unstubAllGlobals())
    it('preserves a bounded upload filename independently of storage keys', () => {
        expect(uploadOriginalFilename('C:\\camera\\DSC_0001.JPG\n')).toBe('DSC_0001.JPG')
        expect(uploadOriginalFilename('/shoot/DSC_0002.JPG')).toBe('DSC_0002.JPG')
        expect(uploadOriginalFilename('x'.repeat(300))).toHaveLength(255)
        expect(uploadOriginalFilename('../..')).toBe('')
        expect(uploadOriginalFilename(null)).toBe('')
    })

    it('supports small original previews and includes their private URL expiry on public photos', () => {
        const url = 'https://private.example/before.webp?X-Amz-Date=20260720T120000Z&X-Amz-Expires=1800'
        const media = {
            url: 'https://public.example/edited.webp',
            before: { status: 'ready', url, srcSet: [{ width: 500, url }], expiresAt: Date.UTC(2026, 6, 20, 12, 30) },
        }
        expect(mediaBeforeCandidates(media)).toEqual([{ width: 500, url }])
        expect(mediaBeforeSrcSet(media)).toBe(`${url} 500w`)
        expect(mediaBeforeDisplayUrl(media)).toBe(url)
        expect(mediaExpiresAt(media)).toBe(Date.UTC(2026, 6, 20, 12, 30))
        expect(annotateMediaExpiry(media).mediaExpiresAt).toBe(Date.UTC(2026, 6, 20, 12, 30))
        expect(mediaBeforeDisplayUrl({ before: { status: 'ready', url } })).toBe(url)
    })

    it('rejects malformed original URLs and responsive widths without falling back to edited URLs', () => {
        const before = { status: 'ready', url: 'javascript:alert(1)', srcSet: [{ width: 640, url: 'https://example.test/photo.webp, evil' }] }
        expect(mediaBeforeDisplayUrl({ before, url: 'https://example.test/edited.webp' })).toBe('')
        expect(mediaBeforeSrcSet({ before })).toBe('')
        const url = 'https://example.test/photo.webp'
        for (const widths of [[640, 640], [1921], [0], [1.5]]) {
            expect(mediaBeforeCandidates({ before: { status: 'ready', srcSet: widths.map((width) => ({ width, url })) } })).toEqual([])
        }
        expect(mediaBeforeDisplayUrl({ before: { status: 'unavailable', url } })).toBe('')
        expect(mediaExpiresAt({ before: { status: 'unavailable', expiresAt: 1800000000000 } })).toBeNull()
    })
    it('preserves absolute URLs and resolves legacy CDN keys', () => {
        expect(cdnUrl('https://example.com/signed')).toBe('https://example.com/signed')
        expect(cdnUrl('/albums/example.jpg')).toMatch(/\/albums\/example\.jpg$/)
        expect(heroCoverUrl()).toMatch(/\/site\/hero\/home$/)
        expect(currentHeroUrl('avif')).toMatch(/\/site\/hero\/current\/hero\.avif$/)
        expect(currentHeroSrcSet('webp')).toContain('/site/hero/current/hero-960.webp 960w')
        expect(currentHeroUrl('gif')).toBe('')
        expect(currentHeroSrcSet('gif')).toBe('')
    })

    it('prefers the safe API fields while retaining legacy fallbacks', () => {
        expect(albumCoverUrl({
            coverThumbnailUrl: 'https://example.com/new-cover',
            coverThumbKey: 'legacy-cover',
        })).toBe('https://example.com/new-cover')
        expect(mediaThumbnailUrl({
            thumbnailUrl: 'https://example.com/new-thumb',
            thumbKey: 'legacy-thumb',
        })).toBe('https://example.com/new-thumb')
        expect(mediaDisplayUrl({ url: 'https://example.com/view', rawKey: 'legacy-raw' }))
            .toBe('https://example.com/view')
        expect(mediaHlsUrl({ hlsUrl: 'https://example.com/stream.m3u8' }))
            .toBe('https://example.com/stream.m3u8')
    })

    it('accepts only complete immutable hero manifests and fetches without credentials', async () => {
        const normalized = normalizeHeroManifest(heroManifest)
        expect(normalized.version).toBe(HERO_VERSION)
        expect(heroManifestSrcSet(normalized, 'webp')).toContain('hero-1280.webp 1280w')
        expect(normalizeHeroManifest({ ...heroManifest, version: '../unsafe' })).toBeNull()
        expect(normalizeHeroManifest({
            ...heroManifest,
            variants: { ...heroManifest.variants, avif: [{ ...heroManifest.variants.avif[0], key: 'https://evil.test/x' }] },
        })).toBeNull()

        const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(heroManifest), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }))
        vi.stubGlobal('fetch', fetch)
        await expect(fetchHeroManifest()).resolves.toEqual(normalized)
        expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/site/hero/manifest.json'), expect.objectContaining({
            credentials: 'omit',
            cache: 'no-cache',
        }))
    })

    it('derives deterministic responsive album-cover previews only inside the album namespace', async () => {
        const albumId = '123e4567-e89b-42d3-a456-426614174000'
        const cover = cdnUrl(`albums/${albumId}/original/cover.jpg`)
        const srcSet = await albumCoverPreviewSrcSet({ albumId, coverImageUrl: cover })
        expect(srcSet).toMatch(new RegExp(`public-previews/${albumId}/v3/[a-f0-9]{24}-w640\\.webp 640w`))
        expect(srcSet).toMatch(new RegExp(`public-previews/${albumId}/v3/[a-f0-9]{24}-w960\\.webp 960w`))
        expect(srcSet).toContain('-w1440.webp 1440w')
        expect(srcSet).toContain('-w1920.webp 1920w')
        await expect(albumCoverPreviewSrcSet({ albumId, coverImageUrl: 'https://evil.test/cover.jpg' })).resolves.toBe('')
        await expect(albumCoverPreviewSrcSet({ albumId: 'not-a-uuid', coverImageUrl: cover })).resolves.toBe('')
    })

    it('uses the opaque media id for API actions and derives a friendly filename', () => {
        const media = { id: 'media-123', rawKey: 'albums/private/original.nef' }
        expect(mediaId(media)).toBe('media-123')
        expect(mediaFileName({ id: 'https://example.com/path/photo.jpg?signature=secret' }))
            .toBe('photo.jpg')
        expect(mediaFileName(null, 'photo.jpg')).toBe('photo.jpg')
    })

    it('extracts explicit expiry metadata from AWS signed display URLs only', () => {
        const signed = 'https://bucket.example/photo.jpg?X-Amz-Date=20260720T120000Z&X-Amz-Expires=600&X-Amz-Signature=test'
        const expected = Date.UTC(2026, 6, 20, 12, 10, 0)

        expect(signedUrlExpiresAt(signed)).toBe(expected)
        expect(signedUrlExpiresAt('https://cdn.example/photo.jpg')).toBeNull()
        expect(mediaExpiresAt({
            url: signed,
            downloadUrl: 'https://bucket.example/download?X-Amz-Date=20260720T120000Z&X-Amz-Expires=60',
        })).toBe(expected)
        expect(annotateMediaExpiry({ url: signed })).toEqual({ url: signed, mediaExpiresAt: expected })
    })

    it('accepts explicit ISO and epoch-second expiry metadata', () => {
        expect(mediaExpiresAt({ expiresAt: '2026-07-20T12:34:56Z' }))
            .toBe(Date.parse('2026-07-20T12:34:56Z'))
        expect(mediaExpiresAt({ expiresAt: 1_800_000_000 })).toBe(1_800_000_000_000)
    })

    it('uses only a complete validated 640w, 960w, 1440w, and 1920w preview set', () => {
        const candidates = [
            { width: 1920, url: 'https://media.example.test/photo-1920.webp' },
            { width: 640, url: 'https://media.example.test/photo-640.webp' },
            { width: 1440, url: 'https://media.example.test/photo-1440.webp' },
            { width: 960, url: 'https://media.example.test/photo-960.webp' },
        ]
        expect(mediaPreviewCandidates({ previewSrcSet: candidates })).toEqual([
            { width: 640, url: 'https://media.example.test/photo-640.webp' },
            { width: 960, url: 'https://media.example.test/photo-960.webp' },
            { width: 1440, url: 'https://media.example.test/photo-1440.webp' },
            { width: 1920, url: 'https://media.example.test/photo-1920.webp' },
        ])
        expect(mediaPreviewSrcSet({ previewSrcSet: candidates })).toBe(
            'https://media.example.test/photo-640.webp 640w, https://media.example.test/photo-960.webp 960w, https://media.example.test/photo-1440.webp 1440w, https://media.example.test/photo-1920.webp 1920w',
        )
        expect(mediaPreviewSrcSet({ previewSrcSet: [candidates[0]] })).toBe('')
        expect(mediaPreviewSrcSet({ previewSrcSet: [candidates[1], candidates[1]] })).toBe('')
        expect(mediaPreviewSrcSet({ previewSrcSet: [
            candidates[1], candidates[2], candidates[3],
            { width: 1920, url: 'javascript:alert(1)' },
        ] })).toBe('')
    })

    it('refreshes protected media before the earliest preview candidate expires', () => {
        const early = 'https://bucket.example/640.webp?X-Amz-Date=20260720T120000Z&X-Amz-Expires=300'
        const late = 'https://bucket.example/1920.webp?X-Amz-Date=20260720T120000Z&X-Amz-Expires=600'
        expect(mediaExpiresAt({
            url: late,
            previewSrcSet: [
                { width: 640, url: early },
                { width: 960, url: late },
                { width: 1440, url: late },
                { width: 1920, url: late },
            ],
        })).toBe(Date.UTC(2026, 6, 20, 12, 5, 0))
    })

    it('uses an already-authorized legacy URL only when the new endpoint is absent', async () => {
        const missingRoute = Object.assign(new Error('not found'), { status: 404 })
        await expect(resolveMediaDownloadUrl(
            () => Promise.reject(missingRoute),
            { downloadUrl: 'https://legacy.example/download' },
        )).resolves.toBe('https://legacy.example/download')

        const forbidden = Object.assign(new Error('forbidden'), { status: 403 })
        await expect(resolveMediaDownloadUrl(
            () => Promise.reject(forbidden),
            { downloadUrl: 'https://legacy.example/download' },
        )).rejects.toBe(forbidden)
    })

    it('does not use the legacy fallback for malformed successful responses', async () => {
        await expect(resolveMediaDownloadUrl(
            () => Promise.resolve({}),
            { url: 'https://legacy.example/display' },
        )).rejects.toThrow('No download URL was returned')
    })
})
