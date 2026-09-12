import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fetchAlbum, fetchAllAlbums } from './api'
import { fetchSectionStats } from './sectionStats'
import { sectionStats } from './photoStats'

vi.mock('./api', () => ({ fetchAlbum: vi.fn(), fetchAllAlbums: vi.fn() }))
const album = (albumId, overrides = {}) => ({ albumId, category: 'Misty', visibility: 'public', type: 'photo', ...overrides })
beforeEach(() => vi.clearAllMocks())

describe('section statistics', () => {
    it('derives dates and all counts from current photos, including the manual lens', () => {
        const first = album('first', { createdAt: '2024-01-02T00:00:00Z', images: [
            { exif: { model: ' Canon R7 ', lens: ' Zoom  Lens ' } }, {},
        ] })
        const last = album('last', { createdAt: '2026-08-27T19:00:00Z', images: [
            { exif: { model: 'Canon R7', lens: 'Zoom Lens' } }, { exif: { lens: '  ' } },
        ] })
        expect(sectionStats([last, first])).toEqual({
            albumCount: 2, photoCount: 4, firstDate: '2024-01-02', lastDate: '2026-08-27',
            cameras: ['Canon R7'], lenses: [['Sirui Nightwalker 75mm T1.2', 2], ['Zoom Lens', 2]],
        })
        expect(sectionStats([first])).toMatchObject({ albumCount: 1, photoCount: 2, lastDate: '2024-01-02' })
        expect(sectionStats([])).toMatchObject({ albumCount: 0, photoCount: 0, cameras: [], lenses: [] })
        expect(sectionStats([{ createdAt: 'invalid' }]).firstDate).toBeUndefined()
    })

    it('reloads membership and details, excludes other sections, and drops revoked or moved albums', async () => {
        fetchAllAlbums.mockResolvedValue([
            album('one'), album('one'), album('gone'), album('moved'),
            album('private', { visibility: 'private' }), album('video', { type: 'video' }),
            album('other', { category: 'Birding' }), album('inactive', { status: 'deleted' }),
        ])
        fetchAlbum.mockImplementation(async id => {
            if (id === 'gone') throw { status: 404 }
            return { album: album(id, id === 'moved' ? { category: 'Birding' } : {}), images: [{}] }
        })
        const signal = new AbortController().signal
        expect(await fetchSectionStats('Misty', { signal })).toMatchObject({ albumCount: 1, photoCount: 1 })
        expect(fetchAllAlbums).toHaveBeenCalledWith({ type: 'photo', limit: 100 }, { signal, force: true })
        expect(fetchAlbum).toHaveBeenCalledTimes(3)
        expect(fetchAlbum).toHaveBeenCalledWith('one', null, { signal, force: true })

        fetchAllAlbums.mockResolvedValue([album('new')])
        fetchAlbum.mockResolvedValue({ album: album('new'), images: [{}, {}] })
        expect(await fetchSectionStats('Misty')).toMatchObject({ albumCount: 1, photoCount: 2 })
    })

    it('fails rather than presenting partial counts, and respects cancellation', async () => {
        fetchAllAlbums.mockResolvedValue([album('one')])
        fetchAlbum.mockRejectedValue(new Error('Unavailable'))
        await expect(fetchSectionStats('Misty')).rejects.toThrow('Unavailable')
        const controller = new AbortController()
        controller.abort()
        await expect(fetchSectionStats('Misty', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    })
})
