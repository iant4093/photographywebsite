import { afterEach, describe, expect, it, vi } from 'vitest'
import { supportsImmersiveGallery } from './museumSupport'

const originalInnerWidth = window.innerWidth
const originalMatchMedia = window.matchMedia

function configureBrowser({ width = 1280, finePointer = true, webgl = true } = {}) {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    window.matchMedia = vi.fn().mockReturnValue({
        matches: finePointer,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind) => (
        webgl && (kind === 'webgl2' || kind === 'webgl') ? {} : null
    ))
}

afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
    window.matchMedia = originalMatchMedia
})

describe('supportsImmersiveGallery', () => {
    it('allows a desktop with a fine pointer and WebGL', () => {
        configureBrowser()
        expect(supportsImmersiveGallery()).toBe(true)
    })

    it('rejects narrow, touch-only, and non-WebGL browsers', () => {
        configureBrowser({ width: 720 })
        expect(supportsImmersiveGallery()).toBe(false)

        configureBrowser({ finePointer: false })
        expect(supportsImmersiveGallery()).toBe(false)

        configureBrowser({ webgl: false })
        expect(supportsImmersiveGallery()).toBe(false)
    })
})
