import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  requestAlbumOriginalComparison: vi.fn(), fetchAlbumsFiltered: vi.fn(), fetchAlbum: vi.fn(), requestAlbumMediaDownload: vi.fn(), requestAlbumZip: vi.fn(),
}))
const auth = vi.hoisted(() => ({ userEmail: 'viewer@example.com', getIdToken: vi.fn() }))
const urls = vi.hoisted(() => ({ startBrowserDownload: vi.fn(), resolveMediaDownloadUrl: vi.fn() }))
const zip = vi.hoisted(() => ({ pollZipJob: vi.fn() }))
const expiry = vi.hoisted(() => ({ hook: vi.fn() }))
const scroll = vi.hoisted(() => ({
  useScrollRestoration: vi.fn(), saveVerticalScroll: vi.fn(), getSavedScroll: vi.fn(),
  isRevealed: vi.fn(() => false), markAsRevealed: vi.fn(),
}))

vi.mock('../context/auth', () => ({ useAuth: () => auth }))
vi.mock('../utils/api', () => api)
vi.mock('../utils/mediaUrls', async (importOriginal) => ({
  ...(await importOriginal()),
  startBrowserDownload: urls.startBrowserDownload,
  resolveMediaDownloadUrl: urls.resolveMediaDownloadUrl,
}))
vi.mock('../utils/zipDownload', () => zip)
vi.mock('../utils/scroll', () => scroll)
vi.mock('../utils/useMediaExpiryRefresh', () => ({
  useMediaExpiryRefresh: (items, callback) => {
    expiry.hook(items, callback)
    return reason => Promise.resolve(callback(reason)).catch(() => false)
  },
}))
vi.mock('../components/ProgressiveImage', () => ({ default: ({ alt, src, srcSet, onError }) => <img alt={alt} src={src} srcSet={srcSet} onError={onError} /> }))
vi.mock('../components/ScrollRow', () => ({ default: ({ children, scrollKey }) => <div data-testid={scrollKey}>{children}</div> }))
vi.mock('../components/SkeletonGrid', () => ({ default: () => <div role="status">Loading private albums</div> }))
vi.mock('framer-motion', () => {
  const components = new Map()
  return {
    AnimatePresence: ({ children }) => children,
    motion: new Proxy({}, { get: (_target, tag) => {
      if (!components.has(tag)) components.set(tag, ({ children, ...props }) => {
        const Tag = tag
        const {
          onViewportEnter, variants: _variants, initial: _initial, animate: _animate, exit: _exit,
          transition: _transition, whileInView: _whileInView, viewport: _viewport, ...domProps
        } = props
        return <Tag onMouseEnter={onViewportEnter} {...domProps}>{children}</Tag>
      })
      return components.get(tag)
    } }),
  }
})

import UserDashboard from './UserDashboard'

function mounted(withDashboardNavigation = false) {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      {withDashboardNavigation && <Link to="/dashboard">Reset dashboard</Link>}
      <Routes>
        <Route path="/dashboard" element={<UserDashboard />} />
        <Route path="/video/:id" element={<div>Video destination</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

const albums = [
  { albumId: 'photo', title: 'Portraits', description: 'People', category: 'People', type: 'photo', ownerEmail: ' VIEWER@example.com ', coverImageUrl: 'https://x.test/cover' },
  { albumId: 'uncat', title: 'Uncategorized photos', type: 'photo', ownerEmail: '' },
  { albumId: 'single', title: 'Single Film', type: 'video', category: 'Film', imageCount: 1, ownerEmail: 'viewer@example.com', coverImageUrl: 'single-cover' },
  { albumId: 'series', title: 'Series', type: 'video', imageCount: 3, ownerEmail: 'viewer@example.com' },
  { albumId: 'other', title: 'Other owner', type: 'photo', ownerEmail: 'other@example.com' },
]
const images = [
  { id: 'one', url: 'https://x.test/one-full', thumbnailUrl: 'https://x.test/one-thumb', width: 2400, height: 1800, exif: { model: 'Camera', lens: 'Lens', focalLength: '50mm', focalRatio: 'f/2', shutterSpeed: '1/100', iso: 'ISO 100' }, previewSrcSet: [{ width: 640, url: 'https://x.test/640' }, { width: 960, url: 'https://x.test/960' }, { width: 1440, url: 'https://x.test/1440' }, { width: 1920, url: 'https://x.test/1920' }] },
  { id: 'two', url: 'https://x.test/two-full', thumbnailUrl: 'https://x.test/two-thumb' },
]

describe('UserDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.userEmail = 'viewer@example.com'
    auth.getIdToken.mockResolvedValue('token')
    api.fetchAlbumsFiltered.mockResolvedValue(albums)
    api.fetchAlbum.mockReset().mockResolvedValue({ images })
    api.requestAlbumMediaDownload.mockResolvedValue({ downloadUrl: 'download' })
    api.requestAlbumZip.mockResolvedValue({ status: 'ready', url: 'zip' })
    urls.resolveMediaDownloadUrl.mockImplementation((request) => request().then((value) => value.downloadUrl))
    zip.pollZipJob.mockResolvedValue('https://x.test/archive.zip')
    scroll.getSavedScroll.mockReturnValue(undefined)
    scroll.isRevealed.mockReturnValue(false)
    Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 250 })
    window.requestAnimationFrame = (callback) => { callback(); return 1 }
    window.cancelAnimationFrame = vi.fn()
    window.scrollTo = vi.fn()
  })

  it('loads only owned albums, groups photo/video categories, and refreshes expired covers', async () => {
    mounted()
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(await screen.findByText('Portraits')).toBeInTheDocument()
    expect(screen.getAllByText('Uncategorized')).toHaveLength(2)
    expect(screen.getByText('Your Videos')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.queryByText('Other owner')).toBeNull()
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(api.fetchAlbumsFiltered).toHaveBeenCalledWith({ visibility: 'private' }, 'token', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    fireEvent.mouseEnter(screen.getByText('Portraits').closest('.cursor-pointer'))
    expect(scroll.markAsRevealed).toHaveBeenCalledWith('user-album-photo')
    api.fetchAlbumsFiltered.mockResolvedValueOnce(albums)
    fireEvent.error(screen.getByRole('img', { name: 'Portraits' }))
    await waitFor(() => expect(api.fetchAlbumsFiltered).toHaveBeenCalledTimes(2))
  })

  it('navigates single and multi-video albums while preserving vertical scroll', async () => {
    const first = mounted()
    await screen.findByText('Single Film')
    fireEvent.click(screen.getByText('Single Film').closest('.cursor-pointer'))
    expect(await screen.findByText('Video destination')).toBeInTheDocument()
    expect(scroll.saveVerticalScroll).toHaveBeenCalledWith('/dashboard')
    first.unmount()

    mounted()
    await screen.findByText('Series')
    fireEvent.click(screen.getByText('Series').closest('.cursor-pointer'))
    expect(await screen.findByText('Video destination')).toBeInTheDocument()
  })

  it('opens a photo album, refreshes media, navigates the lightbox, downloads, and returns', async () => {
    mounted()
    fireEvent.click((await screen.findByText('Portraits')).closest('.cursor-pointer'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download All' })).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Back to Albums' })).toBeInTheDocument()
    expect(api.fetchAlbum).toHaveBeenCalledWith('photo', 'token', expect.objectContaining({ signal: expect.any(AbortSignal), force: false }))
    const first = screen.getByRole('img', { name: 'Photo 1 from Portraits' })
    expect(first).toHaveAttribute('srcset')
    api.fetchAlbum.mockRejectedValueOnce(new Error('expired'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fireEvent.error(first)
    expect(await screen.findByRole('alert')).toHaveTextContent('photo links expired')
    api.fetchAlbum.mockResolvedValueOnce({ images })

    fireEvent.click(screen.getByRole('img', { name: 'Photo 1 from Portraits' }))
    expect(screen.getByRole('img', { name: 'Full size preview' })).toHaveAttribute('src', 'https://x.test/one-full')
    expect(screen.getByRole('img', { name: 'Full size preview' })).toHaveClass('linen-lightbox-photo')
    expect(screen.queryByRole('button', { name: 'Share photo' })).toBeNull()
    expect(screen.getByText('Camera')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Download Photo'))
    await waitFor(() => expect(urls.startBrowserDownload).toHaveBeenCalledWith('download', 'one'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('img', { name: 'Full size preview' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Albums' }))
    expect(await screen.findByText('Your Photos')).toBeInTheDocument()
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 250, behavior: 'instant' })
  })

  it.each([
    ['selection', 'success'], ['selection', 'failure'],
    ['route', 'success'], ['route', 'failure'],
  ])('ignores a late background %s change response with %s', async (navigation, outcome) => {
    let resolveRefresh, rejectRefresh
    const pendingRefresh = new Promise((resolve, reject) => {
      resolveRefresh = resolve
      rejectRefresh = reject
    })
    const nextImages = images.map(image => ({ ...image, id: `new-${image.id}`, url: `https://x.test/new-${image.id}` }))
    api.fetchAlbum.mockResolvedValueOnce({ images })
      .mockReturnValueOnce(pendingRefresh)
      .mockResolvedValueOnce({ images: nextImages })
    mounted(true)
    fireEvent.click((await screen.findByText('Portraits')).closest('.cursor-pointer'))
    const first = await screen.findByRole('img', { name: 'Photo 1 from Portraits' })
    fireEvent.error(first)
    await waitFor(() => expect(api.fetchAlbum).toHaveBeenCalledTimes(2))
    const oldSignal = api.fetchAlbum.mock.calls[1][2].signal
    expect(oldSignal.aborted).toBe(false)
    expect(api.fetchAlbum.mock.calls[1][2].force).toBe(true)

    fireEvent.click(screen.getByRole(navigation === 'route' ? 'link' : 'button', {
      name: navigation === 'route' ? 'Reset dashboard' : 'Back to Albums',
    }))
    expect(oldSignal.aborted).toBe(true)
    fireEvent.click((await screen.findByText('Uncategorized photos')).closest('.cursor-pointer'))
    fireEvent.click(await screen.findByRole('button', { name: 'Open item 2 from Uncategorized photos' }))
    expect(screen.getByRole('img', { name: 'Full size preview' })).toHaveAttribute('src', 'https://x.test/new-two')

    await act(async () => {
      if (outcome === 'success') resolveRefresh({ images })
      else rejectRefresh(new Error('Old selection refresh failed'))
      await pendingRefresh.catch(() => {})
    })
    expect(screen.getByText('Uncategorized photos', { selector: 'h2' })).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Photo viewer for Uncategorized photos' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Full size preview' })).toHaveAttribute('src', 'https://x.test/new-two')
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    expect(screen.queryByRole('alert', { hidden: true })).toBeNull()
  })

  it('keeps the selected photo open when the current album refresh completes', async () => {
    let finish
    api.fetchAlbum.mockResolvedValueOnce({ images })
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    mounted()
    fireEvent.click((await screen.findByText('Portraits')).closest('.cursor-pointer'))
    fireEvent.click(await screen.findByRole('button', { name: 'Open item 2 from Portraits' }))
    fireEvent.error(screen.getByRole('img', { name: 'Full size preview' }))
    await waitFor(() => expect(api.fetchAlbum).toHaveBeenCalledTimes(2))
    const refreshedImages = images.map(image => ({ ...image, url: `${image.url}?fresh=1` }))
    await act(async () => finish({ images: refreshedImages }))
    expect(screen.getByRole('dialog', { name: 'Photo viewer for Portraits' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Full size preview' })).toHaveAttribute('src', 'https://x.test/two-full?fresh=1')
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
  })

  it('refreshes a failed original with a single authorized comparison request', async () => {
    const now = Date.now()
    const original = (issuedAt, signature) => {
      const date = new Date(issuedAt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
      const url = `https://originals.example.test/before/photo/one/w640.webp?X-Amz-Date=${date}&X-Amz-Expires=1800&X-Amz-Signature=${signature}`
      return { status: 'ready', width: 640, height: 480, url, srcSet: [{ width: 640, url }], expiresAt: issuedAt + 1_800_000 }
    }
    const previous = original(now - 60_000, 'old')
    const fresh = original(now, 'fresh')
    api.requestAlbumOriginalComparison.mockResolvedValueOnce({ before: fresh })
    api.fetchAlbum.mockResolvedValueOnce({ images: [{ ...images[0], before: previous }] })
      .mockResolvedValue({ images: [{ ...images[0], before: fresh }] })
    mounted()
    fireEvent.click((await screen.findByText('Portraits')).closest('.cursor-pointer'))
    await screen.findByRole('button', { name: 'Open item 1 from Portraits' })
    await act(async () => { await expiry.hook.mock.lastCall[1]('original-status') })
    expect(expiry.hook.mock.lastCall[0][0].before).toBe(previous)
    fireEvent.click(screen.getByRole('button', { name: 'Open item 1 from Portraits' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    const beforeImage = document.querySelector('.linen-lightbox-original')
    expect(beforeImage).toHaveAttribute('src', previous.url)
    fireEvent.error(beforeImage)
    await waitFor(() => expect(document.querySelector('.linen-lightbox-original')).toHaveAttribute('src', fresh.url))
    expect(expiry.hook.mock.lastCall[0][0].before).toBe(previous)
    expect(api.requestAlbumOriginalComparison).toHaveBeenCalledWith('photo', 'one', 'token', { signal: expect.any(AbortSignal) })
    expect(api.fetchAlbum).toHaveBeenCalledTimes(2)
    expect(api.fetchAlbum).toHaveBeenLastCalledWith('photo', 'token', expect.objectContaining({ force: true }))
  })

  it('downloads an album ZIP with status feedback and surfaces ZIP/download errors', async () => {
    let finish
    zip.pollZipJob.mockImplementation(({ onStatus }) => {
      onStatus('rate_limited')
      return new Promise((resolve) => { finish = resolve })
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mounted()
    fireEvent.click((await screen.findByText('Portraits')).closest('.cursor-pointer'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download All' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Download All' }))
    await waitFor(() => expect(zip.pollZipJob).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Waiting…' })).toBeDisabled()
    await act(async () => finish('https://x.test/a.zip'))
    expect(urls.startBrowserDownload).toHaveBeenCalledWith('https://x.test/a.zip', 'Portraits.zip')

    zip.pollZipJob.mockRejectedValueOnce(new Error('ZIP failed'))
    fireEvent.click(screen.getByRole('button', { name: 'Download All' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('ZIP failed')

    urls.resolveMediaDownloadUrl.mockRejectedValueOnce(new Error('download failed'))
    vi.spyOn(window, 'alert').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('img', { name: 'Photo 1 from Portraits' }))
    fireEvent.click(screen.getByTitle('Download Photo'))
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('photo could not be downloaded')))
  })

  it('renders initial, empty, and selected-image failure states and restores saved POP scroll', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    api.fetchAlbumsFiltered.mockRejectedValueOnce(new Error('load failed'))
    const first = mounted()
    expect(await screen.findByText(/albums could not be loaded/)).toBeInTheDocument()
    first.unmount()

    api.fetchAlbumsFiltered.mockResolvedValueOnce([])
    const empty = mounted()
    expect(await screen.findByText('No photos or videos available yet.')).toBeInTheDocument()
    expect(screen.getByText('Check back soon!')).toBeInTheDocument()
    empty.unmount()

    scroll.getSavedScroll.mockReturnValue(333)
    api.fetchAlbumsFiltered.mockResolvedValueOnce(albums)
    api.fetchAlbum.mockRejectedValueOnce(new Error('images failed'))
    mounted()
    fireEvent.click((await screen.findByText('Portraits')).closest('.cursor-pointer'))
    expect(await screen.findByRole('alert')).toHaveTextContent('photos in this album could not be loaded')
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 333, behavior: 'instant' })
  })

  it('skips loading without an authenticated email', () => {
    auth.userEmail = ''
    mounted()
    expect(api.fetchAlbumsFiltered).not.toHaveBeenCalled()
  })
})
