import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import useAdminAlbumCatalog from './useAdminAlbumCatalog'
const api = vi.hoisted(() => ({ fetchAlbumsFilteredPage: vi.fn(), readCachedAlbumsPage: vi.fn() }))
vi.mock('../utils/api', () => api)
const token = vi.fn().mockResolvedValue('token')
const params = { type: 'photo', visibility: 'public', limit: 100 }
const album = (id) => ({ albumId: String(id), title: `Album ${id}`, category: id % 2 ? 'Hikes' : 'Birds', type: 'photo' })
beforeEach(() => { vi.clearAllMocks(); api.readCachedAlbumsPage.mockReturnValue(null) })
it('automatically completes more than 100 interleaved summaries and deduplicates pages', async () => {
    api.fetchAlbumsFilteredPage.mockResolvedValueOnce({ items: Array.from({ length: 100 }, (_, id) => album(id)), nextCursor: 'next' })
        .mockResolvedValueOnce({ items: [album(99), album(100), album(101)], nextCursor: null })
    const { result } = renderHook(() => useAdminAlbumCatalog(params, token))
    await waitFor(() => expect(result.current.albums).toHaveLength(102))
    expect(result.current.loadingMore).toBe(false)
    expect(api.fetchAlbumsFilteredPage).toHaveBeenLastCalledWith({ ...params, cursor: 'next' }, 'token', expect.any(Object))
})
it('retains saved edits and deletions when an older page arrives', async () => {
    let finish
    api.fetchAlbumsFilteredPage.mockResolvedValueOnce({ items: [album(1), album(2)], nextCursor: 'next' })
        .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const { result } = renderHook(() => useAdminAlbumCatalog(params, token))
    await waitFor(() => expect(result.current.albums).toHaveLength(2))
    act(() => { result.current.patch('1', { title: 'Saved' }); result.current.remove('2') })
    await act(async () => finish({ items: [album(1), album(2), album(3)], nextCursor: null }))
    expect(result.current.albums.map((item) => item.title)).toEqual(['Saved', 'Album 3'])
})
it('ignores an old scope response even if its transport ignores abort', async () => {
    let finish
    api.fetchAlbumsFilteredPage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
        .mockResolvedValue({ items: [{ ...album(4), type: 'video' }], nextCursor: null })
    const { result, rerender } = renderHook(({ options }) => useAdminAlbumCatalog(options, token), { initialProps: { options: params } })
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    rerender({ options: { ...params, type: 'video' } })
    await waitFor(() => expect(result.current.albums[0]?.albumId).toBe('4'))
    await act(async () => finish({ items: [album(1)], nextCursor: null }))
    expect(result.current.albums[0].albumId).toBe('4')
})
it('keeps partial albums and offers retry after a later page fails', async () => {
    api.fetchAlbumsFilteredPage.mockResolvedValueOnce({ items: [album(1)], nextCursor: 'next' }).mockRejectedValueOnce(new Error('Offline'))
    const { result } = renderHook(() => useAdminAlbumCatalog(params, token))
    await waitFor(() => expect(result.current.catalogError).toBe('Offline'))
    expect(result.current.albums).toHaveLength(1)
    api.fetchAlbumsFilteredPage.mockResolvedValue({ items: [album(1), album(2)], nextCursor: null })
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.albums).toHaveLength(2))
    expect(result.current.catalogError).toBe('')
})
it('continues empty pages and stops a repeated cursor', async () => {
    api.fetchAlbumsFilteredPage.mockResolvedValue({ items: [], nextCursor: 'same' })
    const { result } = renderHook(() => useAdminAlbumCatalog(params, token))
    await waitFor(() => expect(result.current.catalogError).toContain('retry'))
    expect(api.fetchAlbumsFilteredPage).toHaveBeenCalledTimes(2)
})
