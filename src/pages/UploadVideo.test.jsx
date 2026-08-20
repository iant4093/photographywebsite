import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  requestUploadUrl: vi.fn(), uploadFileToS3: vi.fn(), createAlbum: vi.fn(), listUsers: vi.fn(), fetchAlbums: vi.fn(),
}))
const auth = vi.hoisted(() => ({ getIdToken: vi.fn() }))
const media = vi.hoisted(() => ({ processVideo: vi.fn() }))
const dates = vi.hoisted(() => ({ currentLocalDateInputValue: vi.fn(() => '2026-08-31') }))

vi.mock('../context/auth', () => ({ useAuth: () => auth }))
vi.mock('../utils/api', () => api)
vi.mock('../utils/mediaUtils', () => media)
vi.mock('../utils/date', () => dates)
vi.mock('../utils/concurrency', () => ({
  mapWithConcurrency: async (items, _limit, mapper) => Promise.all(items.map(mapper)),
}))
vi.mock('uuid', () => ({ v4: () => '87654321-abcd-4567-8901-123456789012' }))

import UploadVideo from './UploadVideo'

function mounted() {
  return render(<MemoryRouter><UploadVideo /></MemoryRouter>)
}

function populate(container, files, { title = 'Wedding Film!', category = 'Weddings', description = 'Highlights', date = '2026-05-04' } = {}) {
  fireEvent.change(screen.getByPlaceholderText('e.g. Cinematic Wedding Highlight'), { target: { value: title } })
  fireEvent.change(screen.getByPlaceholderText('e.g. Weddings, Commercial...'), { target: { value: category } })
  fireEvent.change(container.querySelector('input[type="date"]'), { target: { value: date } })
  fireEvent.change(screen.getByPlaceholderText('Optional metadata or context...'), { target: { value: description } })
  fireEvent.change(container.querySelector('input[type="file"]'), { target: { files } })
}

describe('UploadVideo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.getIdToken.mockResolvedValue('admin-token')
    api.listUsers.mockResolvedValue([{ email: 'client@example.com' }, { email: 'iant4093@gmail.com' }])
    api.fetchAlbums.mockResolvedValue([{ category: 'Weddings' }, { category: 'Weddings' }, { category: 'Commercial' }, {}])
    api.uploadFileToS3.mockResolvedValue(undefined)
    api.createAlbum.mockResolvedValue({ albumId: 'created' })
    media.processVideo.mockResolvedValue({
      thumbnail: new Blob(['poster'], { type: 'image/jpeg' }), blurhash: 'VIDEOHASH', width: 1920, height: 1080,
    })
    api.requestUploadUrl.mockImplementation(async (_token, _albumId, key, _type, _size, variant) => ({
      uploadUrl: `https://upload.test/${variant}`,
      key: variant === 'original' ? `stored/${key.split('/').pop()}` : `stored/${key.split('/').pop()}`,
      requiredHeaders: { 'x-test': variant },
    }))
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn((file) => `blob:${file.name}`),
      revokeObjectURL: vi.fn(),
    })
  })

  it('defaults the album date from the browser local calendar date', () => {
    const { container } = mounted()

    expect(container.querySelector('input[type="date"]')).toHaveValue('2026-08-31')
    expect(screen.getByRole('button', { name: 'Main Gallery' })).toHaveClass('admin-upload-choice')
    expect(screen.getByRole('button', { name: 'Upload Video(s)' })).toHaveClass('admin-upload-submit')
    expect(dates.currentLocalDateInputValue).toHaveBeenCalled()
  })

  it('loads categories and private users, adjusts thumbnail times, and creates a private video album', async () => {
    const { container, unmount } = mounted()
    await waitFor(() => expect(api.fetchAlbums).toHaveBeenCalled())
    expect(container.querySelector('datalist option[value="Weddings"]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Specific User' }))
    expect(await screen.findByRole('option', { name: 'client@example.com' })).toBeInTheDocument()
    const select = container.querySelector('select')
    expect(screen.queryByRole('option', { name: 'iant4093@gmail.com' })).toBeNull()
    fireEvent.change(select, { target: { value: 'client@example.com' } })

    const files = [
      new File(['one'], 'first.mov', { type: 'video/quicktime' }),
      new File(['two'], 'second.mp4', { type: 'video/mp4' }),
    ]
    populate(container, files)
    expect(screen.getByText('Adjust Thumbnails (Optional):')).toBeInTheDocument()
    const firstVideo = container.querySelector('video')
    Object.defineProperty(firstVideo, 'duration', { configurable: true, value: 42 })
    fireEvent.loadedMetadata(firstVideo)
    expect(container.querySelector('input[type="range"]')).toHaveAttribute('max', '42')
    fireEvent.change(container.querySelector('input[type="range"]'), { target: { value: '7' } })
    expect(screen.getByText('7s')).toBeInTheDocument()
    expect(firstVideo.currentTime).toBe(7)
    fireEvent.click(screen.getByLabelText('Backup original files to Google Drive'))
    fireEvent.submit(container.querySelector('form'))

    expect(await screen.findByText(/Video album created successfully!/)).toBeInTheDocument()
    expect(media.processVideo).toHaveBeenCalledWith(files[0], 7)
    expect(media.processVideo).toHaveBeenCalledWith(files[1], 0)
    expect(api.requestUploadUrl).toHaveBeenCalledTimes(4)
    expect(api.uploadFileToS3).toHaveBeenCalledTimes(4)
    expect(api.createAlbum).toHaveBeenCalledWith('admin-token', expect.objectContaining({
      albumId: '87654321-abcd-4567-8901-123456789012', type: 'video', title: 'Wedding Film!',
      description: 'Highlights', category: 'Weddings', s3Prefix: 'albums/wedding-film-87654321/',
      visibility: 'private', ownerEmail: 'client@example.com', isShared: false, backupToGoogleDrive: true,
      coverImageUrl: 'stored/thumb_first.mov.jpg', coverThumbKey: 'stored/thumb_first.mov.jpg', coverBlurhash: 'VIDEOHASH',
      createdAt: new Date('2026-05-04T12:00:00').toISOString(),
      images: [
        expect.objectContaining({ rawKey: 'stored/first.mov', thumbKey: 'stored/thumb_first.mov.jpg', thumbnailTime: 7 }),
        expect.objectContaining({ rawKey: 'stored/second.mp4', thumbKey: 'stored/thumb_second.mp4.jpg', thumbnailTime: 0 }),
      ],
    }))
    expect(container.querySelectorAll('video')).toHaveLength(0)
    unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalled()
  })

  it('creates a link-only video album with legacy keys and a share URL', async () => {
    api.requestUploadUrl.mockResolvedValue({ uploadUrl: 'https://upload.test', requiredHeaders: {} })
    api.createAlbum.mockResolvedValue({ shareCode: 'film-share' })
    const { container } = mounted()
    fireEvent.click(screen.getByRole('button', { name: 'Link Only' }))
    const file = new File(['film'], 'clip.mp4', { type: 'video/mp4' })
    populate(container, [file], { category: '' })
    fireEvent.submit(container.querySelector('form'))

    expect(await screen.findByText('Link Only video album created successfully!')).toBeInTheDocument()
    expect(screen.getByText(`${window.location.origin}/sharedalbum/film-share`)).toBeInTheDocument()
    expect(api.createAlbum).toHaveBeenCalledWith('admin-token', expect.objectContaining({
      category: 'Uncategorized', visibility: 'unlisted', ownerEmail: '', isShared: true,
      coverImageUrl: 'albums/wedding-film-87654321/thumb_clip.mp4.jpg',
      images: [expect.objectContaining({ rawKey: 'albums/wedding-film-87654321/clip.mp4' })],
    }))
  })

  it('uses the default scrubber range before metadata and can return to public visibility', async () => {
    const { container } = mounted()
    fireEvent.click(screen.getByRole('button', { name: 'Specific User' }))
    await screen.findByRole('option', { name: 'client@example.com' })
    populate(container, [new File(['film'], 'clip.mp4', { type: 'video/mp4' })])
    expect(container.querySelector('input[type="range"]')).toHaveAttribute('max', '100')
    fireEvent.click(screen.getByRole('button', { name: 'Main Gallery' }))
    expect(container.querySelector('select')).toBeNull()
  })

  it('reports discovery and upload errors without leaving the form disabled', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    api.fetchAlbums.mockRejectedValue(new Error('categories unavailable'))
    api.listUsers.mockRejectedValueOnce(new Error('users unavailable'))
    const { container } = mounted()
    await waitFor(() => expect(console.error).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Specific User' }))
    await waitFor(() => expect(api.listUsers).toHaveBeenCalled())
    populate(container, [new File(['film'], 'bad.mp4', { type: 'video/mp4' })])
    media.processVideo.mockRejectedValueOnce({})
    fireEvent.submit(container.querySelector('form'))
    expect(await screen.findByText('Upload failed.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Upload Video(s)' })).toBeEnabled()
  })

  it('shows an actionable message for a browser-incompatible video codec', async () => {
    const { container } = mounted()
    populate(container, [new File(['film'], 'camera.mov', { type: 'video/quicktime' })])
    media.processVideo.mockRejectedValueOnce(new Error(
      'This video codec cannot be decoded by your browser. Export the video as H.264 MP4 and try again.',
    ))
    fireEvent.submit(container.querySelector('form'))

    expect(await screen.findByText(/Export the video as H\.264 MP4/i)).toBeInTheDocument()
    expect(api.requestUploadUrl).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Upload Video(s)' })).toBeEnabled()
  })
})
