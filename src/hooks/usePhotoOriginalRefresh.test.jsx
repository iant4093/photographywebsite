import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { fetchAlbum } from '../utils/api'
import usePhotoOriginalRefresh from './usePhotoOriginalRefresh'

vi.mock('../utils/api', () => ({ fetchAlbum: vi.fn() }))

const first = { id: 'one', albumId: 'album-one', before: { status: 'pending' }, palette: ['#111111'] }
const second = { id: 'two', albumId: 'album-one', before: { status: 'pending' } }
const ready = { status: 'ready', url: 'https://media.test/original.jpg?new-signature' }

function deferred() {
    let resolve
    let reject
    const promise = new Promise((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
}

describe('usePhotoOriginalRefresh', () => {
    it('deduplicates album reads and updates only matching original descriptors without changing a deck', async () => {
        const request = deferred()
        vi.mocked(fetchAlbum).mockReturnValueOnce(request.promise)
        const images = [second, first]
        const { result } = renderHook(() => usePhotoOriginalRefresh(images))
        let refreshFirst
        let refreshSecond
        act(() => {
            refreshFirst = result.current.refreshOriginal(null, first)
            refreshSecond = result.current.refreshOriginal(null, second)
        })
        expect(fetchAlbum).toHaveBeenCalledOnce()
        expect(fetchAlbum).toHaveBeenCalledWith('album-one', null, { force: true, signal: expect.any(AbortSignal) })
        await act(async () => {
            request.resolve({ images: [{ id: 'one', before: ready }, { id: 'two', before: { status: 'unavailable' } }] })
            await Promise.all([refreshFirst, refreshSecond])
        })
        expect(result.current.images.map(image => image.id)).toEqual(['two', 'one'])
        expect(result.current.images[0].before).toEqual({ status: 'unavailable' })
        expect(result.current.images[1]).toEqual({ ...first, before: ready })
        expect(first.before).toEqual({ status: 'pending' })
        expect(images).toEqual([second, first])
    })

    it('ignores a late descriptor after its owning view receives newer photo data', async () => {
        const request = deferred()
        vi.mocked(fetchAlbum).mockReturnValueOnce(request.promise)
        const { result, rerender } = renderHook(({ images }) => usePhotoOriginalRefresh(images), { initialProps: { images: [first] } })
        let refresh
        act(() => { refresh = result.current.refreshOriginal(null, first) })
        const newer = { ...first, before: { status: 'unavailable' } }
        rerender({ images: [newer] })
        await act(async () => {
            request.resolve({ images: [{ id: 'one', before: ready }] })
            await refresh
        })
        expect(result.current.images).toEqual([newer])
    })

    it('reports missing photos and refresh failures while preserving the photo itself', async () => {
        vi.mocked(fetchAlbum).mockResolvedValueOnce({ images: [] }).mockRejectedValueOnce(new Error('Network unavailable'))
        const { result } = renderHook(() => usePhotoOriginalRefresh([first]))
        await act(async () => { await result.current.refreshOriginal(null, first) })
        expect(result.current.images[0]).toEqual({ ...first, before: { status: 'unavailable' } })
        await act(async () => {
            await expect(result.current.refreshOriginal(null, first)).rejects.toThrow('Network unavailable')
        })
        expect(result.current.images[0]).toEqual({ ...first, before: { status: 'failed' } })
    })

    it('aborts pending album reads when the discovery view unmounts', async () => {
        const request = deferred()
        vi.mocked(fetchAlbum).mockReturnValueOnce(request.promise)
        const { result, unmount } = renderHook(() => usePhotoOriginalRefresh([first]))
        let refresh
        act(() => { refresh = result.current.refreshOriginal(null, first) })
        const signal = vi.mocked(fetchAlbum).mock.lastCall[2].signal
        unmount()
        expect(signal.aborted).toBe(true)
        request.resolve({ images: [{ id: 'one', before: ready }] })
        await refresh
    })

    it('preserves an omitted descriptor when comparison has been disabled in the refreshed API', async () => {
        vi.mocked(fetchAlbum).mockResolvedValueOnce({ images: [{ id: first.id }] })
        const { result } = renderHook(() => usePhotoOriginalRefresh([first]))
        await act(async () => { await result.current.refreshOriginal(null, first) })
        expect(result.current.images[0].before).toBeUndefined()
        expect(result.current.images[0].id).toBe(first.id)
    })
})
