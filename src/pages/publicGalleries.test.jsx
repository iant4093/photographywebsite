import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
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

function gallery(ui, path) {
  return render(
    <MemoryRouter initialEntries={['/previous', path]} initialIndex={1}>
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
  album: { albumId: 'a1', title: 'Wild Album', description: 'Description', createdAt: '2026-01-03', qrCodeUrl: 'https://x.test/photo-qr.svg' },
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
    api.fetchAlbum.mockResolvedValue(photoData)
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
    album: { title: 'Video Album', description: 'Films', qrCodeUrl: 'https://x.test/video-qr.svg' },
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

  it('offers a QR lightbox for a public video album', async () => {
    gallery(<VideoGallery />, '/video/v-album')
    fireEvent.click(await screen.findByRole('button', { name: 'Show QR code for Video Album' }))
    expect(screen.getByRole('img', { name: 'QR code linking to Video Album' })).toHaveAttribute('src', 'https://x.test/video-qr.svg')
  })

  it('opens from a thumbnail, refreshes media, downloads, closes, and goes back', async () => {
    gallery(<VideoGallery />, '/video/v-album')
    await screen.findByRole('heading', { name: 'Video Album' })
    fireEvent.error(screen.getByRole('img', { name: 'Video 1' }))
    expect(expiry.refresh).toHaveBeenCalledWith('media-error')
    fireEvent.click(screen.getByRole('img', { name: 'Video 1' }))
    fireEvent.click(screen.getByText('Playing v1'))
    expect(expiry.refresh).toHaveBeenCalled()
    fireEvent.click(screen.getByTitle('Download Video'))
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
