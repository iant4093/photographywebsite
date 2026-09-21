import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { selectChoice } from '../test/selectChoice'
import { clearCatalogSnapshots, setCatalogSnapshot } from '../utils/catalogState'
import SectionAlbums from './SectionAlbums'

const api = vi.hoisted(() => ({ fetchAlbumsPage: vi.fn() }))
vi.mock('../utils/api', () => api)
vi.mock('../components/AlbumCard', () => ({ default: ({ album }) => <Link to={`/album/${album.albumId}`}>{album.title}</Link> }))
vi.mock('../components/VideoAlbumCard', () => ({ default: ({ album }) => <Link to={`/video/${album.albumId}`}>{album.title}</Link> }))

const album = (albumId, category, extra = {}) => ({ albumId, category, title: albumId, type: 'photo', visibility: 'public', createdAt: '2026-03-04T12:00:00Z', ...extra })
function Detail() {
    const navigate = useNavigate()
    return <button onClick={() => navigate(-1)}>Return from album</button>
}
function mount(path = '/sections/photo/Travel') {
    return render(<MemoryRouter initialEntries={[path]}><Routes>
        <Route path="/sections/:mediaType/:category" element={<SectionAlbums />} />
        <Route path="/album/:id" element={<Detail />} />
    </Routes></MemoryRouter>)
}

describe('section album pages', () => {
    beforeEach(() => { clearCatalogSnapshots(); api.fetchAlbumsPage.mockReset() })

    it('loads every page, limits albums to the section and media type, and preserves curated order', async () => {
        api.fetchAlbumsPage.mockResolvedValueOnce({ items: [album('Second', 'Travel', { galleryOrder: 2 }), album('Elsewhere', 'People')], nextCursor: 'next-page' })
            .mockResolvedValueOnce({ items: [album('First', 'Travel', { galleryOrder: 1 }), album('Private', 'Travel', { visibility: 'private' }), album('Video', 'Travel', { type: 'video' })], nextCursor: null })
        mount()
        await screen.findByRole('link', { name: 'First' })
        expect(screen.getAllByRole('link').map(link => link.textContent)).toEqual(['First', 'Second'])
        expect(api.fetchAlbumsPage).toHaveBeenLastCalledWith({ visibility: 'public', type: 'photo', limit: 100, cursor: 'next-page' }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    })

    it('reuses the public catalog and retains the year filter after visiting an album', async () => {
        setCatalogSnapshot('public-photos', { items: [album('New', 'Travel'), album('Old', 'Travel', { createdAt: '2024-05-01T12:00:00Z' })], nextCursor: null })
        mount()
        await screen.findByRole('link', { name: 'Old' })
        selectChoice(screen.getByRole('combobox'), '2024')
        fireEvent.click(screen.getByRole('link', { name: 'Old' }))
        fireEvent.click(screen.getByRole('button', { name: 'Return from album' }))
        expect(await screen.findByRole('link', { name: 'Old' })).toBeInTheDocument()
        expect(screen.queryByRole('link', { name: 'New' })).toBeNull()
        expect(screen.getByRole('combobox')).toHaveValue('2024')
        expect(api.fetchAlbumsPage).not.toHaveBeenCalled()
    })

    it('supports video sections and names containing reserved characters', async () => {
        api.fetchAlbumsPage.mockResolvedValue({ items: [album('Film', 'Trips / 100% & Friends', { type: 'video' })], nextCursor: null })
        mount(`/sections/video/${encodeURIComponent('Trips / 100% & Friends')}`)
        expect(await screen.findByRole('link', { name: 'Film' })).toHaveAttribute('href', '/video/Film')
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Trips / 100% & Friends')
    })

    it('handles empty sections and retryable failures', async () => {
        api.fetchAlbumsPage.mockRejectedValueOnce(new Error('Temporarily unavailable')).mockResolvedValueOnce({ items: [], nextCursor: null })
        mount()
        expect(await screen.findByRole('alert')).toHaveTextContent('Temporarily unavailable')
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
        expect(await screen.findByText('No photo albums in this section yet.')).toBeInTheDocument()
        await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    })

    it('does not fetch unsupported media types', () => {
        mount('/sections/missing/Travel')
        expect(screen.getByRole('heading', { name: 'Section not found' })).toBeInTheDocument()
        expect(api.fetchAlbumsPage).not.toHaveBeenCalled()
    })
})
