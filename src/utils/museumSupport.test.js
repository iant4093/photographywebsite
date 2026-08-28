import { afterEach, describe, expect, it, vi } from 'vitest'
import { supportsImmersiveGallery } from './museumSupport'

function configureBrowser({ webgl = true } = {}) {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind) => (
        webgl && (kind === 'webgl2' || kind === 'webgl') ? {} : null
    ))
}

afterEach(() => {
    vi.restoreAllMocks()
})

describe('supportsImmersiveGallery', () => {
    it('allows any screen and pointer type when WebGL is available', () => {
        configureBrowser()
        expect(supportsImmersiveGallery()).toBe(true)
    })

    it('rejects browsers without WebGL', () => {
        configureBrowser({ webgl: false })
        expect(supportsImmersiveGallery()).toBe(false)
    })
})
