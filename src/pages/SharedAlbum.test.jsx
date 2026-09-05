import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  fetchSharedAlbum: vi.fn(),
  requestSharedOriginalComparison: vi.fn(),
  requestSharedAlbumZip: vi.fn(),
  requestSharedMediaDownload: vi.fn(),
}))
const urls = vi.hoisted(() => ({ resolveMediaDownloadUrl: vi.fn(), startBrowserDownload: vi.fn() }))
const zip = vi.hoisted(() => ({ pollZipJob: vi.fn() }))
const refresh = vi.hoisted(() => ({ callback: null, request: vi.fn() }))

vi.mock('../utils/api', () => api)
vi.mock('../utils/mediaUrls', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveMediaDownloadUrl: urls.resolveMediaDownloadUrl,
  startBrowserDownload: urls.startBrowserDownload,
}))
vi.mock('../utils/zipDownload', () => zip)
vi.mock('../utils/useMediaExpiryRefresh', () => ({
  useMediaExpiryRefresh: (_images, callback) => {
    refresh.callback = callback
    return refresh.request
  },
}))
vi.mock('@marsidev/react-turnstile', () => ({
  Turnstile: ({ onSuccess, onExpire, onError, options }) => <div data-action={options.action}>
    <button onClick={() => onSuccess('verified-token')}>Solve security check</button>
    <button onClick={onExpire}>Expire security check</button>
    <button onClick={onError}>Fail security check</button>
  </div>,
}))
vi.mock('framer-motion', () => {
  const components = new Map()
  return {
    AnimatePresence: ({ children }) => children,
    motion: new Proxy({}, { get: (_target, tag) => {
      if (!components.has(tag)) components.set(tag, ({ children, ...props }) => {
        const Tag = tag
        const { variants: _v, initial: _i, animate: _a, exit: _e, transition: _t, ...domProps } = props
        return <Tag {...domProps}>{children}</Tag>
      })
      return components.get(tag)
    } }),
  }
})
vi.mock('../components/ProgressiveImage', () => ({ default: ({ alt, src, srcSet, onError }) => <img alt={alt} src={src} srcSet={srcSet} onError={onError} /> }))
vi.mock('../components/VideoPlayer', () => ({ default: ({ videoInfo, onMediaError }) => <button onClick={onMediaError}>Video {videoInfo.id}</button> }))

import SharedAlbum from './SharedAlbum'

function renderShared(path = '/sharedalbum') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/sharedalbum" element={<SharedAlbum />} />
        <Route path="/sharedalbum/:code" element={<SharedAlbum />} />
      </Routes>
    </MemoryRouter>,
  )
}

const photoData = {
  album: { title: 'Shared Photos', description: 'Private gallery', type: 'photo', createdAt: '2026-02-01', qrCodeUrl: 'https://x.test/shared-qr.svg' },
  images: [
    { id: 'p1', url: 'https://x.test/p1-full', thumbnailUrl: 'https://x.test/p1-thumb', width: 2400, height: 1800, exif: { model: 'Camera', lens: 'Lens', focalLength: '35mm', focalRatio: 'f/4', shutterSpeed: '1/250', iso: 'ISO 200' }, previewSrcSet: [{ width: 640, url: 'https://x.test/640' }, { width: 960, url: 'https://x.test/960' }, { width: 1440, url: 'https://x.test/1440' }, { width: 1920, url: 'https://x.test/1920' }] },
    { id: 'p2', url: 'https://x.test/p2-full', thumbnailUrl: 'https://x.test/p2-thumb' },
  ],
}

describe('SharedAlbum access and gallery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    refresh.callback = null
    api.fetchSharedAlbum.mockResolvedValue(photoData)
    urls.resolveMediaDownloadUrl.mockImplementation((request) => request().then((value) => value.downloadUrl))
    api.requestSharedMediaDownload.mockResolvedValue({ downloadUrl: 'https://x.test/file' })
    zip.pollZipJob.mockResolvedValue('https://x.test/archive')
  })

  it('requires verification, accepts a full pasted URL, and fetches with a purpose-bound token', async () => {
    renderShared()
    const submit = screen.getByRole('button', { name: 'Access Gallery' })
    expect(submit).toHaveClass('shared-album-submit')
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByPlaceholderText(/xY7bQk9P/), { target: { value: ' https://site.test/sharedalbum/my-code/ ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Expire security check' }))
    fireEvent.click(screen.getByRole('button', { name: 'Fail security check' }))
    expect(screen.getByRole('button', { name: 'Access Gallery' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Solve security check' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Access Gallery' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Access Gallery' }))
    expect(await screen.findByRole('heading', { name: 'Shared Photos' })).toBeInTheDocument()
    expect(api.fetchSharedAlbum).toHaveBeenCalledWith('my-code', 'verified-token', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('loads a bookmarked share, navigates the photo lightbox, refreshes, and downloads', async () => {
    renderShared('/sharedalbum/code-1')
    expect(screen.getByRole('heading', { name: 'Verify Access' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Solve security check' }))
    await screen.findByRole('heading', { name: 'Shared Photos' })
    const first = screen.getByRole('img', { name: 'Item 1 from Shared Photos' })
    expect(first).toHaveAttribute('srcset')
    fireEvent.error(first)
    expect(refresh.request).toHaveBeenCalledWith('media-error')
    fireEvent.click(first)
    expect(screen.getByRole('img', { name: 'Full size preview' })).toHaveAttribute('src', 'https://x.test/p1-full')
    expect(screen.getByRole('img', { name: 'Full size preview' })).toHaveClass('linen-lightbox-photo')
    expect(screen.getByText('Camera')).toBeInTheDocument()
    const overlay = screen.getByRole('img', { name: 'Full size preview' }).closest('.fixed')
    fireEvent.click(overlay.querySelector('button.absolute.right-4'))
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('img', { name: 'Full size preview' }).closest('.fixed').querySelector('button.absolute.left-4'))
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    fireEvent.click(screen.getByTitle('Download Photo'))
    await waitFor(() => expect(api.requestSharedMediaDownload).toHaveBeenCalledWith('code-1', 'p1'))
    expect(urls.startBrowserDownload).toHaveBeenCalledWith('https://x.test/file', 'p1')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('img', { name: 'Full size preview' })).toBeNull()
    fireEvent.click(screen.getByRole('img', { name: 'Item 1 from Shared Photos' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close photo viewer' }))
    expect(screen.queryByRole('img', { name: 'Full size preview' })).toBeNull()
    fireEvent.click(screen.getByRole('img', { name: 'Item 1 from Shared Photos' }))
    fireEvent.mouseDown(screen.getByRole('dialog', { name: 'Photo viewer for Shared Photos' }))
    expect(screen.queryByRole('img', { name: 'Full size preview' })).toBeNull()
  })

  it('opens a shared exact-photo link after verification and returns to the protected album', async () => {
    renderShared('/sharedalbum/code-1?photo=p2')
    fireEvent.click(screen.getByRole('button', { name: 'Solve security check' }))
    expect(await screen.findByRole('dialog', { name: 'Photo viewer for Shared Photos' })).toBeInTheDocument()
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close photo viewer' }))
    expect(screen.queryByRole('dialog', { name: 'Photo viewer for Shared Photos' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Shared Photos' })).toBeInTheDocument()
  })

  it('requires a fresh security check when protected media expires', async () => {
    renderShared('/sharedalbum/code-1')
    fireEvent.click(screen.getByRole('button', { name: 'Solve security check' }))
    await screen.findByText('Shared Photos')
    act(() => refresh.callback())
    expect(screen.getByText(/gallery session expired/i)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Verify Access' })).toBeInTheDocument()
  })

  it('checks one original with the share grant while retaining verification and selection', async () => {
    api.requestSharedOriginalComparison.mockResolvedValueOnce({ before: { status: 'pending' } })
    api.fetchSharedAlbum.mockResolvedValueOnce({
      ...photoData,
      images: photoData.images.map(image => ({ ...image, before: { status: 'unresolved' } })),
    })
    renderShared('/sharedalbum/code-1?photo=p2')
    fireEvent.click(screen.getByRole('button', { name: 'Solve security check' }))
    await screen.findByRole('dialog', { name: 'Photo viewer for Shared Photos' })
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    await waitFor(() => expect(api.requestSharedOriginalComparison).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Preparing original…'))
    expect(api.requestSharedOriginalComparison).toHaveBeenCalledWith('code-1', 'p2', { signal: expect.any(AbortSignal) })
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    expect(screen.getByAltText('Full size preview')).toHaveAttribute('src', 'https://x.test/p2-full')
    expect(screen.queryByText(/gallery session expired/i)).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Verify Access' })).toBeNull()
    expect(refresh.request).not.toHaveBeenCalled()
    expect(api.fetchSharedAlbum).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Previous photo' }))
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
  })

  it('downloads a ZIP with rate-limit state and reports worker errors', async () => {
    let finish
    zip.pollZipJob.mockImplementation(({ onStatus }) => {
      onStatus('rate_limited')
      return new Promise((resolve) => { finish = resolve })
    })
    renderShared('/sharedalbum/code-1')
    fireEvent.click(screen.getByRole('button', { name: 'Solve security check' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Download All' }))
    expect(await screen.findByRole('button', { name: 'Waiting...' })).toBeDisabled()
    await act(async () => finish('https://x.test/shared.zip'))
    expect(urls.startBrowserDownload).toHaveBeenCalledWith('https://x.test/shared.zip', 'Shared Photos.zip')

    vi.spyOn(console, 'error').mockImplementation(() => {})
    zip.pollZipJob.mockRejectedValueOnce(new Error('ZIP failed'))
    fireEvent.click(screen.getByRole('button', { name: 'Download All' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('ZIP failed')
  })

  it('shows the protected QR action above the ZIP action', async () => {
    renderShared('/sharedalbum/code-1')
    fireEvent.click(screen.getByRole('button', { name: 'Solve security check' }))
    const qr = await screen.findByRole('button', { name: 'Show QR code for Shared Photos' })
    const download = screen.getByRole('button', { name: 'Download All' })
    expect(qr.compareDocumentPosition(download) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(qr)
    expect(screen.getByRole('img', { name: 'QR code linking to Shared Photos' })).toHaveAttribute('src', 'https://x.test/shared-qr.svg')
  })

  it('handles security-widget and album errors and returns to code entry', async () => {
    renderShared('/sharedalbum/bad')
    fireEvent.click(screen.getByRole('button', { name: 'Fail security check' }))
    expect(screen.getByRole('heading', { name: 'Link Invalid' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try another code' }))
    expect(screen.getByRole('heading', { name: 'View Shared Album' })).toBeInTheDocument()

    api.fetchSharedAlbum.mockRejectedValueOnce(new Error('Invalid share code'))
    fireEvent.change(screen.getByPlaceholderText(/xY7bQk9P/), { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Solve security check' }))
    fireEvent.click(screen.getByRole('button', { name: 'Access Gallery' }))
    expect(await screen.findByRole('heading', { name: 'Link Invalid' })).toBeInTheDocument()
    expect(screen.getByText('Invalid share code')).toBeInTheDocument()
  })

  it('shares exact videos from link-only albums, closes them accessibly, and shows empty albums', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    api.fetchSharedAlbum.mockResolvedValueOnce({
      album: { title: 'Shared Video', type: 'video', createdAt: '2026-01-01' },
      images: [
        { id: 'v1', thumbnailUrl: 'thumb-1', url: 'video-1' },
        { id: 'v2', thumbnailUrl: 'thumb-2', url: 'video-2' },
      ],
    })
    const first = renderShared('/sharedalbum/video?video=v2')
    fireEvent.click(screen.getByRole('button', { name: 'Solve security check' }))
    expect(await screen.findByText('Video v2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Share video' }))
    await waitFor(() => expect(share).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Shared Video — Ian Truong Photography',
      url: 'http://localhost:3000/sharedalbum/video?video=v2',
    })))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByText('Video v2')).toBeNull()
    expect(screen.getByRole('button', { name: 'Download All' })).toBeInTheDocument()
    first.unmount()
    delete navigator.share

    api.fetchSharedAlbum.mockResolvedValueOnce({ album: { title: 'Empty', type: 'photo', createdAt: '2026-01-01' }, images: [] })
    renderShared('/sharedalbum/empty')
    fireEvent.click(screen.getByRole('button', { name: 'Solve security check' }))
    expect(await screen.findByText('No photos in this album yet.')).toBeInTheDocument()
  })

  it('alerts on an individual download failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(window, 'alert').mockImplementation(() => {})
    urls.resolveMediaDownloadUrl.mockRejectedValueOnce(new Error('download'))
    renderShared('/sharedalbum/code-1')
    fireEvent.click(screen.getByRole('button', { name: 'Solve security check' }))
    fireEvent.click(await screen.findByRole('img', { name: 'Item 1 from Shared Photos' }))
    fireEvent.click(screen.getByTitle('Download Photo'))
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('file could not be downloaded')))
  })
})
