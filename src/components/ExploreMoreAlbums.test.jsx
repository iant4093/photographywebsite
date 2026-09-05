import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ fetchAlbumsPage: vi.fn(), prefetchPublicAlbum: vi.fn() }))
const photoPreview = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }))
const videoPreview = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }))
const manifest = vi.hoisted(() => ({ fetchAlbumHoverManifest: vi.fn() }))

vi.mock('../utils/api', () => api)
vi.mock('../utils/albumHoverPreview', () => ({ start: photoPreview.start }))
vi.mock('../utils/albumVideoHoverPreview', () => ({ start: videoPreview.start }))
vi.mock('../utils/albumHoverManifest', () => manifest)
vi.mock('../utils/routePreload', () => ({ preloadAlbumRoute: vi.fn().mockResolvedValue() }))
vi.mock('../utils/mediaUrls', () => ({
    albumCoverUrl: (album) => album.coverImageUrl,
    albumCoverPreviewSrcSet: vi.fn().mockResolvedValue(''),
}))
vi.mock('./ProgressiveImage', () => ({ default: ({ src, alt }) => <img src={src} alt={alt} /> }))

import ExploreMoreAlbums from './ExploreMoreAlbums'
import { clearCatalogSnapshots, getCatalogSnapshot, setCatalogSnapshot } from '../utils/catalogState'

function album(albumId, overrides = {}) {
    return {
        albumId,
        title: `Album ${albumId}`,
        category: 'Travel',
        type: 'photo',
        visibility: 'public',
        coverImageUrl: `https://media.example.test/${albumId}.jpg`,
        ...overrides,
    }
}

function deferred() {
    let resolve
    const promise = new Promise((fulfill) => { resolve = fulfill })
    return { promise, resolve }
}

function view(currentAlbum, props = {}) {
    return <MemoryRouter><ExploreMoreAlbums album={currentAlbum} {...props} /></MemoryRouter>
}

function cardRoutes() {
    return screen.queryAllByRole('link').map((link) => link.getAttribute('href'))
}

describe('ExploreMoreAlbums', () => {
    beforeEach(() => {
        clearCatalogSnapshots()
        window.sessionStorage.clear()
        api.fetchAlbumsPage.mockReset()
        api.prefetchPublicAlbum.mockReset().mockResolvedValue({ images: [] })
        photoPreview.start.mockReset().mockReturnValue({ stop: photoPreview.stop })
        videoPreview.start.mockReset().mockReturnValue({ stop: videoPreview.stop })
        manifest.fetchAlbumHoverManifest.mockReset().mockResolvedValue({ images: [] })
        vi.spyOn(Math, 'random').mockReturnValue(0)
    })

    it('waits for the full paginated pool and can select albums from later pages', async () => {
        const laterPage = deferred()
        Math.random.mockReturnValue(0.999)
        const current = album('current')
        const firstPageItems = [current, album('first'), album('second'), album('third')]
        api.fetchAlbumsPage
            .mockResolvedValueOnce({ items: firstPageItems, nextCursor: 'next-page' })
            .mockReturnValueOnce(laterPage.promise)

        render(view(current))

        await waitFor(() => expect(api.fetchAlbumsPage).toHaveBeenCalledTimes(2))
        expect(api.fetchAlbumsPage).toHaveBeenNthCalledWith(1, {
            visibility: 'public', type: 'photo', limit: 100, cursor: null,
        }, { signal: expect.any(AbortSignal) })
        expect(api.fetchAlbumsPage).toHaveBeenNthCalledWith(2, {
            visibility: 'public', type: 'photo', limit: 100, cursor: 'next-page',
        }, { signal: expect.any(AbortSignal) })
        expect(screen.queryByRole('heading', { name: 'Explore more' })).not.toBeInTheDocument()
        expect(Math.random).not.toHaveBeenCalled()

        await act(async () => laterPage.resolve({ items: [album('last-page')], nextCursor: null }))

        expect(screen.getByRole('region', { name: 'Explore more' })).toBeInTheDocument()
        expect(cardRoutes()).toHaveLength(3)
        expect(cardRoutes()).toContain('/album/last-page')
        expect(cardRoutes()).not.toContain('/album/current')
        expect(getCatalogSnapshot('public-photos').items).toHaveLength(5)
        expect(getCatalogSnapshot('public-photos').nextCursor).toBeNull()
    })

    it.each([0, 1, 2, 5])('shows up to three eligible cards with %i other albums and hides an empty section', async (count) => {
        const current = album('current')
        const peers = Array.from({ length: count }, (_, index) => album(`peer-${index}`))
        setCatalogSnapshot('public-photos', {
            items: [
                current, ...peers,
                album('different-category', { category: 'Portraits' }),
                album('private', { visibility: 'private' }),
                album('deleted', { status: 'deleted' }),
                album('video', { type: 'video' }),
            ],
            nextCursor: null,
        })

        await act(async () => { render(view(current)) })

        expect(cardRoutes()).toHaveLength(Math.min(3, count))
        for (const route of cardRoutes()) expect(route).toMatch(/^\/album\/peer-/)
        expect(Boolean(screen.queryByRole('region', { name: 'Explore more' }))).toBe(count > 0)
        expect(api.fetchAlbumsPage).not.toHaveBeenCalled()
    })

    it('preserves a cache-only visit timestamp so stale catalogs are fetched again', async () => {
        const savedAt = Date.parse('2026-09-05T12:00:00Z')
        const now = vi.spyOn(Date, 'now').mockReturnValue(savedAt)
        setCatalogSnapshot('public-photos', { items: [album('cached')], nextCursor: null })
        now.mockReturnValue(savedAt + 4 * 60_000)

        const cachedVisit = render(view(album('current')))
        await screen.findByRole('link', { name: /Album cached/ })

        expect(api.fetchAlbumsPage).not.toHaveBeenCalled()
        expect(getCatalogSnapshot('public-photos').savedAt).toBe(savedAt)
        cachedVisit.unmount()
        const refreshedAt = savedAt + 6 * 60_000
        now.mockReturnValue(refreshedAt)
        expect(getCatalogSnapshot('public-photos').stale).toBe(true)
        const freshPage = deferred()
        api.fetchAlbumsPage.mockReturnValueOnce(freshPage.promise)

        render(view(album('current')))

        expect(cardRoutes()).toEqual([])
        expect(api.fetchAlbumsPage).toHaveBeenCalledOnce()
        expect(api.fetchAlbumsPage).toHaveBeenCalledWith({
            visibility: 'public', type: 'photo', limit: 100, cursor: null,
        }, { signal: expect.any(AbortSignal) })
        await act(async () => freshPage.resolve({ items: [album('fresh')], nextCursor: null }))

        expect(cardRoutes()).toEqual(['/album/fresh'])
        expect(getCatalogSnapshot('public-photos')).toMatchObject({ savedAt: refreshedAt, stale: false })
    })

    it('resumes a partial cached catalog before selecting cards', async () => {
        const laterPage = deferred()
        setCatalogSnapshot('public-photos', {
            items: [album('current'), album('cached')], nextCursor: 'cached-cursor',
        })
        api.fetchAlbumsPage.mockReturnValue(laterPage.promise)

        render(view(album('current')))

        expect(api.fetchAlbumsPage).toHaveBeenCalledWith({
            visibility: 'public', type: 'photo', limit: 100, cursor: 'cached-cursor',
        }, { signal: expect.any(AbortSignal) })
        expect(cardRoutes()).toEqual([])
        expect(Math.random).not.toHaveBeenCalled()

        await act(async () => laterPage.resolve({ items: [album('fetched')], nextCursor: null }))

        expect(cardRoutes()).toEqual(['/album/cached', '/album/fetched'])
        expect(api.fetchAlbumsPage).toHaveBeenCalledOnce()
    })

    it('keeps picks stable across parent rerenders and background catalog updates', async () => {
        const items = [album('current'), ...['one', 'two', 'three', 'four'].map((id) => album(id))]
        setCatalogSnapshot('public-photos', { items, nextCursor: null })
        const { rerender } = render(view(album('current')))
        await screen.findByRole('region', { name: 'Explore more' })
        const originalRoutes = cardRoutes()
        const randomCalls = Math.random.mock.calls.length

        setCatalogSnapshot('public-photos', { items: [...items, album('background')], nextCursor: null })
        await act(async () => { rerender(view(album('current', { title: 'Updated album title' }))) })

        expect(cardRoutes()).toEqual(originalRoutes)
        expect(Math.random).toHaveBeenCalledTimes(randomCalls)
        expect(api.fetchAlbumsPage).not.toHaveBeenCalled()
    })

    it('draws different membership on a later visit even if random draws repeat', async () => {
        setCatalogSnapshot('public-photos', {
            items: [album('current'), ...['one', 'two', 'three', 'four'].map((id) => album(id))],
            nextCursor: null,
        })
        const firstVisit = render(view(album('current')))
        await screen.findByRole('region', { name: 'Explore more' })
        const firstRoutes = cardRoutes().sort()
        firstVisit.unmount()

        render(view(album('current')))
        await screen.findByRole('region', { name: 'Explore more' })

        expect(cardRoutes()).toHaveLength(3)
        expect(cardRoutes().sort()).not.toEqual(firstRoutes)
        expect(api.fetchAlbumsPage).not.toHaveBeenCalled()
    })

    it('immediately hides old cards when the album changes and waits for its new catalog', async () => {
        const nextPage = deferred()
        api.fetchAlbumsPage
            .mockResolvedValueOnce({ items: [album('current'), album('old-peer')], nextCursor: null })
            .mockReturnValueOnce(nextPage.promise)
        const { rerender } = render(view(album('current')))
        await screen.findByRole('link', { name: /Album old-peer/ })
        const oldSignal = api.fetchAlbumsPage.mock.calls[0][1].signal
        clearCatalogSnapshots()

        rerender(view(album('new-current', { category: 'Portraits' })))

        expect(oldSignal.aborted).toBe(true)
        expect(cardRoutes()).toEqual([])
        expect(screen.queryByRole('region', { name: 'Explore more' })).not.toBeInTheDocument()
        await act(async () => nextPage.resolve({
            items: [album('new-peer', { category: 'Portraits' })], nextCursor: null,
        }))
        expect(cardRoutes()).toEqual(['/album/new-peer'])
    })

    it('aborts a pending photo request and ignores its late result after switching to video', async () => {
        const oldPage = deferred()
        const videoPage = deferred()
        api.fetchAlbumsPage.mockReturnValueOnce(oldPage.promise).mockReturnValueOnce(videoPage.promise)
        const { rerender } = render(view(album('current')))
        const photoSignal = api.fetchAlbumsPage.mock.calls[0][1].signal

        rerender(view(album('current', { type: 'video' })))

        expect(photoSignal.aborted).toBe(true)
        expect(api.fetchAlbumsPage).toHaveBeenLastCalledWith({
            visibility: 'public', type: 'video', limit: 100, cursor: null,
        }, { signal: expect.any(AbortSignal) })
        await act(async () => videoPage.resolve({ items: [album('video-peer', { type: 'video' })], nextCursor: null }))
        expect(cardRoutes()).toEqual(['/video/video-peer'])

        await act(async () => oldPage.resolve({ items: [album('stale-photo')], nextCursor: null }))

        expect(cardRoutes()).toEqual(['/video/video-peer'])
        expect(getCatalogSnapshot('public-photos')).toBeNull()
        expect(getCatalogSnapshot('public-videos').items[0].albumId).toBe('video-peer')
    })

    it('leaves the optional section hidden when the catalog fails', async () => {
        api.fetchAlbumsPage.mockRejectedValue(new Error('Catalog unavailable'))

        await act(async () => { render(view(album('current'))) })

        expect(api.fetchAlbumsPage).toHaveBeenCalledOnce()
        expect(screen.queryByRole('region', { name: 'Explore more' })).not.toBeInTheDocument()
        expect(cardRoutes()).toEqual([])
    })

    it('uses the actual photo card with its new flag, album route, and hover preview lifecycle', async () => {
        const peer = album('photo-peer', { uploadedAt: new Date().toISOString() })
        setCatalogSnapshot('public-photos', { items: [peer], nextCursor: null })
        render(view(album('current')))
        const link = await screen.findByRole('link', { name: /Album photo-peer/ })

        expect(link).toHaveAttribute('href', '/album/photo-peer')
        expect(within(link).getByLabelText('New album')).toBeInTheDocument()
        fireEvent.mouseEnter(link)
        await act(async () => { await vi.dynamicImportSettled() })

        expect(photoPreview.start).toHaveBeenCalledOnce()
        expect(videoPreview.start).not.toHaveBeenCalled()
        const options = photoPreview.start.mock.calls[0][0]
        expect(options.container).toBe(link.querySelector('.album-card-image'))
        expect(options.coverImageUrl).toBe(peer.coverImageUrl)
        await options.loadManifest()
        await options.loadDetail()
        expect(manifest.fetchAlbumHoverManifest).toHaveBeenCalledWith(peer)
        expect(api.prefetchPublicAlbum).toHaveBeenCalledWith('photo-peer')

        fireEvent.mouseLeave(link)
        expect(photoPreview.stop).toHaveBeenCalledOnce()
    })

    it('uses actual video cards with direct playback routes and desktop video previews', async () => {
        const single = album('single', { type: 'video', imageCount: 1 })
        const multiple = album('multiple', { type: 'video', imageCount: 2 })
        setCatalogSnapshot('public-videos', { items: [single, multiple], nextCursor: null })
        render(view(album('current', { type: 'video' })))
        const link = await screen.findByRole('link', { name: /Album single/ })

        expect(link).toHaveAttribute('href', '/video/single?play=1')
        expect(screen.getByRole('link', { name: /Album multiple/ })).toHaveAttribute('href', '/video/multiple')
        fireEvent.mouseEnter(link)

        expect(videoPreview.start).toHaveBeenCalledOnce()
        expect(photoPreview.start).not.toHaveBeenCalled()
        const options = videoPreview.start.mock.calls[0][0]
        expect(options.album).toEqual(single)
        expect(options.container).toBe(link.querySelector('.album-card-image'))
        await options.loadDetail()
        expect(api.prefetchPublicAlbum).toHaveBeenCalledWith('single')
        const playOverlay = link.querySelector('.album-play').parentElement
        options.onPlaybackStart()
        expect(playOverlay.style.opacity).toBe('0')

        fireEvent.mouseLeave(link)
        expect(videoPreview.stop).toHaveBeenCalledOnce()
        expect(playOverlay.style.opacity).toBe('')
    })
})
