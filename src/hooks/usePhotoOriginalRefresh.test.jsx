import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { requestAlbumOriginalComparison, requestSharedOriginalComparison } from '../utils/api'
import usePhotoOriginalRefresh from './usePhotoOriginalRefresh'

vi.mock('../utils/api', () => ({ requestAlbumOriginalComparison: vi.fn(), requestSharedOriginalComparison: vi.fn() }))

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
    it('fetches only the requested photo without changing the deck or other originals', async () => {
        vi.mocked(requestAlbumOriginalComparison).mockResolvedValueOnce({ before: ready })
        const unrelated = { ...first, albumId: 'another-album' }
        const { result } = renderHook(() => usePhotoOriginalRefresh([second, unrelated, first]))
        await act(async () => { await result.current.refreshOriginal(null, first) })
        expect(requestAlbumOriginalComparison).toHaveBeenCalledOnce()
        expect(requestAlbumOriginalComparison).toHaveBeenCalledWith('album-one', 'one', null, { signal: expect.any(AbortSignal) })
        expect(result.current.images).toEqual([second, unrelated, { ...first, before: ready }])
    })

    it('deduplicates concurrent requests for the same photo', async () => {
        const request = deferred()
        vi.mocked(requestAlbumOriginalComparison).mockReturnValueOnce(request.promise)
        const images = [second, first]
        const { result } = renderHook(() => usePhotoOriginalRefresh(images))
        let refreshFirst
        let refreshSecond
        act(() => {
            refreshFirst = result.current.refreshOriginal(null, first)
            refreshSecond = result.current.refreshOriginal(null, first)
        })
        expect(requestAlbumOriginalComparison).toHaveBeenCalledOnce()
        await act(async () => {
            request.resolve({ before: ready })
            await Promise.all([refreshFirst, refreshSecond])
        })
        expect(result.current.images).toEqual([second, { ...first, before: ready }])
        expect(first.before).toEqual({ status: 'pending' })
        expect(images).toEqual([second, first])
    })

    it('uses the current token and owning album for a private photo', async () => {
        vi.mocked(requestAlbumOriginalComparison).mockResolvedValueOnce({ before: ready })
        const source = { id: 'one', before: { status: 'unresolved' } }
        const getIdToken = vi.fn().mockResolvedValue('fresh-token')
        const { result } = renderHook(() => usePhotoOriginalRefresh([source], { albumId: 'private-album', getIdToken }))
        await act(async () => { await result.current.refreshOriginal(null, source) })
        expect(requestAlbumOriginalComparison).toHaveBeenCalledWith('private-album', 'one', 'fresh-token', { signal: expect.any(AbortSignal) })
        expect(result.current.images[0].before).toEqual(ready)
    })

    it('allows public comparisons when there is no logged-in session', async () => {
        vi.mocked(requestAlbumOriginalComparison).mockResolvedValueOnce({ before: ready })
        const getIdToken = vi.fn().mockRejectedValue(new Error('No active user session.'))
        const { result } = renderHook(() => usePhotoOriginalRefresh([first], { getIdToken }))
        await act(async () => { await result.current.refreshOriginal(null, first) })
        expect(requestAlbumOriginalComparison).toHaveBeenCalledWith('album-one', 'one', null, { signal: expect.any(AbortSignal) })
        expect(result.current.images[0].before).toEqual(ready)
    })

    it('uses the exact share grant for a shared photo', async () => {
        vi.mocked(requestSharedOriginalComparison).mockResolvedValueOnce({ before: ready })
        const source = { id: 'one', before: { status: 'unresolved' } }
        const { result } = renderHook(() => usePhotoOriginalRefresh([source], { albumId: 'unlisted-album', shareCode: 'share-grant' }))
        await act(async () => { await result.current.refreshOriginal(null, source) })
        expect(requestSharedOriginalComparison).toHaveBeenCalledWith('share-grant', 'one', { signal: expect.any(AbortSignal) })
        expect(requestAlbumOriginalComparison).not.toHaveBeenCalled()
        expect(result.current.images[0].before).toEqual(ready)
    })

    it('ignores a late descriptor after its owning view receives newer photo data', async () => {
        const request = deferred()
        vi.mocked(requestAlbumOriginalComparison).mockReturnValueOnce(request.promise)
        const { result, rerender } = renderHook(({ images }) => usePhotoOriginalRefresh(images), { initialProps: { images: [first] } })
        let refresh
        act(() => { refresh = result.current.refreshOriginal(null, first) })
        const newer = { ...first, before: { status: 'unavailable' } }
        rerender({ images: [newer] })
        await act(async () => {
            request.resolve({ before: ready })
            await refresh
        })
        expect(result.current.images).toEqual([newer])
    })

    it('does not attach an old response to removed or replaced photos even if their descriptor reference is unchanged', async () => {
        const request = deferred()
        vi.mocked(requestAlbumOriginalComparison).mockReturnValueOnce(request.promise)
        const { result, rerender } = renderHook(({ images }) => usePhotoOriginalRefresh(images), { initialProps: { images: [first, second] } })
        let refresh
        act(() => { refresh = result.current.refreshOriginal(null, first) })
        const replaced = { ...second, palette: ['#ffffff'] }
        rerender({ images: [replaced] })
        await act(async () => {
            request.resolve({ before: ready })
            await refresh
        })
        expect(result.current.images).toEqual([replaced])
    })

    it('reuses safe ready URLs across status refreshes but replaces the URL that failed to load', async () => {
        const now = Date.now()
        const descriptor = (issuedAt, signature) => {
            const date = new Date(issuedAt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
            const url = `https://originals.example.test/before/photo/w640.webp?X-Amz-Date=${date}&X-Amz-Expires=1800&X-Amz-Signature=${signature}`
            return { status: 'ready', url, srcSet: [{ width: 640, url }], width: 640, height: 480, expiresAt: issuedAt + 1_800_000 }
        }
        const oldBefore = descriptor(now - 60_000, 'old')
        const newBefore = descriptor(now, 'fresh')
        const source = { ...first, before: oldBefore }
        vi.mocked(requestAlbumOriginalComparison).mockResolvedValue({ before: newBefore })
        const { result } = renderHook(() => usePhotoOriginalRefresh([source]))
        await act(async () => { await result.current.refreshOriginal(null, source) })
        expect(result.current.images[0].before).toBe(oldBefore)
        await act(async () => { await result.current.refreshOriginal({ type: 'error' }, result.current.images[0]) })
        expect(result.current.images[0].before).toBe(newBefore)
        const retried = descriptor(now + 1000, 'retry')
        vi.mocked(requestAlbumOriginalComparison).mockResolvedValueOnce({ before: retried })
        await act(async () => {
            await result.current.refreshOriginal({ type: 'click' }, result.current.images[0], { reason: 'media-error' })
        })
        expect(result.current.images[0].before).toBe(retried)
    })

    it('reports missing photos and refresh failures while preserving the photo itself', async () => {
        vi.mocked(requestAlbumOriginalComparison).mockResolvedValueOnce({ before: { status: 'unavailable' } }).mockRejectedValueOnce(new Error('Network unavailable'))
        const { result } = renderHook(() => usePhotoOriginalRefresh([first]))
        await act(async () => { await result.current.refreshOriginal(null, first) })
        expect(result.current.images[0]).toEqual({ ...first, before: { status: 'unavailable' } })
        await act(async () => {
            await expect(result.current.refreshOriginal(null, first)).rejects.toThrow('Network unavailable')
        })
        expect(result.current.images[0]).toEqual({ ...first, before: { status: 'failed' } })
    })

    it('aborts pending comparison reads when the discovery view unmounts', async () => {
        const request = deferred()
        vi.mocked(requestAlbumOriginalComparison).mockReturnValueOnce(request.promise)
        const { result, unmount } = renderHook(() => usePhotoOriginalRefresh([first]))
        let refresh
        act(() => { refresh = result.current.refreshOriginal(null, first) })
        const signal = vi.mocked(requestAlbumOriginalComparison).mock.lastCall[3].signal
        unmount()
        expect(signal.aborted).toBe(true)
        request.resolve({ before: ready })
        await refresh
    })

    it('preserves an omitted descriptor when comparison has been disabled in the refreshed API', async () => {
        vi.mocked(requestAlbumOriginalComparison).mockResolvedValueOnce({ before: null })
        const { result } = renderHook(() => usePhotoOriginalRefresh([first]))
        await act(async () => { await result.current.refreshOriginal(null, first) })
        expect(result.current.images[0].before).toBeUndefined()
        expect(result.current.images[0].id).toBe(first.id)
    })
})
