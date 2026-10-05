import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ fetchAlbumsFiltered: vi.fn(), updateAlbum: vi.fn(), deleteAlbum: vi.fn() }))
const auth = vi.hoisted(() => ({ getIdToken: vi.fn() }))

vi.mock('../context/auth', () => ({ useAuth: () => auth }))
vi.mock('../utils/api', () => api)

import RecentlyDeleted from './RecentlyDeleted'

const DAY = 24 * 60 * 60 * 1000
const ago = (days) => new Date(Date.now() - days * DAY).toISOString()

const albums = [
  { albumId: 'older', title: 'Old Trip', type: 'photo', imageCount: 1, trashedAt: ago(29.5), trashedFrom: { visibility: 'public' } },
  { albumId: 'client', title: 'Wedding', type: 'photo', imageCount: 24, coverThumbnailUrl: 'https://cdn.test/w.jpg', trashedAt: ago(2), trashedFrom: { visibility: 'private', ownerEmail: 'client@example.com' } },
  { albumId: 'film', title: 'Film', type: 'video', imageCount: 3, trashedAt: ago(10), trashedFrom: { visibility: 'unlisted', isShared: true } },
  { albumId: 'expired', title: 'Expired', type: 'video', trashedAt: ago(31), trashedFrom: { visibility: 'unlisted' } },
  { albumId: 'broken', title: 'Broken', type: 'photo', trashedAt: 'later' },
  { albumId: 'one-video', title: 'One Video', type: 'video', imageCount: 1, trashedAt: ago(5), trashedFrom: { visibility: 'private' } },
]

function mounted() {
  return render(<MemoryRouter><RecentlyDeleted /></MemoryRouter>)
}

const row = (title) => screen.getByRole('heading', { name: title }).closest('li')

describe('RecentlyDeleted', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.getIdToken.mockResolvedValue('admin-token')
    api.fetchAlbumsFiltered.mockResolvedValue(albums)
    api.updateAlbum.mockResolvedValue({})
    api.deleteAlbum.mockResolvedValue({})
  })

  it('lists deleted albums newest first with where they were and when they go', async () => {
    mounted()
    expect(screen.getByRole('status')).toHaveTextContent('Loading')
    await screen.findByText('Wedding')
    expect(api.fetchAlbumsFiltered).toHaveBeenCalledWith({ visibility: 'unlisted', trashed: '1', limit: 100 }, 'admin-token', { force: true })
    const titles = within(screen.getByRole('list', { name: 'Recently deleted albums' })).getAllByRole('heading').map((heading) => heading.textContent)
    expect(titles).toEqual(['Broken', 'Wedding', 'One Video', 'Film', 'Old Trip', 'Expired'])
    expect(row('Wedding')).toHaveTextContent('Photo album · 24 photos · was in Client: client@example.com')
    expect(row('Wedding')).toHaveTextContent(/in 28 days\)/)
    expect(row('Wedding').querySelector('img')).toHaveAttribute('src', 'https://cdn.test/w.jpg')
    expect(row('Film')).toHaveTextContent('Video album · 3 videos · was in Link only (shared)')
    expect(row('Old Trip')).toHaveTextContent('Photo album · 1 photo · was in Main Gallery')
    expect(row('Old Trip')).toHaveTextContent('(in 1 day)')
    expect(row('Expired')).toHaveTextContent('Video album · was in Link only')
    expect(row('Expired')).toHaveTextContent('Permanently deleted within a day')
    expect(row('Broken')).toHaveTextContent('Photo album · was in Link only')
    expect(row('One Video')).toHaveTextContent('Video album · 1 video · was in Specific user')
  })

  it('restores an album and removes it from the list', async () => {
    mounted()
    await screen.findByText('Wedding')
    fireEvent.click(within(row('Wedding')).getByRole('button', { name: 'Restore' }))
    expect(within(row('Wedding')).getByRole('button', { name: 'Working…' })).toBeDisabled()
    await waitFor(() => expect(api.updateAlbum).toHaveBeenCalledWith('admin-token', 'client', { restore: true }))
    expect(await screen.findByText('"Wedding" restored (Client: client@example.com).')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Wedding' })).toBeNull()
  })

  it('deletes permanently only after confirmation and reports failures', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true)
    api.deleteAlbum.mockRejectedValueOnce(new Error('Album changed or cleanup is already running. Please retry shortly.'))
    mounted()
    await screen.findByText('Film')
    const button = () => within(row('Film')).getByRole('button', { name: 'Delete permanently' })
    fireEvent.click(button())
    expect(api.deleteAlbum).not.toHaveBeenCalled()
    fireEvent.click(button())
    expect(await screen.findByText('Album changed or cleanup is already running. Please retry shortly.')).toBeInTheDocument()
    expect(row('Film')).toBeInTheDocument()
    await waitFor(() => expect(button()).toBeEnabled())
    fireEvent.click(button())
    expect(await screen.findByText('"Film" permanently deleted.')).toBeInTheDocument()
    expect(api.deleteAlbum).toHaveBeenLastCalledWith('admin-token', 'film')
    expect(screen.queryByRole('heading', { name: 'Film' })).toBeNull()
    expect(confirm).toHaveBeenCalledTimes(3)

    api.updateAlbum.mockRejectedValueOnce({})
    fireEvent.click(within(row('Wedding')).getByRole('button', { name: 'Restore' }))
    expect(await screen.findByText('That did not work. Please try again.')).toBeInTheDocument()
  })

  it('shows an empty state, and a retry after a failed load', async () => {
    api.fetchAlbumsFiltered.mockRejectedValueOnce(new Error('Albums unavailable')).mockResolvedValueOnce([])
    mounted()
    expect(await screen.findByText('Recently deleted albums could not be loaded.')).toBeInTheDocument()
    expect(screen.getByText('Albums unavailable')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Nothing here')).toBeInTheDocument()

    api.fetchAlbumsFiltered.mockRejectedValueOnce({})
    const { unmount } = mounted()
    expect((await screen.findAllByText('Recently deleted albums could not be loaded.')).length).toBeGreaterThan(0)
    unmount()
  })
})
