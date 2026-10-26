import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ getIdToken: vi.fn() }))
const api = vi.hoisted(() => ({ fetchRawPhotoFolder: vi.fn() }))
const prefetch = vi.hoisted(() => ({ releases: [], prefetchPhoto: vi.fn() }))

vi.mock('../context/auth', () => ({ useAuth: () => auth }))
vi.mock('../utils/api', () => ({ fetchRawPhotoFolder: api.fetchRawPhotoFolder }))
vi.mock('../utils/viewerImageWarmup', () => ({ warmViewerImage: prefetch.prefetchPhoto }))

import RawPhotoViewer from './RawPhotoViewer'
import { clearRawPhotoFolderCache } from '../utils/rawPhotoViewer'

const ROOT = { id: 'root', name: 'Raw Photo Backup' }
const YEAR = { id: 'year-2026', name: '2026' }
const ALBUM = { id: 'album', name: 'Lake Hike 8-10' }
const THUMB = 'https://lh3.googleusercontent.com/drive-storage/token'
const LONG_NAME = 'Green Lakes, Tumalo Mountain, and Grad Pics With A Very Long Folder Name 5-26'

const rootListing = {
    folder: ROOT, path: [ROOT], isRoot: true, album: false, truncated: false,
    folders: [YEAR, { id: 'year-2025', name: '2025' }], photos: [],
}
const yearListing = {
    ...rootListing, folder: YEAR, path: [ROOT, YEAR], isRoot: false, folders: [{ id: 'hikes', name: LONG_NAME }],
}
const albumListing = {
    folder: ALBUM, path: [ROOT, YEAR, { id: 'hikes', name: 'Hikes' }, ALBUM], isRoot: false, album: true, truncated: false,
    folders: [],
    photos: [
        { id: 'one', name: '4K1A0001.JPG', thumbnail: `${THUMB}-one`, width: 4800, height: 3200 },
        { id: 'two', name: '4K1A0002.JPG', thumbnail: `${THUMB}-two`, width: 3200, height: 4800 },
        { id: 'three', name: '4K1A0003.JPG', thumbnail: `${THUMB}-three`, width: 4800, height: 3200 },
    ],
}
const listings = { '': rootListing, 'year-2026': yearListing, album: albumListing }

function BackButton() {
    const navigate = useNavigate()
    return <button type="button" onClick={() => navigate(-1)}>History back</button>
}

function renderAt(path, history) {
    return render(
        <MemoryRouter initialEntries={history || [path]} initialIndex={history ? history.length - 1 : 0}>
            <BackButton />
            <Routes><Route path="/admin/raw-photos" element={<RawPhotoViewer />} /></Routes>
        </MemoryRouter>,
    )
}

function deferred() {
    let resolve
    const promise = new Promise((done) => { resolve = done })
    return { promise, resolve }
}

describe('Raw photo viewer admin page', () => {
    beforeEach(() => {
        clearRawPhotoFolderCache()
        window.scrollTo.mockClear()
        auth.getIdToken.mockReset().mockResolvedValue('admin-token')
        api.fetchRawPhotoFolder.mockReset().mockImplementation((_token, folderId) => Promise.resolve(listings[folderId]))
        prefetch.releases = []
        prefetch.prefetchPhoto.mockReset().mockImplementation(() => {
            const release = vi.fn()
            prefetch.releases.push(release)
            return release
        })
    })

    afterEach(() => vi.useRealTimers())

    it('starts at the backup root with the album skeleton and equal plain folder tiles', async () => {
        renderAt('/admin/raw-photos')
        expect(screen.getByRole('status', { name: 'Loading album' })).toBeInTheDocument()
        expect(await screen.findByRole('heading', { name: 'Raw Photo Backup' })).toBeInTheDocument()
        expect(api.fetchRawPhotoFolder).toHaveBeenCalledWith('admin-token', '', { signal: expect.any(AbortSignal) })
        expect(screen.getByText('2 folders')).toBeInTheDocument()
        expect(screen.getByText('Camera originals')).toBeInTheDocument()
        const folders = within(screen.getByRole('list', { name: 'Folders' }))
        const tile = folders.getByRole('link', { name: '2026' })
        expect(tile).toHaveAttribute('href', '/admin/raw-photos?folder=year-2026')
        expect(tile).toHaveAttribute('title', '2026')
        expect(tile).toHaveClass('raw-photos-folder')
        expect(screen.queryByRole('img')).toBeNull()
        expect(screen.getByRole('link', { name: /Back to Dashboard/ })).toHaveAttribute('href', '/admin')
    })

    it('keeps the current folder on screen until the next one is ready, then shows it from the top', async () => {
        const nextFolder = deferred()
        api.fetchRawPhotoFolder.mockImplementation((_token, folderId) => (
            folderId === 'year-2026' ? nextFolder.promise : Promise.resolve(listings[folderId])
        ))
        const view = renderAt('/admin/raw-photos')
        fireEvent.click(await screen.findByRole('link', { name: '2026' }))
        await waitFor(() => expect(api.fetchRawPhotoFolder).toHaveBeenLastCalledWith('admin-token', 'year-2026', { signal: expect.any(AbortSignal) }))
        expect(screen.getByRole('heading', { name: 'Raw Photo Backup' })).toBeInTheDocument()
        expect(view.container.querySelector('.raw-photos-page')).toHaveAttribute('aria-busy', 'true')
        expect(view.container.querySelector('.raw-photos-content')).toHaveClass('is-pending')
        expect(window.scrollTo).not.toHaveBeenCalled()

        await act(async () => nextFolder.resolve(yearListing))
        expect(await screen.findByRole('heading', { name: '2026' })).toBeInTheDocument()
        expect(window.scrollTo).toHaveBeenCalledTimes(1)
        expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'instant' })
        expect(view.container.querySelector('.raw-photos-page')).toHaveAttribute('aria-busy', 'false')
        const longTile = screen.getByRole('link', { name: LONG_NAME })
        expect(longTile).toHaveAttribute('title', LONG_NAME)

        const path = within(screen.getByRole('navigation', { name: 'Folder path' }))
        expect(path.getByText('2026')).toHaveAttribute('aria-current', 'page')
        fireEvent.click(path.getByRole('link', { name: 'Raw Photo Backup' }))
        expect(await screen.findByRole('heading', { name: 'Raw Photo Backup' })).toBeInTheDocument()
        expect(api.fetchRawPhotoFolder).toHaveBeenCalledTimes(2)
    })

    it('leaves history navigation to the route scroll memory', async () => {
        renderAt(null, ['/admin/raw-photos', '/admin/raw-photos?folder=year-2026'])
        expect(await screen.findByRole('heading', { name: '2026' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'History back' }))
        expect(await screen.findByRole('heading', { name: 'Raw Photo Backup' })).toBeInTheDocument()
        expect(window.scrollTo).not.toHaveBeenCalled()
    })

    it('shows album folders as the shared photo grid and a viewer-only lightbox', async () => {
        renderAt('/admin/raw-photos?folder=album')
        expect(await screen.findByRole('heading', { name: 'Lake Hike 8-10' })).toBeInTheDocument()
        expect(screen.getByText('3 photos')).toBeInTheDocument()
        expect(screen.queryByText('Raw photo backup')).toBeNull()
        expect(screen.queryByRole('list', { name: 'Folders' })).toBeNull()
        const tiles = screen.getAllByRole('button', { name: /^Open item \d from Lake Hike 8-10/ })
        expect(tiles).toHaveLength(3)
        expect(tiles[0]).toHaveAttribute('data-page-scroll-media')
        fireEvent.click(tiles[0])
        const viewer = await screen.findByRole('dialog', { name: 'Photo viewer for Lake Hike 8-10' })
        for (const name of [/Share/, /Download/, /Print/, /Favorite/, /Delete/, /cover/i]) {
            expect(within(viewer).queryByRole('button', { name })).toBeNull()
        }
        expect(within(viewer).getByText('1 / 3')).toBeInTheDocument()
        fireEvent.click(within(viewer).getByRole('button', { name: 'Next photo' }))
        expect(within(viewer).getByText('2 / 3')).toBeInTheDocument()
        fireEvent.click(within(viewer).getByRole('button', { name: /Close/ }))
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    })

    it('warms viewer-size images on intent and around the open photo', async () => {
        renderAt('/admin/raw-photos?folder=album')
        await screen.findByRole('heading', { name: 'Lake Hike 8-10' })
        const tiles = screen.getAllByRole('button', { name: /^Open item \d from Lake Hike 8-10/ })
        const prefetchedIds = () => prefetch.prefetchPhoto.mock.calls.map(([photo]) => photo.id)

        vi.useFakeTimers()
        fireEvent.pointerEnter(tiles[1])
        fireEvent.pointerEnter(tiles[2])
        act(() => vi.advanceTimersByTime(119))
        expect(prefetch.prefetchPhoto).not.toHaveBeenCalled()
        act(() => vi.advanceTimersByTime(1))
        expect(prefetchedIds()).toEqual(['three'])
        expect(prefetch.prefetchPhoto.mock.calls[0][1]).toBeGreaterThan(0)
        vi.useRealTimers()

        fireEvent.focus(tiles[0])
        expect(prefetchedIds()).toEqual(['three', 'one'])
        expect(prefetch.releases[0]).toHaveBeenCalledOnce()

        fireEvent.click(tiles[0])
        await screen.findByRole('dialog')
        await waitFor(() => expect(prefetchedIds()).toEqual(['three', 'one', 'two', 'three']))
        expect(prefetch.releases[1]).not.toHaveBeenCalled()

        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Close/ }))
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
        expect(prefetch.releases.slice(1).every(release => release.mock.calls.length === 1)).toBe(true)
    })

    it('refreshes expired image links once without reloading the page', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
        renderAt('/admin/raw-photos?folder=album')
        await screen.findByRole('heading', { name: 'Lake Hike 8-10' })
        const image = () => screen.getAllByAltText('4K1A0001.JPG')[0]
        fireEvent.error(image())
        fireEvent.error(image())
        await waitFor(() => expect(api.fetchRawPhotoFolder).toHaveBeenCalledTimes(2))
        expect(screen.getByRole('heading', { name: 'Lake Hike 8-10' })).toBeInTheDocument()
        expect(window.scrollTo).not.toHaveBeenCalled()
        fireEvent.error(image())
        fireEvent.error(image())
        expect(api.fetchRawPhotoFolder).toHaveBeenCalledTimes(2)
        now.mockReturnValue(1_000_000 + 61_000)
        fireEvent.error(image())
        fireEvent.error(image())
        await waitFor(() => expect(api.fetchRawPhotoFolder).toHaveBeenCalledTimes(3))
        now.mockRestore()
    })

    it('expires cached listings so stale image links are not reused', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(5_000_000)
        const first = renderAt('/admin/raw-photos')
        await screen.findByRole('heading', { name: 'Raw Photo Backup' })
        first.unmount()
        const second = renderAt('/admin/raw-photos')
        await screen.findByRole('heading', { name: 'Raw Photo Backup' })
        expect(api.fetchRawPhotoFolder).toHaveBeenCalledTimes(1)
        second.unmount()
        now.mockReturnValue(5_000_000 + 21 * 60 * 1000)
        renderAt('/admin/raw-photos')
        await waitFor(() => expect(api.fetchRawPhotoFolder).toHaveBeenCalledTimes(2))
        now.mockRestore()
    })

    it('explains empty and very large folders', async () => {
        api.fetchRawPhotoFolder.mockResolvedValueOnce({ ...albumListing, album: false, photos: [], truncated: true })
        renderAt('/admin/raw-photos?folder=album')
        expect(await screen.findByText('This folder has no photos.')).toBeInTheDocument()
        expect(screen.getByText(/only its first 10,000 items/)).toBeInTheDocument()
        expect(screen.getByText('0 folders')).toBeInTheDocument()
        expect(screen.getByText('Raw photo backup')).toBeInTheDocument()
    })

    it('labels single folders and photos and folders that also hold loose photos', async () => {
        api.fetchRawPhotoFolder.mockResolvedValueOnce({
            ...albumListing, album: false, folders: [{ id: 'nested', name: 'Edits' }], photos: [albumListing.photos[0]],
        })
        renderAt('/admin/raw-photos?folder=album')
        expect(await screen.findByText('1 photo')).toBeInTheDocument()
        expect(screen.queryByText('Raw photo backup')).toBeNull()
        expect(screen.getByRole('link', { name: 'Edits' })).toHaveAttribute('href', '/admin/raw-photos?folder=nested')
        expect(screen.getAllByRole('button', { name: /^Open item 1 from Lake Hike 8-10/ })).toHaveLength(1)
    })

    it('shows a safe error, retries without the cache, and ignores aborted requests', async () => {
        api.fetchRawPhotoFolder.mockRejectedValueOnce(new Error('The service is temporarily unavailable.'))
        api.fetchRawPhotoFolder.mockRejectedValueOnce(Object.assign(new Error('ignored'), { name: 'AbortError' }))
        const page = renderAt('/admin/raw-photos')
        expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable')
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
        await waitFor(() => expect(api.fetchRawPhotoFolder).toHaveBeenCalledTimes(2))
        expect(screen.getByRole('status', { name: 'Loading album' })).toBeInTheDocument()
        page.unmount()

        api.fetchRawPhotoFolder.mockRejectedValueOnce({})
        renderAt('/admin/raw-photos')
        expect(await screen.findByRole('alert')).toHaveTextContent('The raw photo backup could not be loaded.')
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
        expect(await screen.findByRole('heading', { name: 'Raw Photo Backup' })).toBeInTheDocument()
    })
})
