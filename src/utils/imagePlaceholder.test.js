import { describe, expect, it, vi } from 'vitest'
import { imagePlaceholder } from './imagePlaceholder'

describe('tiny image placeholders', () => {
    it('decodes a valid hash once into a reusable tiny bitmap, without attaching a canvas', () => {
        const putImageData = vi.fn()
        const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
            createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData,
        })
        const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,small')
        const hash = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj'
        expect(imagePlaceholder(hash)).toBe('data:image/png;base64,small')
        expect(imagePlaceholder(hash)).toBe('data:image/png;base64,small')
        expect(context).toHaveBeenCalledOnce()
        expect(putImageData.mock.calls[0][0].data.length).toBe(24 * 24 * 4)
        expect(encode).toHaveBeenCalledOnce()
        expect(document.querySelector('canvas')).toBeNull()
    })

    it('keeps missing and malformed placeholders from breaking the image', () => {
        expect(imagePlaceholder('')).toBe('')
        expect(imagePlaceholder('invalid')).toBe('')
    })
})
