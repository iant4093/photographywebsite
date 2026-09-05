import { describe, expect, it } from 'vitest'
import { reuseOriginalPreview, reuseOriginalPreviews } from './originalPreviewReuse'

const NOW = Date.UTC(2026, 8, 4, 12, 10)
const OLD_EXPIRY = Date.UTC(2026, 8, 4, 12, 30)

function photo(fresh = false) {
    const date = fresh ? '20260904T121000Z' : '20260904T120000Z'
    const candidates = [640, 1920].map(width => ({
        width,
        url: `https://originals.example.test/before/album/one/content/w${width}.webp?X-Amz-Date=${date}&X-Amz-Expires=1800&X-Amz-Signature=${fresh ? 'new' : 'old'}`,
    }))
    return {
        albumId: 'album', id: 'one', url: `https://edited.example.test/${fresh ? 'fresh' : 'old'}.webp`,
        mediaExpiresAt: OLD_EXPIRY + (fresh ? 600_000 : 0),
        before: { status: 'ready', width: 4000, height: 3000, url: candidates[1].url, srcSet: candidates, expiresAt: OLD_EXPIRY + (fresh ? 600_000 : 0) },
    }
}

describe('original preview URL reuse', () => {
    it('keeps only the prior ready descriptor and deadline after the same assets are confirmed', () => {
        const previous = photo()
        const next = photo(true)
        const result = reuseOriginalPreview(previous, next, { now: NOW })
        expect(result.before).toBe(previous.before)
        expect(result.before.expiresAt).toBe(OLD_EXPIRY)
        expect(result.mediaExpiresAt).toBe(OLD_EXPIRY)
        expect(result.url).toBe(next.url)
        expect(next.before.url).toContain('Signature=new')
        expect(previous.url).not.toBe(next.url)
    })

    it('requires unchanged media identity and an explicit common album scope', () => {
        for (const changes of [{ id: 'two' }, { albumId: 'another' }, { id: undefined }]) {
            const next = { ...photo(true), ...changes }
            expect(reuseOriginalPreview(photo(), next, { now: NOW })).toBe(next)
        }
        const previous = { ...photo(), albumId: undefined }
        const next = { ...photo(true), albumId: undefined }
        expect(reuseOriginalPreview(previous, next, { now: NOW })).toBe(next)
        expect(reuseOriginalPreview(previous, next, { now: NOW, albumId: 'album' }).before).toBe(previous.before)
        expect(reuseOriginalPreview(undefined, next, { now: NOW, albumId: 'album' })).toBe(next)
    })

    it('never retains ready data over pending, failed, unavailable or disabled comparisons', () => {
        for (const before of [{ status: 'pending' }, { status: 'failed' }, { status: 'unavailable' }, undefined, null]) {
            const next = { ...photo(true), before }
            expect(reuseOriginalPreview(photo(), next, { now: NOW })).toBe(next)
        }
        for (const status of ['pending', 'failed', 'unavailable']) {
            const next = photo(true)
            expect(reuseOriginalPreview({ ...photo(), before: { status } }, next, { now: NOW })).toBe(next)
        }
    })

    it('requires headroom on both metadata and every signed URL without extending fresh authorization', () => {
        const next = photo(true)
        for (const now of [OLD_EXPIRY - 60_000, OLD_EXPIRY, OLD_EXPIRY + 1, Number.NaN]) {
            expect(reuseOriginalPreview(photo(), next, { now })).toBe(next)
        }
        const shortMetadata = photo()
        shortMetadata.before.expiresAt = NOW + 30_000
        expect(reuseOriginalPreview(shortMetadata, next, { now: NOW })).toBe(next)
        const expiredVariant = photo()
        expiredVariant.before.srcSet[0].url = expiredVariant.before.srcSet[0].url.replace('Expires=1800', 'Expires=60')
        expect(reuseOriginalPreview(expiredVariant, next, { now: NOW })).toBe(next)
        const shorterGrant = photo(true)
        shorterGrant.before.expiresAt = OLD_EXPIRY - 1
        expect(reuseOriginalPreview(photo(), shorterGrant, { now: NOW })).toBe(shorterGrant)
    })

    it('rejects changed host, path, content query, dimensions, default asset or responsive variants', () => {
        const mutations = [
            next => { next.before.width += 1 },
            next => { next.before.height += 1 },
            next => { next.before.url = next.before.url.replace('originals.example.test', 'another.example.test') },
            next => { next.before.url = next.before.url.replace('/content/', '/new-content/') },
            next => { next.before.url += '&versionId=different' },
            next => { next.before.srcSet.pop() },
            next => { next.before.srcSet[0].width = 960 },
            next => { next.before.srcSet[0].url = next.before.srcSet[0].url.replace('w640', 'w960') },
        ]
        for (const mutate of mutations) {
            const next = photo(true)
            mutate(next)
            expect(reuseOriginalPreview(photo(), next, { now: NOW })).toBe(next)
        }
    })

    it('rejects malformed descriptors instead of attempting cache reuse', () => {
        const mutations = [
            value => { value.before.expiresAt = 'later' },
            value => { value.before.width = 0 },
            value => { value.before.height = true },
            value => { value.before.srcSet = [] },
            value => { value.before.srcSet = undefined },
            value => { value.before.url = 'not a URL' },
            value => { value.before.url = value.before.url.replace('https:', 'http:') },
            value => { value.before.url += '#fragment' },
            value => { value.before.url = value.before.url.replace('20260904T120000Z', 'invalid') },
        ]
        for (const mutate of mutations) {
            const previous = photo()
            const next = photo(true)
            mutate(previous)
            expect(reuseOriginalPreview(previous, next, { now: NOW })).toBe(next)
        }
    })

    it('preserves content-query identity despite order changes and retains only fresh array membership', () => {
        const previous = photo()
        const next = photo(true)
        previous.before.url += '&versionId=same&response-content-type=image%2Fwebp'
        next.before.url += '&response-content-type=image%2Fwebp&versionId=same'
        expect(reuseOriginalPreview(previous, next, { now: NOW }).before).toBe(previous.before)
        const repeatedOld = photo()
        const repeatedNew = photo(true)
        repeatedOld.before.url += '&versionId=one&versionId=two'
        repeatedNew.before.url += '&versionId=two&versionId=one'
        expect(reuseOriginalPreview(repeatedOld, repeatedNew, { now: NOW })).toBe(repeatedNew)
        const added = { ...photo(true), id: 'new' }
        const deleted = { ...photo(), id: 'deleted' }
        const result = reuseOriginalPreviews([previous, deleted], [added, next], { now: NOW })
        expect(result.map(image => image.id)).toEqual(['new', 'one'])
        expect(result[0]).toBe(added)
        expect(result[1].before).toBe(previous.before)
    })
})
