import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  requestUploadUrl: vi.fn(), uploadFileToS3: vi.fn(), createAlbum: vi.fn(), listUsers: vi.fn(), fetchAlbums: vi.fn(),
}))
const auth = vi.hoisted(() => ({ getIdToken: vi.fn() }))
const media = vi.hoisted(() => ({ processImage: vi.fn() }))

vi.mock('../context/auth', () => ({ useAuth: () => auth }))
vi.mock('../utils/api', () => api)
vi.mock('../utils/mediaUtils', () => media)
vi.mock('../utils/concurrency', () => ({
  mapWithConcurrency: async (items, _limit, mapper) => Promise.all(items.map(mapper)),
}))
vi.mock('uuid', () => ({ v4: () => '12345678-abcd-4567-8901-123456789012' }))
vi.mock('framer-motion', () => ({
  motion: new Proxy({}, { get: (_target, tag) => ({ children, ...props }) => {
    const Tag = tag
    const { variants: _variants, initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...domProps } = props
    return <Tag {...domProps}>{children}</Tag>
  } }),
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
    api.requestUploadUrl.mockImplementation(async (_token, _albumId, key, _type, _size, variant) => ({
      uploadUrl: `https://upload.test/${variant}`,
      key: variant === 'original' ? `stored/${key.split('/').pop()}` : `stored/thumb-${key.split('/').pop()}`,
      requiredHeaders: { 'x-test': variant },
    }))
  })

  it('loads users/categories and creates a private album with processed image metadata', async () => {
    const { container } = mounted()
    fireEvent.click(screen.getByRole('button', { name: 'Specific User' }))
    expect(await screen.findByRole('option', { name: 'client@example.com' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'iant4093@gmail.com' })).toBeNull()
    expect(container.querySelector('datalist option[value="Travel"]')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('User Email *'), { target: { value: 'client@example.com' } })

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
    expect(api.requestUploadUrl).toHaveBeenCalledTimes(4)
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

  it('creates a link-only album and falls back to legacy object keys', async () => {
    api.requestUploadUrl.mockResolvedValue({ uploadUrl: 'https://upload.test', requiredHeaders: {} })
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
      coverImageUrl: 'albums/summer-light-12345678/Cover.png',
      coverThumbKey: 'albums/summer-light-12345678/thumb_Cover.png',
    }))
  })

  it('clears a selected owner when returning to the main gallery', async () => {
    mounted()
    fireEvent.click(screen.getByRole('button', { name: 'Specific User' }))
    const select = await screen.findByLabelText('User Email *')
    fireEvent.change(select, { target: { value: 'client@example.com' } })
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

    populate(container, [new File(['one'], 'bad.jpg', { type: 'image/jpeg' })])
    media.processImage.mockRejectedValueOnce({})
    fireEvent.submit(container.querySelector('form'))
    expect(await screen.findByText('Upload failed.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create Album' })).toBeEnabled()
  })
})
