import { afterEach, describe, expect, it, vi } from 'vitest'
import { sharePage, shareUrlForCurrentPage } from './share'

describe('native page sharing', () => {
    afterEach(() => {
        Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    })

    it('uses the native share sheet with a page URL', async () => {
        const share = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'share', { configurable: true, value: share })
        await expect(sharePage({ title: 'Album', url: 'https://example.test/album/1' })).resolves.toBe('shared')
        expect(share).toHaveBeenCalledWith({ title: 'Album', url: 'https://example.test/album/1' })
    })

    it('copies the link when native sharing is unavailable and treats cancellation quietly', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
        await expect(sharePage({ url: 'https://example.test/album/1' })).resolves.toBe('copied')
        expect(writeText).toHaveBeenCalledWith('https://example.test/album/1')

        Object.defineProperty(navigator, 'share', {
            configurable: true,
            value: vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError')),
        })
        await expect(sharePage({ url: 'https://example.test/album/1' })).resolves.toBe('cancelled')
    })

    it('builds a canonical current URL without an in-page lightbox hash', () => {
        window.history.replaceState({}, '', '/album/abc?view=public#photo-2')
        expect(shareUrlForCurrentPage()).toContain('/album/abc?view=public')
        expect(shareUrlForCurrentPage()).not.toContain('#photo-2')
    })
})
