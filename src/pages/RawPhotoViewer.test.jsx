import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ getIdToken: vi.fn() }))
const api = vi.hoisted(() => ({ fetchRawPhotoFolder: vi.fn() }))

vi.mock('../context/auth', () => ({ useAuth: () => auth }))
vi.mock('../utils/api', () => ({ fetchRawPhotoFolder: api.fetchRawPhotoFolder }))

import RawPhotoViewer from './RawPhotoViewer'
import { clearRawPhotoFolderCache, toViewerPhoto } from '../utils/rawPhotoViewer'

const ROOT = { id: 'root', name: 'Raw Photo Backup' }
const YEAR = { id: 'year-2026', name: '2026' }
const ALBUM = { id: 'album', name: 'Lake Hike 8-10' }
const THUMB = 'https://lh3.googleusercontent.com/drive-storage/token'

const rootListing = {
    folder: ROOT, path: [ROOT], isRoot: true, album: false, truncated: false,
    folders: [YEAR, { id: 'year-2025', name: '2025' }], photos: [],
}
const albumListing = {
    folder: ALBUM, path: [ROOT, YEAR, { id: 'hikes', name: 'Hikes' }, ALBUM], isRoot: false, album: true, truncated: false,
    folders: [],
    photos: [
        { id: 'one', name: '4K1A0001.JPG', thumbnail: `${THUMB}-one`, width: 4800, height: 3200 },
        { id: 'two', name: '4K1A0002.JPG', thumbnail: `${THUMB}-two` },
    ],
}

function renderAt(path) {
    return render(
        <MemoryRouter initialEntries={[path]}>
            <Routes><Route path="/admin/raw-photos" element={<RawPhotoViewer />} /></Routes>
        </MemoryRouter>,
    )
}

describe('Raw photo viewer admin page', () => {
    beforeEach(() => {
        clearRawPhotoFolderCache()
        auth.getIdToken.mockReset().mockResolvedValue('admin-token')
        api.fetchRawPhotoFolder.mockReset().mockImplementation((_token, folderId) => Promise.resolve(
            folderId === 'album' ? albumListing : rootListing,
        ))
    })

    afterEach(() => vi.useRealTimers())

    it('starts at the backup root and lists plain folder tiles', async () => {
        renderAt('/admin/raw-photos')
        expect(screen.getByRole('status')).toHaveTextContent('Loading raw photo folder')
        expect(await screen.findByRole('heading', { name: 'Raw Photo Backup' })).toBeInTheDocument()
        expect(api.fetchRawPhotoFolder).toHaveBeenCalledWith('admin-token', '', { signal: expect.any(AbortSignal) })
        expect(screen.getByText('2 folders')).toBeInTheDocument()
        expect(screen.getByText('Camera originals')).toBeInTheDocument()
        const folders = within(screen.getByRole('list', { name: 'Folders' }))
        expect(folders.getByRole('link', { name: '2026' })).toHaveAttribute('href', '/admin/raw-photos?folder=year-2026')
        expect(screen.getByRole('navigation', { name: 'Folder path' })).toHaveTextContent('Raw Photo Backup')
        expect(screen.queryByRole('img')).toBeNull()
        expect(screen.getByRole('link', { name: /Back to Dashboard/ })).toHaveAttribute('href', '/admin')
    })

    it('opens folders from tiles and returns through the cached breadcrumb', async () => {
        api.fetchRawPhotoFolder.mockImplementation((_token, folderId) => Promise.resolve(
            folderId === 'year-2026'
                ? { ...rootListing, folder: YEAR, path: [ROOT, YEAR], isRoot: false, folders: [{ id: 'hikes', name: 'Hikes' }] }
                : rootListing,
        ))
        renderAt('/admin/raw-photos')
        fireEvent.click(await screen.findByRole('link', { name: '2026' }))
        expect(await screen.findByRole('heading', { name: '2026' })).toBeInTheDocument()
        expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0 })
        expect(api.fetchRawPhotoFolder).toHaveBeenLastCalledWith('admin-token', 'year-2026', { signal: expect.any(AbortSignal) })
        const path = within(screen.getByRole('navigation', { name: 'Folder path' }))
        expect(path.getByText('2026')).toHaveAttribute('aria-current', 'page')
        fireEvent.click(path.getByRole('link', { name: 'Raw Photo Backup' }))
        expect(await screen.findByRole('heading', { name: 'Raw Photo Backup' })).toBeInTheDocument()
        expect(api.fetchRawPhotoFolder).toHaveBeenCalledTimes(2)
    })

    it('shows album folders as the shared photo grid and a viewer-only lightbox', async () => {
        renderAt('/admin/raw-photos?folder=album')
        expect(await screen.findByRole('heading', { name: 'Lake Hike 8-10' })).toBeInTheDocument()
        expect(screen.getByText('2 photos')).toBeInTheDocument()
        expect(screen.queryByRole('list', { name: 'Folders' })).toBeNull()
        const tiles = screen.getAllByRole('button', { name: /^Open item \d from Lake Hike 8-10/ })
        expect(tiles).toHaveLength(2)
        fireEvent.click(tiles[0])
        const viewer = await screen.findByRole('dialog', { name: 'Photo viewer for Lake Hike 8-10' })
        for (const name of [/Share/, /Download/, /Print/, /Favorite/, /Delete/, /cover/i]) {
            expect(within(viewer).queryByRole('button', { name })).toBeNull()
        }
        expect(within(viewer).getByText('1 / 2')).toBeInTheDocument()
        fireEvent.click(within(viewer).getByRole('button', { name: 'Next photo' }))
        expect(within(viewer).getByText('2 / 2')).toBeInTheDocument()
        fireEvent.click(within(viewer).getByRole('button', { name: /Close/ }))
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    })

    it('maps Drive thumbnails to the site responsive image contract', () => {
        expect(toViewerPhoto(albumListing.photos[0])).toEqual({
            id: 'one',
            altText: '4K1A0001.JPG',
            thumbnailUrl: `${THUMB}-one=w640`,
            url: `${THUMB}-one=w2560`,
            previewSrcSet: [640, 960, 1440, 1920].map((width) => ({ width, url: `${THUMB}-one=w${width}` })),
            width: 4800,
            height: 3200,
        })
        expect(toViewerPhoto(albumListing.photos[1])).not.toHaveProperty('width')
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
        renderAt('/admin/raw-photos')
        await screen.findByRole('heading', { name: 'Raw Photo Backup' })
        expect(api.fetchRawPhotoFolder).toHaveBeenCalledTimes(1)
        now.mockReturnValue(5_000_000 + 21 * 60 * 1000)
        renderAt('/admin/raw-photos')
        await waitFor(() => expect(api.fetchRawPhotoFolder).toHaveBeenCalledTimes(2))
        now.mockRestore()
    })

    it('explains empty and very large folders', async () => {
        api.fetchRawPhotoFolder.mockResolvedValueOnce({ ...albumListing, album: false, photos: [], truncated: true })
        renderAt('/admin/raw-photos?folder=album')
        expect(await screen.findByText('This folder has no photos.')).toBeInTheDocument()
        expect(screen.getByText('Raw photo backup')).toBeInTheDocument()
        expect(screen.getByText(/only its first 10,000 items/)).toBeInTheDocument()
        expect(screen.getByText('0 folders')).toBeInTheDocument()
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

    it('shows a safe error, retries without the cache, and aborts when unmounted', async () => {
        api.fetchRawPhotoFolder.mockRejectedValueOnce(new Error('The service is temporarily unavailable.'))
        api.fetchRawPhotoFolder.mockRejectedValueOnce(Object.assign(new Error('ignored'), { name: 'AbortError' }))
        const page = renderAt('/admin/raw-photos')
        expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable')
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
        await waitFor(() => expect(api.fetchRawPhotoFolder).toHaveBeenCalledTimes(2))
        expect(screen.getByRole('status')).toHaveTextContent('Loading raw photo folder')
        page.unmount()

        api.fetchRawPhotoFolder.mockRejectedValueOnce({})
        renderAt('/admin/raw-photos')
        expect(await screen.findByRole('alert')).toHaveTextContent('The raw photo backup could not be loaded.')
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
        expect(await screen.findByRole('heading', { name: 'Raw Photo Backup' })).toBeInTheDocument()
        const signal = api.fetchRawPhotoFolder.mock.lastCall[2].signal
        expect(signal.aborted).toBe(false)
    })
})
