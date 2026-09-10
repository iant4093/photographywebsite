import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureImageSnapshot, releaseImageSnapshot, touchImageSnapshot, MAX_IMAGE_SNAPSHOTS, SNAPSHOT_EDGE } from './imageSnapshot'

describe('bounded recognizable image snapshots', () => {
    let containers, draw
    const photo = { naturalWidth: 1920, naturalHeight: 1280 }
    const container = () => { const node = document.createElement('div'); containers.push(node); return node }
    beforeEach(() => {
        containers = []
        draw = vi.fn()
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw })
    })
    afterEach(() => { containers.forEach(releaseImageSnapshot); vi.restoreAllMocks() })

    it('retains recognizable pixels at a small fixed resolution without exporting cross-origin pixels', () => {
        const target = container()
        const exportPixels = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => { throw Error('tainted') })
        captureImageSnapshot(target, photo)
        const canvas = target.firstElementChild
        expect(canvas.width).toBe(SNAPSHOT_EDGE)
        expect(canvas.height).toBe(128)
        expect(draw).toHaveBeenCalledExactlyOnceWith(photo, 0, 0, 192, 128)
        expect(canvas.getAttribute('aria-hidden')).toBe('true')
        expect(exportPixels).not.toHaveBeenCalled()
        captureImageSnapshot(target, photo)
        expect(draw).toHaveBeenCalledOnce()
        releaseImageSnapshot(target)
        expect(target.children).toHaveLength(0)
        expect(canvas.width * canvas.height).toBe(0)
    })

    it('caps retained backing surfaces and protects a recently revisited preview', () => {
        const list = Array.from({ length: MAX_IMAGE_SNAPSHOTS }, container)
        list.forEach(target => captureImageSnapshot(target, photo))
        touchImageSnapshot(list[0])
        captureImageSnapshot(container(), photo)
        expect(list[0].children).toHaveLength(1)
        expect(list[1].children).toHaveLength(0)
        expect(containers.reduce((sum, target) => sum + target.children.length, 0)).toBe(MAX_IMAGE_SNAPSHOTS)
        expect(containers.reduce((sum, target) => sum + (target.firstElementChild?.width || 0) * (target.firstElementChild?.height || 0) * 4, 0))
            .toBeLessThanOrEqual(MAX_IMAGE_SNAPSHOTS * SNAPSHOT_EDGE * SNAPSHOT_EDGE * 4)
    })

    it('preserves portrait proportions and leaves the blur fallback usable when drawing fails', () => {
        const target = container()
        captureImageSnapshot(target, { naturalWidth: 1000, naturalHeight: 2000 })
        expect(target.firstElementChild.width).toBe(96)
        expect(target.firstElementChild.height).toBe(192)
        releaseImageSnapshot(target)
        draw.mockImplementation(() => { throw Error('unavailable') })
        expect(() => captureImageSnapshot(target, photo)).not.toThrow()
        expect(target.children).toHaveLength(0)
        captureImageSnapshot(target, { naturalWidth: 0, naturalHeight: 0 })
        expect(target.children).toHaveLength(0)
        touchImageSnapshot(target)
    })
})
