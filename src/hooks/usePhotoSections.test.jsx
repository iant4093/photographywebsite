import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import usePhotoSections from './usePhotoSections'

describe('photo position lookup', () => {
    it('keeps navigation within each section and follows identity through reordered/refreshed images', () => {
        const images = [
            { id: 'a', isFavorite: true }, { id: 'b' },
            { id: 'c', isFavorite: true }, { id: 'd' },
        ]
        const { result, rerender } = renderHook(({ images }) => usePhotoSections(images), { initialProps: { images } })
        act(() => result.current.openPhoto(images[0]))
        act(() => result.current.goPrev())
        expect(result.current.activeImages[result.current.lightboxIndex].id).toBe('c')
        act(() => result.current.goNext())
        expect(result.current.lightboxIndex).toBe(0)
        act(() => result.current.openPhoto(images[3]))
        rerender({ images: [{ id: 'd', url: 'fresh' }, ...images.slice(0, 3)] })
        expect(result.current.activeImages[result.current.lightboxIndex]).toEqual({ id: 'd', url: 'fresh' })
        act(() => result.current.goNext())
        expect(result.current.activeImages[result.current.lightboxIndex].id).toBe('b')
        rerender({ images: images.filter(image => image.id !== 'b') })
        expect(result.current.lightboxIndex).toBeNull()
        act(() => result.current.resetLightbox())
        expect(result.current.activeImages).toEqual([])
    })

    it('preserves first-match behavior and rebuilds when featured sections are disabled', () => {
        const images = [{ id: 'same' }, { id: 'same', isFavorite: true }, { id: 'other' }]
        const { result, rerender } = renderHook(({ enabled }) => usePhotoSections(images, enabled), { initialProps: { enabled: true } })
        act(() => result.current.openPhoto(images[0]))
        expect(result.current.activeImages).toEqual([images[1]])
        rerender({ enabled: false })
        expect(result.current.activeImages).toBe(images)
        expect(result.current.lightboxIndex).toBe(0)
    })

    it('does not revisit every photo identifier for each lightbox step', () => {
        const reads = vi.fn()
        const images = Array.from({ length: 1000 }, (_, index) => ({ get id() { reads(); return `photo-${index}` } }))
        const { result } = renderHook(() => usePhotoSections(images))
        reads.mockClear()
        act(() => result.current.openPhoto(images[500]))
        act(() => result.current.goNext())
        act(() => result.current.goPrev())
        expect(result.current.lightboxIndex).toBe(500)
        expect(reads.mock.calls.length).toBeLessThanOrEqual(6)
    })
})
