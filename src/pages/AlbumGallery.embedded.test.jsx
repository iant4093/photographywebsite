import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
    fetchAlbum: vi.fn(),
    requestAlbumMediaDownload: vi.fn(),
    requestAlbumPrintSession: vi.fn(),
    requestAlbumZip: vi.fn(),
}))
const auth = vi.hoisted(() => ({ getIdToken: vi.fn() }))
const scroll = vi.hoisted(() => ({ restore: vi.fn() }))
const expiry = vi.hoisted(() => ({ hook: vi.fn(), refresh: vi.fn() }))
const share = vi.hoisted(() => ({ page: vi.fn() }))
const zip = vi.hoisted(() => ({ pollZipJob: vi.fn() }))
const download = vi.hoisted(() => ({ start: vi.fn() }))

vi.mock('../utils/api', () => api)
vi.mock('../context/auth', () => ({ useAuth: () => auth }))
vi.mock('../utils/scroll', () => ({ useScrollRestoration: scroll.restore }))
vi.mock('../utils/useMediaExpiryRefresh', () => ({
    useMediaExpiryRefresh: (...args) => { expiry.hook(...args); return expiry.refresh },
}))
vi.mock('../utils/share', async importOriginal => ({ ...(await importOriginal()), sharePage: share.page }))
vi.mock('../utils/mediaUrls', async importOriginal => ({ ...(await importOriginal()), startBrowserDownload: download.start }))
vi.mock('../utils/zipDownload', () => zip)
vi.mock('../utils/analytics', () => ({ trackAlbumView: vi.fn(), trackPhotoDownload: vi.fn(), trackZipRequest: vi.fn() }))
vi.mock('../components/ProgressiveImage', () => ({
    default: ({ alt, src, onError }) => <img alt={alt} src={src} onError={onError} />,
}))

import { AlbumGalleryContent } from './AlbumGallery'

const data = {
    album: { albumId: 'a1', title: 'Coastal Light', createdAt: '2026-01-01', visibility: 'public' },
    images: [
        {
            id: 'one', url: 'https://media.test/one.jpg', thumbnailUrl: 'https://media.test/one-thumb.jpg',
            width: 2400, height: 1600, exif: { model: 'Canon EOS R7', lens: 'Sigma 18-50mm F2.8' },
            before: { status: 'ready', url: 'https://media.test/one-original.jpg', width: 2400, height: 1600 },
        },
        { id: 'two', url: 'https://media.test/two.jpg', thumbnailUrl: 'https://media.test/two-thumb.jpg', width: 1600, height: 2400 },
    ],
}

function deferred() {
    let resolve
    const promise = new Promise(done => { resolve = done })
    return { promise, resolve }
}

beforeEach(() => {
    vi.clearAllMocks()
    api.fetchAlbum.mockReset().mockResolvedValue(data)
    auth.getIdToken.mockReset().mockResolvedValue('current-token')
    expiry.hook.mockReset()
    expiry.refresh.mockReset().mockResolvedValue(true)
    share.page.mockReset().mockResolvedValue('copied')
    zip.pollZipJob.mockReset()
    window.history.replaceState({ gallery: true }, '', '/explore/immersive-gallery?photo=two&view=hall')
})

describe('embedded album gallery', () => {
    it('loads explicit album content and its full photo viewer without router state or scroll restoration', async () => {
        const pending = deferred()
        api.fetchAlbum.mockReturnValueOnce(pending.promise)
        const onSharedPhotoClose = vi.fn()
        const pageUrl = window.location.href
        render(<AlbumGalleryContent albumId="a1" embedded initialPhotoId="two" onSharedPhotoClose={onSharedPhotoClose} />)
        expect(screen.getByRole('status', { name: 'Loading album' })).toBeInTheDocument()
        await waitFor(() => expect(api.fetchAlbum).toHaveBeenCalledWith('a1', 'current-token', expect.objectContaining({ signal: expect.any(AbortSignal) })))
        await act(async () => pending.resolve(data))
        expect(await screen.findByRole('heading', { name: 'Coastal Light' })).toBeInTheDocument()
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(screen.queryByRole('button', { name: 'Back to Albums' })).toBeNull()
        expect(scroll.restore).not.toHaveBeenCalled()
        expect(document.querySelector('.linen-gallery-page--embedded')).not.toHaveClass('pt-[88px]')

        const trigger = screen.getByRole('button', { name: 'Open item 1 from Coastal Light' })
        trigger.focus()
        fireEvent.click(trigger)
        expect(screen.getByRole('dialog', { name: 'Photo viewer for Coastal Light' })).toBeInTheDocument()
        expect(screen.getByText('Canon EOS R7')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Show original photo' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Download photo' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Order a print of this photo' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Next photo' }))
        expect(screen.getByText('2 / 2')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Close photo viewer' }))
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(trigger).toHaveFocus()
        expect(window.location.href).toBe(pageUrl)
        expect(window.history.state).toEqual({ gallery: true })
        expect(onSharedPhotoClose).not.toHaveBeenCalled()
    })

    it('shares the actual album rather than the museum URL', async () => {
        render(<AlbumGalleryContent albumId="a1" embedded />)
        fireEvent.click(await screen.findByRole('button', { name: 'Share Coastal Light' }))
        await waitFor(() => expect(share.page).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Coastal Light — Ian Truong Photography',
            url: `${window.location.origin}/album/a1`,
        })))
        fireEvent.click(screen.getByRole('button', { name: 'Open item 1 from Coastal Light' }))
        fireEvent.click(screen.getByRole('button', { name: 'Share photo' }))
        await waitFor(() => expect(share.page).toHaveBeenCalledWith(expect.objectContaining({
            url: `${window.location.origin}/album/a1?photo=one`,
        })))
        expect(window.location.pathname).toBe('/explore/immersive-gallery')
    })

    it('aborts a replaced album and ignores its late initial response', async () => {
        const oldAlbum = deferred()
        api.fetchAlbum.mockReturnValueOnce(oldAlbum.promise).mockResolvedValue({ ...data, album: { ...data.album, albumId: 'a2', title: 'Forest Light' } })
        const { rerender } = render(<AlbumGalleryContent albumId="a1" embedded />)
        await waitFor(() => expect(api.fetchAlbum).toHaveBeenCalledTimes(1))
        const oldSignal = api.fetchAlbum.mock.calls[0][2].signal
        rerender(<AlbumGalleryContent albumId="a2" embedded />)
        expect(await screen.findByRole('heading', { name: 'Forest Light' })).toBeInTheDocument()
        expect(oldSignal.aborted).toBe(true)
        await act(async () => oldAlbum.resolve(data))
        expect(screen.queryByRole('heading', { name: 'Coastal Light' })).toBeNull()
        expect(screen.getByRole('heading', { name: 'Forest Light' })).toBeInTheDocument()
    })

    it('refreshes authenticated media in place and discards an old refresh after album replacement', async () => {
        const oldRefresh = deferred()
        api.fetchAlbum.mockResolvedValueOnce(data).mockReturnValueOnce(oldRefresh.promise).mockResolvedValue({ ...data, album: { ...data.album, albumId: 'a2', title: 'Forest Light' } })
        const { rerender } = render(<AlbumGalleryContent albumId="a1" embedded />)
        await screen.findByRole('heading', { name: 'Coastal Light' })
        auth.getIdToken.mockResolvedValue('refreshed-token')
        let refreshPromise
        act(() => { refreshPromise = expiry.hook.mock.lastCall[1]('media-error') })
        await waitFor(() => expect(api.fetchAlbum).toHaveBeenCalledWith('a1', 'refreshed-token', expect.objectContaining({ force: true, signal: expect.any(AbortSignal) })))
        const refreshSignal = api.fetchAlbum.mock.calls[1][2].signal
        rerender(<AlbumGalleryContent albumId="a2" embedded />)
        await screen.findByRole('heading', { name: 'Forest Light' })
        expect(refreshSignal.aborted).toBe(true)
        await act(async () => { oldRefresh.resolve(data); await refreshPromise })
        expect(screen.queryByRole('heading', { name: 'Coastal Light' })).toBeNull()
        expect(screen.getByRole('heading', { name: 'Forest Light' })).toBeInTheDocument()
    })

    it('cancels a pending ZIP when the viewer closes and never starts a late download', async () => {
        const pendingZip = deferred()
        zip.pollZipJob.mockReturnValue(pendingZip.promise)
        const { unmount } = render(<AlbumGalleryContent albumId="a1" embedded />)
        fireEvent.click(await screen.findByRole('button', { name: 'Download All' }))
        await waitFor(() => expect(zip.pollZipJob).toHaveBeenCalledOnce())
        const signal = zip.pollZipJob.mock.calls[0][0].signal
        unmount()
        expect(signal.aborted).toBe(true)
        await act(async () => pendingZip.resolve('https://media.test/album.zip'))
        expect(download.start).not.toHaveBeenCalled()
    })
})
