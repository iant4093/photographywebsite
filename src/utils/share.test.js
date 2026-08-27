import { afterEach, describe, expect, it, vi } from 'vitest'
import { sharePage, shareUrlForCurrentPage } from './share'

describe('native page sharing', () => {
    afterEach(() => {
        Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
        delete document.execCommand
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

    it('falls back to copying after a native share failure', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'share', {
            configurable: true,
            value: vi.fn().mockRejectedValue(new Error('unsupported payload')),
        })
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

        await expect(sharePage({ text: 'View this', url: 'https://example.test/photo' })).resolves.toBe('copied')
        expect(writeText).toHaveBeenCalledWith('https://example.test/photo')
    })

    it('uses the legacy copy path and rejects an unavailable page URL', async () => {
        const execute = vi.fn().mockReturnValue(true)
        Object.defineProperty(document, 'execCommand', { configurable: true, value: execute })
        await expect(sharePage({ url: 'https://example.test/legacy' })).resolves.toBe('copied')
        expect(execute).toHaveBeenCalledWith('copy')

        await expect(sharePage({ url: '' })).rejects.toThrow('shareable link')
    })

    it('builds a canonical current URL without an in-page lightbox hash', () => {
        window.history.replaceState({}, '', '/album/abc?view=public#photo-2')
        expect(shareUrlForCurrentPage()).toContain('/album/abc?view=public')
        expect(shareUrlForCurrentPage()).not.toContain('#photo-2')
    })
})
