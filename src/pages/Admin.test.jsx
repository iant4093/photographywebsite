import { selectChoice, expectSuggestion } from '../test/selectChoice'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  requestUploadUrls: vi.fn(), uploadFileToS3: vi.fn(), createAlbum: vi.fn(), listUsers: vi.fn(), fetchAlbums: vi.fn(),
}))
const auth = vi.hoisted(() => ({ getIdToken: vi.fn() }))
const media = vi.hoisted(() => ({ processImage: vi.fn() }))
const dates = vi.hoisted(() => ({ currentLocalDateInputValue: vi.fn(() => '2026-08-31') }))

vi.mock('../context/auth', () => ({ useAuth: () => auth }))
vi.mock('../utils/api', () => api)
vi.mock('../utils/mediaUtils', () => media)
vi.mock('../utils/date', () => dates)
vi.mock('../utils/concurrency', () => ({
  mapWithConcurrency: async (items, _limit, mapper) => Promise.all(items.map(mapper)),
}))
vi.mock('uuid', () => ({ v4: () => '12345678-abcd-4567-8901-123456789012' }))
vi.mock('framer-motion', () => ({
  motion: new Proxy({}, { get: (target, tag) => target[tag] ||= (({ children, ...props }) => {
    const Tag = tag
    const { variants: _variants, initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...domProps } = props
    return <Tag {...domProps}>{children}</Tag>
  }) }),
}))

import Admin from './Admin'

function mounted() {
  return render(<MemoryRouter><Admin /></MemoryRouter>)
}

function populate(container, files, { title = 'Summer & Light', category = 'Travel', description = 'A trip', date = '2026-06-15' } = {}) {
  fireEvent.change(screen.getByLabelText('Album Title *'), { target: { value: title } })
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: category } })
  fireEvent.change(screen.getByLabelText('Album Date'), { target: { value: date } })
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: description } })
  fireEvent.change(container.querySelector('input[type="file"]'), { target: { files } })
}

describe('Admin photo upload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.getIdToken.mockResolvedValue('admin-token')
    api.listUsers.mockResolvedValue([{ email: 'client@example.com' }, { email: 'iant4093@gmail.com' }])
    api.fetchAlbums.mockResolvedValue([{ category: 'Travel' }, { category: 'Travel' }, { category: 'People' }, {}])
    api.uploadFileToS3.mockResolvedValue(undefined)
    api.createAlbum.mockResolvedValue({ albumId: 'created' })
    media.processImage.mockImplementation(async () => ({
      thumbnail: new Blob(['thumb'], { type: 'image/jpeg' }), blurhash: 'LEHASH', width: 1800, height: 1200,
    }))
    api.requestUploadUrls.mockImplementation(async (_token, _albumId, files) => ({
      uploads: files.map(({ filename: key, kind: variant }) => ({
        uploadUrl: `https://upload.test/${variant}`,
        key: variant === 'original' ? `stored/${key.split('/').pop()}` : `stored/thumb-${key.split('/').pop()}`,
        requiredHeaders: { 'x-test': variant },
      })),
    }))
  })

  it('shows in-flight byte measurements and keeps saving visible until album confirmation', async () => {
    vi.useFakeTimers()
    try {
      let now = 0
      vi.spyOn(performance, 'now').mockImplementation(() => now)
      const uploads = []
      api.uploadFileToS3.mockImplementation((_url, file, _headers, { onProgress }) => new Promise(resolve => {
        uploads.push({ file, onProgress, resolve })
        onProgress({ loaded: 0, total: file.size })
      }))
      let confirmAlbum
      api.createAlbum.mockImplementation(() => new Promise(resolve => { confirmAlbum = resolve }))
      const { container } = mounted()
      populate(container, [new File([new Uint8Array(2_000_000)], 'large.jpg', { type: 'image/jpeg' })])
      await act(async () => { fireEvent.submit(container.querySelector('form')) })
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
      expect(uploads).toHaveLength(2)
      expect(screen.getByText('Measuring…')).toBeInTheDocument()
      now = 2000
      uploads[0].onProgress({ loaded: 1_000_000 })
      act(() => vi.advanceTimersByTime(500))
      expect(screen.getByText('500.0 KB/s')).toBeInTheDocument()
      expect(screen.getByText('About 3s')).toBeInTheDocument()
      expect(api.createAlbum).not.toHaveBeenCalled()
      await act(async () => { uploads.forEach(({ file, onProgress, resolve }) => { onProgress({ loaded: file.size }); resolve() }) })
      expect(screen.getByRole('status')).toHaveTextContent('Saving album…')
      expect(screen.queryByText('500.0 KB/s')).toBeNull()
      await act(async () => { confirmAlbum({ albumId: 'created' }) })
      expect(screen.getByText('Album created successfully!')).toBeInTheDocument()
      expect(screen.queryByRole('progressbar')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a lost save response with fresh authorization, the same album and no repeated uploads', async () => {
    api.createAlbum.mockRejectedValueOnce(new Error('Save timed out'))
    const { container } = mounted()
    populate(container, [new File(['one'], 'one.jpg', { type: 'image/jpeg' })])
    fireEvent.submit(container.querySelector('form'))
    expect(await screen.findByText('Save timed out')).toBeInTheDocument()
    const firstBody = api.createAlbum.mock.calls[0][1]
    auth.getIdToken.mockResolvedValue('refreshed-token')
    fireEvent.change(screen.getByLabelText('Album Title *'), { target: { value: 'Changed after timeout' } })
    fireEvent.submit(container.querySelector('form'))
    expect(await screen.findByText('Album created successfully!')).toBeInTheDocument()
    expect(api.uploadFileToS3).toHaveBeenCalledTimes(2)
    expect(api.requestUploadUrls).toHaveBeenCalledTimes(1)
    expect(api.createAlbum.mock.calls[1]).toEqual(['refreshed-token', firstBody])
    expect(firstBody.uploadRequestId).toBe(firstBody.albumId)
  })

  it('accepts corrected album details after validation rejection without reuploading', async () => {
    api.createAlbum.mockRejectedValueOnce(Object.assign(new Error('Title is too long'), { status: 400 }))
    const { container } = mounted()
    populate(container, [new File(['one'], 'one.jpg', { type: 'image/jpeg' })], { title: 'x'.repeat(201) })
    fireEvent.submit(container.querySelector('form'))
    expect(await screen.findByText('Title is too long')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Album Title *'), { target: { value: 'Corrected title' } })
    fireEvent.submit(container.querySelector('form'))
    expect(await screen.findByText('Album created successfully!')).toBeInTheDocument()
    expect(api.uploadFileToS3).toHaveBeenCalledTimes(2)
    expect(api.createAlbum.mock.calls[1][1]).toEqual({ ...api.createAlbum.mock.calls[0][1], title: 'Corrected title' })
  })

  it('defaults the album date from the browser local calendar date', () => {
    mounted()

    expect(screen.getByLabelText('Album Date')).toHaveValue('2026-08-31')
    expect(screen.getByRole('button', { name: 'Main Gallery' })).toHaveClass('admin-upload-choice')
    expect(screen.getByRole('button', { name: 'Create Album' })).toHaveClass('admin-upload-submit')
    expect(dates.currentLocalDateInputValue).toHaveBeenCalled()
  })

  it('loads users/categories and creates a private album with processed image metadata', async () => {
    const { container } = mounted()
    fireEvent.click(screen.getByRole('button', { name: 'Specific User' }))
    fireEvent.click(screen.getByRole('combobox', { name: 'User Email *' }))
    expect(await screen.findByRole('option', { name: 'client@example.com' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'iant4093@gmail.com' })).toBeNull()
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'User Email *' }), { key: 'Escape' })
    expect(expectSuggestion(screen.getByLabelText('Category'), 'Travel')).toBeInTheDocument()
    selectChoice(screen.getByLabelText('User Email *'), 'client@example.com')

    const files = [
      new File(['one'], 'One.JPG', { type: 'image/jpeg' }),
      new File(['two'], 'Two.JPG', { type: 'image/jpeg' }),
    ]
    populate(container, files)
    fireEvent.click(screen.getByLabelText('Backup original files to Google Drive'))
    expect(screen.getByText(/2 photos selected/)).toBeInTheDocument()
    fireEvent.submit(container.querySelector('form'))

    expect(await screen.findByText('Album created successfully!')).toBeInTheDocument()
    expect(media.processImage).toHaveBeenCalledTimes(2)
    expect(api.requestUploadUrls).toHaveBeenCalledTimes(1)
    expect(api.uploadFileToS3).toHaveBeenCalledTimes(4)
    expect(api.createAlbum).toHaveBeenCalledWith('admin-token', expect.objectContaining({
      albumId: '12345678-abcd-4567-8901-123456789012',
      title: 'Summer & Light', description: 'A trip', category: 'Travel',
      s3Prefix: 'albums/summer-light-12345678/', visibility: 'private', ownerEmail: 'client@example.com',
      isShared: false, backupToGoogleDrive: true, coverImageUrl: 'stored/One.JPG',
      coverThumbKey: 'stored/thumb-thumb_One.JPG', coverBlurhash: 'LEHASH',
      createdAt: new Date('2026-06-15T12:00:00').toISOString(),
      images: [
        expect.objectContaining({ rawKey: 'stored/One.JPG', width: 1800, height: 1200 }),
        expect.objectContaining({ rawKey: 'stored/Two.JPG', width: 1800, height: 1200 }),
      ],
    }))
    expect(screen.getByLabelText('Album Title *')).toHaveValue('')
  })

  it('creates a link-only album using server-selected object keys', async () => {
    api.requestUploadUrls.mockImplementation(async (_token, albumId, files) => ({ uploads: files.map(({ kind }) => ({ uploadUrl: 'https://upload.test', key: `albums/${albumId}/${kind}/server.jpg`, requiredHeaders: {} })) }))
    api.createAlbum.mockResolvedValue({ shareCode: 'share-123' })
    const { container } = mounted()
    fireEvent.click(screen.getByRole('button', { name: 'Link Only' }))
    await waitFor(() => expect(api.fetchAlbums).toHaveBeenCalled())
    populate(container, [new File(['one'], 'Cover.png', { type: 'image/png' })], { category: '' })
    fireEvent.submit(container.querySelector('form'))

    expect(await screen.findByText('Link Only album created successfully!')).toBeInTheDocument()
    expect(screen.getByText(`${window.location.origin}/sharedalbum/share-123`)).toBeInTheDocument()
    expect(api.createAlbum).toHaveBeenCalledWith('admin-token', expect.objectContaining({
      category: 'Uncategorized', visibility: 'unlisted', ownerEmail: '', isShared: true,
      coverImageUrl: 'albums/12345678-abcd-4567-8901-123456789012/original/server.jpg',
      coverThumbKey: 'albums/12345678-abcd-4567-8901-123456789012/thumbnail/server.jpg',
    }))
  })

  it('clears a selected owner when returning to the main gallery', async () => {
    mounted()
    fireEvent.click(screen.getByRole('button', { name: 'Specific User' }))
    const select = await screen.findByLabelText('User Email *')
    fireEvent.click(select)
    await screen.findByRole('option', { name: 'client@example.com' })
    selectChoice(select, 'client@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Main Gallery' }))
    expect(screen.queryByLabelText('User Email *')).toBeNull()
    expect(api.listUsers).toHaveBeenCalledTimes(1)
    expect(api.fetchAlbums).toHaveBeenCalledTimes(2)
  })

  it('surfaces upload failures and tolerates user/category discovery failures', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    api.listUsers.mockRejectedValueOnce(new Error('users unavailable'))
    api.fetchAlbums.mockRejectedValueOnce(new Error('categories unavailable'))
    const { container } = mounted()
    fireEvent.click(screen.getByRole('button', { name: 'Specific User' }))
    await waitFor(() => expect(console.error).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: 'Main Gallery' }))

    populate(container, [new File(['one'], 'bad.jpg', { type: 'image/jpeg' })])
    media.processImage.mockRejectedValueOnce({})
    fireEvent.submit(container.querySelector('form'))
    expect(await screen.findByText('Upload failed.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create Album' })).toBeEnabled()
  })
})
