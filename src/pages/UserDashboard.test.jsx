import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  fetchAlbumsFiltered: vi.fn(), fetchAlbum: vi.fn(), requestAlbumMediaDownload: vi.fn(), requestAlbumZip: vi.fn(),
}))
const auth = vi.hoisted(() => ({ userEmail: 'viewer@example.com', getIdToken: vi.fn() }))
const urls = vi.hoisted(() => ({ startBrowserDownload: vi.fn(), resolveMediaDownloadUrl: vi.fn() }))
const zip = vi.hoisted(() => ({ pollZipJob: vi.fn() }))
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
  useMediaExpiryRefresh: (_items, callback) => (reason) => Promise.resolve(callback(reason)).catch(() => false),
}))
vi.mock('../components/ProgressiveImage', () => ({ default: ({ alt, src, srcSet, onError }) => <img alt={alt} src={src} srcSet={srcSet} onError={onError} /> }))
vi.mock('../components/ScrollRow', () => ({ default: ({ children, scrollKey }) => <div data-testid={scrollKey}>{children}</div> }))
vi.mock('../components/SkeletonGrid', () => ({ default: () => <div role="status">Loading private albums</div> }))
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => children,
  motion: new Proxy({}, { get: (_target, tag) => ({ children, ...props }) => {
    const Tag = tag
    const {
      onViewportEnter, variants: _variants, initial: _initial, animate: _animate, exit: _exit,
      transition: _transition, whileInView: _whileInView, viewport: _viewport, ...domProps
    } = props
    return <Tag onMouseEnter={onViewportEnter} {...domProps}>{children}</Tag>
  } }),
}))

import UserDashboard from './UserDashboard'

function mounted() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
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
  { id: 'one', url: 'https://x.test/one-full', thumbnailUrl: 'https://x.test/one-thumb', width: 1600, height: 1200, exif: { model: 'Camera', lens: 'Lens', focalLength: '50mm', focalRatio: 'f/2', shutterSpeed: '1/100', iso: 'ISO 100' }, previewSrcSet: [{ width: 640, url: 'https://x.test/640' }, { width: 1280, url: 'https://x.test/1280' }] },
  { id: 'two', url: 'https://x.test/two-full', thumbnailUrl: 'https://x.test/two-thumb' },
]

describe('UserDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.userEmail = 'viewer@example.com'
    auth.getIdToken.mockResolvedValue('token')
    api.fetchAlbumsFiltered.mockResolvedValue(albums)
    api.fetchAlbum.mockResolvedValue({ images })
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
    expect(api.fetchAlbum).toHaveBeenCalledWith('photo', 'token')
    const first = screen.getByRole('img', { name: 'Photo 1 from Portraits' })
    expect(first).toHaveAttribute('srcset')
    api.fetchAlbum.mockRejectedValueOnce(new Error('expired'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fireEvent.error(first)
    expect(await screen.findByRole('alert')).toHaveTextContent('photo links expired')
    api.fetchAlbum.mockResolvedValueOnce({ images })

    fireEvent.click(screen.getByRole('img', { name: 'Photo 1 from Portraits' }))
    expect(screen.getByRole('img', { name: 'Full size preview' })).toHaveAttribute('src', 'https://x.test/one-full')
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
