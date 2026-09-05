import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  fetchAlbum: vi.fn(),
  requestAlbumMediaDownload: vi.fn(),
  requestAlbumZip: vi.fn(),
}))
const urls = vi.hoisted(() => ({
  resolveMediaDownloadUrl: vi.fn(),
  startBrowserDownload: vi.fn(),
}))
const zip = vi.hoisted(() => ({ pollZipJob: vi.fn() }))
const expiry = vi.hoisted(() => ({ refresh: vi.fn(), hook: vi.fn() }))
const auth = vi.hoisted(() => ({ getIdToken: vi.fn() }))

vi.mock('../utils/api', () => api)
vi.mock('../utils/mediaUrls', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveMediaDownloadUrl: urls.resolveMediaDownloadUrl,
  startBrowserDownload: urls.startBrowserDownload,
}))
vi.mock('../utils/zipDownload', () => zip)
vi.mock('../utils/useMediaExpiryRefresh', () => ({ useMediaExpiryRefresh: (...args) => { expiry.hook(...args); return expiry.refresh } }))
vi.mock('../utils/scroll', () => ({
  useScrollRestoration: vi.fn(),
  isRevealed: vi.fn(() => false),
  markAsRevealed: vi.fn(),
}))
vi.mock('../context/auth', () => ({ useAuth: () => auth }))
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => children,
  motion: new Proxy({}, { get: (_target, tag) => ({ children, ...props }) => {
    const Tag = tag
    const {
      onViewportEnter: _onViewportEnter,
      variants: _variants, initial: _initial, animate: _animate, exit: _exit,
      transition: _transition, whileInView: _whileInView, viewport: _viewport,
      ...domProps
    } = props
    return <Tag {...domProps}>{children}</Tag>
  } }),
}))
vi.mock('../components/ProgressiveImage', () => ({
  default: ({ alt, src, srcSet, onError }) => <img alt={alt} src={src} srcSet={srcSet} onError={onError} />,
}))
vi.mock('../components/VideoPlayer', () => ({ default: ({ videoInfo, onMediaError }) => <button onClick={onMediaError}>Playing {videoInfo.id}</button> }))

import AlbumGallery from './AlbumGallery'
import VideoGallery from './VideoGallery'

function gallery(ui, path, navigateTo) {
  return render(
    <MemoryRouter initialEntries={['/previous', path]} initialIndex={1}>
      {navigateTo && <Link to={navigateTo}>Open another album</Link>}
      <Routes>
        <Route path="/album/:albumId" element={ui} />
        <Route path="/video/:albumId" element={ui} />
        <Route path="/previous" element={<div>Previous page</div>} />
        <Route path="/" element={<div>Photo archive</div>} />
        <Route path="/videos" element={<div>Video archive</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

const photoData = {
  album: { albumId: 'a1', title: 'Wild Album', description: 'Description', createdAt: '2026-01-03', visibility: 'public', qrCodeUrl: 'https://x.test/photo-qr.svg' },
  images: [
    { id: 'one', url: 'https://x.test/one-full', thumbnailUrl: 'https://x.test/one-thumb', width: 2400, height: 1800, exif: { model: 'Camera', lens: 'Lens', focalLength: '50mm', focalRatio: 'f/2', shutterSpeed: '1/100', iso: 'ISO 100' }, previewSrcSet: [{ width: 640, url: 'https://x.test/640' }, { width: 960, url: 'https://x.test/960' }, { width: 1440, url: 'https://x.test/1440' }, { width: 1920, url: 'https://x.test/1920' }] },
    { id: 'two', url: 'https://x.test/two-full', thumbnailUrl: 'https://x.test/two-thumb', width: 800, height: 600 },
  ],
}

describe('AlbumGallery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    expiry.hook.mockReset()
    expiry.refresh.mockReset()
    auth.getIdToken.mockResolvedValue('token')
    api.fetchAlbum.mockReset().mockResolvedValue(photoData)
    urls.resolveMediaDownloadUrl.mockImplementation((request) => request().then((value) => value.downloadUrl))
    api.requestAlbumMediaDownload.mockResolvedValue({ downloadUrl: 'https://x.test/download' })
    zip.pollZipJob.mockResolvedValue('https://x.test/photos.zip')
    window.history.replaceState({ idx: 0 }, '')
  })
  afterEach(() => vi.restoreAllMocks())

  it('loads a protected/public-compatible album and exercises lightbox navigation and download', async () => {
    gallery(<AlbumGallery />, '/album/a1')
    expect(await screen.findByRole('heading', { name: 'Wild Album' })).toBeInTheDocument()
    expect(api.fetchAlbum).toHaveBeenCalledWith('a1', 'token', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    const firstPhoto = screen.getByRole('img', { name: 'Item 1 from Wild Album' })
    expect(firstPhoto).toHaveAttribute('srcset')
    const firstPhotoButton = screen.getByRole('button', { name: 'Open item 1 from Wild Album' })
    expect(firstPhotoButton).toHaveClass('linen-photo-frame')
    expect(firstPhotoButton.closest('.linen-gallery-page')).not.toHaveClass('bg-cream')
    expect(firstPhotoButton.querySelector('.linen-photo-viewport')).toContainElement(firstPhoto)
    fireEvent.error(screen.getByRole('img', { name: 'Item 1 from Wild Album' }))
    expect(expiry.refresh).toHaveBeenCalledWith('media-error')

    firstPhotoButton.focus()
    fireEvent.click(firstPhotoButton)
    expect(screen.getByRole('dialog', { name: 'Photo viewer for Wild Album' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close photo viewer' })).toHaveFocus()
    const fullPreview = screen.getByRole('img', { name: 'Full size preview' })
    expect(fullPreview).toHaveAttribute('src', 'https://x.test/one-full')
    expect(fullPreview).toHaveAttribute('srcset', expect.stringContaining('https://x.test/1920 1920w'))
    expect(fullPreview).toHaveClass('linen-lightbox-photo')
    const firstPlaceholder = document.querySelector('.linen-lightbox-placeholder')
    expect(firstPlaceholder).toHaveAttribute('src', 'https://x.test/one-thumb')
    expect(screen.getByText('Camera')).toBeInTheDocument()
    expect(screen.getByText('Lens')).toBeInTheDocument()
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next photo' }))
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    const secondPlaceholder = document.querySelector('.linen-lightbox-placeholder')
    expect(secondPlaceholder).not.toBe(firstPlaceholder)
    expect(secondPlaceholder).toHaveAttribute('src', 'https://x.test/two-thumb')
    fireEvent.click(screen.getByRole('button', { name: 'Previous photo' }))
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Download Photo'))
    await waitFor(() => expect(api.requestAlbumMediaDownload).toHaveBeenCalledWith('a1', 'one', 'token'))
    expect(urls.startBrowserDownload).toHaveBeenCalledWith('https://x.test/download', 'one')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('img', { name: 'Full size preview' })).toBeNull()
    expect(firstPhotoButton).toHaveFocus()
    fireEvent.click(firstPhotoButton)
    fireEvent.click(screen.getByRole('button', { name: 'Close photo viewer' }))
    expect(screen.queryByRole('img', { name: 'Full size preview' })).toBeNull()
    fireEvent.click(firstPhotoButton)
    fireEvent.mouseDown(screen.getByRole('dialog', { name: 'Photo viewer for Wild Album' }))
    expect(screen.queryByRole('img', { name: 'Full size preview' })).toBeNull()
  })

  it('opens an exact shared photograph and stays on the album when the lightbox closes', async () => {
    gallery(<AlbumGallery />, '/album/a1?photo=two')
    expect(await screen.findByRole('dialog', { name: 'Photo viewer for Wild Album' })).toBeInTheDocument()
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close photo viewer' }))
    expect(screen.queryByRole('dialog', { name: 'Photo viewer for Wild Album' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Wild Album' })).toBeInTheDocument()
  })

  it('reuses verified original URLs on status refresh and replaces them after a media error', async () => {
    const now = Date.now()
    const original = (issuedAt, signature) => {
      const date = new Date(issuedAt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
      const url = `https://originals.example.test/before/a1/one/w640.webp?X-Amz-Date=${date}&X-Amz-Expires=1800&X-Amz-Signature=${signature}`
      return { status: 'ready', width: 640, height: 480, url, srcSet: [{ width: 640, url }], expiresAt: issuedAt + 1_800_000 }
    }
    const previous = original(now - 60_000, 'old')
    const fresh = original(now, 'fresh')
    const data = before => ({ ...photoData, images: [{ ...photoData.images[0], before }] })
    api.fetchAlbum.mockResolvedValueOnce(data(previous)).mockResolvedValue(data(fresh))
    expiry.hook.mockImplementation((_items, refresh) => {
      expiry.refresh.mockImplementation(reason => refresh(reason))
    })
    gallery(<AlbumGallery />, '/album/a1')
    await screen.findByRole('heading', { name: 'Wild Album' })
    await act(async () => { await expiry.hook.mock.lastCall[1]('original-status') })
    expect(expiry.hook.mock.lastCall[0][0].before).toBe(previous)
    expect(expiry.hook.mock.lastCall[0][0].mediaExpiresAt).toBeLessThanOrEqual(previous.expiresAt)
    fireEvent.click(screen.getByRole('button', { name: 'Open item 1 from Wild Album' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    const beforeImage = document.querySelector('.linen-lightbox-original')
    expect(beforeImage).toHaveAttribute('src', previous.url)
    // The existing media refresh cooldown can suppress the automatic attempt.
    // The subsequent retry click must still replace the URL that failed.
    expiry.refresh.mockImplementationOnce(() => Promise.resolve(false))
    await act(async () => { fireEvent.error(beforeImage) })
    expect(api.fetchAlbum).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Retry original' }))
    await waitFor(() => expect(expiry.hook.mock.lastCall[0][0].before).toBe(fresh))
    await waitFor(() => expect(document.querySelector('.linen-lightbox-original')).toHaveAttribute('src', fresh.url))
    expect(expiry.hook.mock.lastCall[0][0].before).toBe(fresh)
    expect(expiry.refresh).toHaveBeenLastCalledWith('media-error')
    expect(api.fetchAlbum).toHaveBeenLastCalledWith('a1', 'token', expect.objectContaining({ force: true }))
  })

  it('hides album and lightbox sharing for a specific-user photo album', async () => {
    api.fetchAlbum.mockResolvedValueOnce({
      ...photoData,
      album: { ...photoData.album, visibility: 'private', qrCodeUrl: '' },
    })
    gallery(<AlbumGallery />, '/album/a1')
    await screen.findByRole('heading', { name: 'Wild Album' })
    expect(screen.queryByRole('button', { name: 'Share Wild Album' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open item 1 from Wild Album' }))
    expect(screen.queryByRole('button', { name: 'Share photo' })).toBeNull()
  })

  it('downloads a ZIP, displays worker state/errors, and guards duplicate work', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let finish
    zip.pollZipJob.mockImplementation(({ onStatus }) => {
      onStatus('rate_limited')
      return new Promise((resolve) => { finish = resolve })
    })
    gallery(<AlbumGallery />, '/album/a1')
    const button = await screen.findByRole('button', { name: 'Download All' })
    fireEvent.click(button)
    expect(await screen.findByRole('button', { name: 'Waiting...' })).toBeDisabled()
    await act(async () => finish('https://x.test/archive.zip'))
    expect(urls.startBrowserDownload).toHaveBeenCalledWith('https://x.test/archive.zip', 'Wild Album.zip')

    zip.pollZipJob.mockRejectedValueOnce(new Error('Worker failed'))
    fireEvent.click(screen.getByRole('button', { name: 'Download All' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Worker failed')
  })

  it('shows the public album QR action above the ZIP action', async () => {
    gallery(<AlbumGallery />, '/album/a1')
    const qr = await screen.findByRole('button', { name: 'Show QR code for Wild Album' })
    const download = screen.getByRole('button', { name: 'Download All' })
    expect(qr.compareDocumentPosition(download) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(qr)
    expect(screen.getByRole('img', { name: 'QR code linking to Wild Album' })).toHaveAttribute('src', 'https://x.test/photo-qr.svg')
  })

  it('uses a public token fallback and reports initial/background/download failures', async () => {
    auth.getIdToken.mockRejectedValue(new Error('anonymous'))
    api.fetchAlbum.mockRejectedValueOnce(new Error('missing'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = gallery(<AlbumGallery />, '/album/missing')
    expect(await screen.findByText(/may not exist or you may not have access/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Go Back' }))
    expect(screen.getByText('Photo archive')).toBeInTheDocument()
    first.unmount()

    api.fetchAlbum.mockResolvedValueOnce(photoData).mockRejectedValueOnce(new Error('refresh failed'))
    expiry.hook.mockImplementationOnce((_items, refresh) => { expiry.refresh.mockImplementation((reason) => refresh(reason).catch(() => false)) })
    gallery(<AlbumGallery />, '/album/a1')
    await screen.findByText('Wild Album')
    await act(async () => expiry.refresh('media-error'))
    expect(api.fetchAlbum).toHaveBeenLastCalledWith('a1', null, expect.objectContaining({ force: true }))
    expect(await screen.findByRole('alert')).toHaveTextContent('photo links expired')

    urls.resolveMediaDownloadUrl.mockRejectedValueOnce(new Error('download failed'))
    vi.spyOn(window, 'alert').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('img', { name: 'Item 1 from Wild Album' }))
    fireEvent.click(screen.getByTitle('Download Photo'))
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('could not be downloaded')))
  })

  it('shows an empty loaded album', async () => {
    api.fetchAlbum.mockResolvedValue({ createdAt: '2026-01-01' })
    gallery(<AlbumGallery />, '/album/a1')
    expect(await screen.findByText('No photos in this album yet.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Download All' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Albums' }))
    expect(screen.getByText('Photo archive')).toBeInTheDocument()
  })

  it.each(['success', 'failure'])('ignores a late background %s after changing album routes', async (outcome) => {
    let resolveRefresh, rejectRefresh
    const pendingRefresh = new Promise((resolve, reject) => {
      resolveRefresh = resolve
      rejectRefresh = reject
    })
    const nextAlbum = {
      album: { ...photoData.album, albumId: 'a2', title: 'New Album' },
      images: photoData.images.map(image => ({ ...image, id: `new-${image.id}`, url: `https://x.test/new-${image.id}` })),
    }
    api.fetchAlbum.mockResolvedValueOnce(photoData)
      .mockReturnValueOnce(pendingRefresh)
      .mockResolvedValueOnce(nextAlbum)
    expiry.hook.mockImplementation((_items, refresh) => {
      expiry.refresh.mockImplementation(reason => refresh(reason).catch(() => false))
    })
    gallery(<AlbumGallery />, '/album/a1', '/album/a2')
    await screen.findByRole('heading', { name: 'Wild Album' })
    let refreshRequest
    act(() => { refreshRequest = expiry.refresh('original-status') })
    await waitFor(() => expect(api.fetchAlbum).toHaveBeenCalledTimes(2))
    const oldSignal = api.fetchAlbum.mock.calls[1][2].signal
    expect(oldSignal.aborted).toBe(false)

    fireEvent.click(screen.getByRole('link', { name: 'Open another album' }))
    await screen.findByRole('heading', { name: 'New Album' })
    expect(oldSignal.aborted).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Open item 2 from New Album' }))
    expect(screen.getByRole('img', { name: 'Full size preview' })).toHaveAttribute('src', 'https://x.test/new-two')

    await act(async () => {
      if (outcome === 'success') resolveRefresh(photoData)
      else rejectRefresh(new Error('Old album refresh failed'))
      await refreshRequest
    })
    expect(screen.getByText('New Album', { selector: 'h1' })).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Photo viewer for New Album' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Full size preview' })).toHaveAttribute('src', 'https://x.test/new-two')
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    expect(screen.queryByRole('alert', { hidden: true })).toBeNull()
  })

  it('returns to an existing history entry when the album was opened in-app', async () => {
    window.history.replaceState({ idx: 1 }, '')
    gallery(<AlbumGallery />, '/album/a1')
    await screen.findByText('Wild Album')
    fireEvent.click(screen.getByRole('button', { name: 'Back to Albums' }))
    expect(screen.getByText('Previous page')).toBeInTheDocument()
  })

  it('silently handles an aborted initial album request', async () => {
    api.fetchAlbum.mockRejectedValue(new DOMException('aborted', 'AbortError'))
    gallery(<AlbumGallery />, '/album/a1')
    expect(await screen.findByText('This album could not be loaded.')).toBeInTheDocument()
  })
})

describe('VideoGallery', () => {
  const videoData = {
    album: { title: 'Video Album', description: 'Films', visibility: 'public', qrCodeUrl: 'https://x.test/video-qr.svg' },
    images: [
      { id: 'v1', url: 'https://x.test/v1.mp4', thumbnailUrl: 'https://x.test/v1.jpg' },
      { id: 'v2', url: 'https://x.test/v2.mp4', thumbnailUrl: 'https://x.test/v2.jpg' },
    ],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    expiry.hook.mockReset()
    expiry.refresh.mockReset()
    auth.getIdToken.mockResolvedValue('token')
    api.fetchAlbum.mockResolvedValue(videoData)
    urls.resolveMediaDownloadUrl.mockImplementation((request) => request().then((value) => value.downloadUrl))
    api.requestAlbumMediaDownload.mockResolvedValue({ downloadUrl: 'https://x.test/video-download' })
    zip.pollZipJob.mockResolvedValue('https://x.test/videos.zip')
    window.history.replaceState({ idx: 0 }, '')
  })

  it('auto-plays a deep link and navigates videos by buttons and keyboard', async () => {
    gallery(<VideoGallery />, '/video/v-album?play=1')
    expect(await screen.findByText('Playing v1')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Video player for Video Album' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close video player' })).toHaveFocus()
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next video' }))
    expect(screen.getByText('Playing v2')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(screen.getByText('Playing v1')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByText('Playing v1')).toBeNull()
  })

  it('opens and shares an exact video deep link', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    gallery(<VideoGallery />, '/video/v-album?video=v2')
    expect(await screen.findByText('Playing v2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Share video' }))
    await waitFor(() => expect(share).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Video Album — Ian Truong Photography',
      url: 'http://localhost:3000/video/v-album?video=v2',
    })))
    fireEvent.click(screen.getByRole('button', { name: 'Close video player' }))
    expect(screen.queryByRole('dialog', { name: 'Video player for Video Album' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Video Album' })).toBeInTheDocument()
    delete navigator.share
  })

  it('hides album and lightbox sharing for a specific-user video album', async () => {
    api.fetchAlbum.mockResolvedValueOnce({
      ...videoData,
      album: { ...videoData.album, visibility: 'private', qrCodeUrl: '' },
    })
    gallery(<VideoGallery />, '/video/v-album?play=1')
    expect(await screen.findByText('Playing v1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Share Video Album' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Share video' })).toBeNull()
  })

  it('offers a QR lightbox for a public video album', async () => {
    gallery(<VideoGallery />, '/video/v-album')
    fireEvent.click(await screen.findByRole('button', { name: 'Show QR code for Video Album' }))
    expect(screen.getByRole('img', { name: 'QR code linking to Video Album' })).toHaveAttribute('src', 'https://x.test/video-qr.svg')
  })

  it('downloads every original video through the shared ZIP pipeline', async () => {
    gallery(<VideoGallery />, '/video/v-album')
    fireEvent.click(await screen.findByRole('button', { name: 'Download All' }))
    await waitFor(() => expect(zip.pollZipJob).toHaveBeenCalledWith(expect.objectContaining({
      jobKey: 'album:v-album',
    })))
    expect(urls.startBrowserDownload).toHaveBeenCalledWith('https://x.test/videos.zip', 'Video Album.zip')
  })

  it('opens from a thumbnail, refreshes media, downloads, closes, and goes back', async () => {
    gallery(<VideoGallery />, '/video/v-album')
    await screen.findByRole('heading', { name: 'Video Album' })
    fireEvent.error(screen.getByRole('img', { name: 'Video 1' }))
    expect(expiry.refresh).toHaveBeenCalledWith('media-error')
    fireEvent.click(screen.getByRole('img', { name: 'Video 1' }))
    fireEvent.click(screen.getByText('Playing v1'))
    expect(expiry.refresh).toHaveBeenCalled()
    const download = screen.getByRole('button', { name: 'Download video' })
    expect(download).toHaveTextContent('Download')
    expect(download).toHaveClass('linen-lightbox-download')
    fireEvent.click(download)
    await waitFor(() => expect(urls.startBrowserDownload).toHaveBeenCalledWith('https://x.test/video-download', 'v1'))
    fireEvent.click(screen.getByTitle('Close Player'))
    fireEvent.click(screen.getByRole('button', { name: 'Back to Videos' }))
    expect(screen.getByText('Video archive')).toBeInTheDocument()
  })

  it('reports initial, background, and download failures', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    api.fetchAlbum.mockRejectedValueOnce(new Error('missing'))
    const first = gallery(<VideoGallery />, '/video/missing')
    expect(await screen.findByText(/Failed to load video album/)).toBeInTheDocument()
    first.unmount()

    api.fetchAlbum.mockResolvedValueOnce(videoData).mockRejectedValueOnce(new Error('expired'))
    expiry.hook.mockImplementationOnce((_items, refresh) => { expiry.refresh.mockImplementation((reason) => refresh(reason).catch(() => false)) })
    gallery(<VideoGallery />, '/video/v-album')
    await screen.findByText('Video Album')
    await act(async () => expiry.refresh('media-error'))
    expect(screen.getByRole('alert')).toHaveTextContent('video link expired')

    urls.resolveMediaDownloadUrl.mockRejectedValueOnce(new Error('download'))
    vi.spyOn(window, 'alert').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('img', { name: 'Video 1' }))
    fireEvent.click(screen.getByTitle('Download Video'))
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('video could not be downloaded')))
  })
})
