import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { selectChoice } from '../test/selectChoice'
import { clearCatalogSnapshots, setCatalogSnapshot } from '../utils/catalogState'
import { clearFeaturedPhotoSessionCache } from '../utils/featuredPhotoSession'
import { clearRandomPhotoSessionCache } from '../utils/randomPhotoSession'
import { fetchSectionStats } from '../utils/sectionStats'
import SectionAlbums from './SectionAlbums'

const api = vi.hoisted(() => ({
    fetchAlbumsPage: vi.fn(),
    fetchFeaturedPhotos: vi.fn(),
    fetchRandomPhotos: vi.fn(),
    requestAlbumMediaDownload: vi.fn(),
    requestAlbumPrintSession: vi.fn(),
    requestAlbumOriginalComparison: vi.fn(),
}))
vi.mock('../utils/api', () => api)
vi.mock('../utils/sectionStats', () => ({ fetchSectionStats: vi.fn() }))
vi.mock('../components/AlbumCard', () => ({ default: ({ album }) => <Link to={`/album/${album.albumId}`}>{album.title}</Link> }))
vi.mock('../components/VideoAlbumCard', () => ({ default: ({ album }) => <Link to={`/video/${album.albumId}`}>{album.title}</Link> }))
vi.mock('../components/PhotoLightbox', () => ({ default: ({ images, ariaLabel, onClose }) => <div role="dialog" aria-label={ariaLabel}>
    {images.length} photographs
    <button onClick={onClose}>Close viewer</button>
</div> }))

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
    beforeEach(() => {
        clearCatalogSnapshots()
        clearFeaturedPhotoSessionCache()
        clearRandomPhotoSessionCache()
        Object.values(api).forEach(mock => mock.mockReset())
        fetchSectionStats.mockReset()
    })

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
        expect(screen.queryByRole('group', { name: /photo tools/ })).not.toBeInTheDocument()
    })

    it('opens all three photo tools for the current section across all years without fetching on mount', async () => {
        const category = 'Trips / 100% & Friends'
        setCatalogSnapshot('public-photos', { items: [album('New', category), album('Old', category, { createdAt: '2024-05-01T12:00:00Z' })], nextCursor: null })
        const photo = { id: 'one', albumId: 'Old', isFavorite: true, thumbnailUrl: 'https://media.test/one.webp' }
        api.fetchFeaturedPhotos.mockResolvedValue({ images: [photo], totalPhotos: 1 })
        api.fetchRandomPhotos.mockResolvedValue({ images: [photo], totalPhotos: 1 })
        fetchSectionStats.mockResolvedValue({ albumCount: 2, photoCount: 1, cameras: [], lenses: [] })
        mount(`/sections/photo/${encodeURIComponent(category)}`)

        const featured = await screen.findByRole('button', { name: `Explore featured photos in ${category}` })
        const random = screen.getByRole('button', { name: `Shuffle ${category} photos` })
        const stats = screen.getByRole('button', { name: `Show ${category} statistics` })
        expect(api.fetchFeaturedPhotos).not.toHaveBeenCalled()
        expect(api.fetchRandomPhotos).not.toHaveBeenCalled()
        expect(fetchSectionStats).not.toHaveBeenCalled()
        selectChoice(screen.getByRole('combobox'), '2024')

        fireEvent.click(featured)
        await waitFor(() => expect(screen.getByRole('dialog', { name: `Featured photos from ${category}` })).toHaveTextContent('1 photographs'))
        expect(api.fetchFeaturedPhotos).toHaveBeenCalledExactlyOnceWith({ category, limit: 6, signal: expect.any(AbortSignal) })
        fireEvent.click(screen.getByRole('button', { name: 'Close viewer' }))

        fireEvent.click(random)
        await waitFor(() => expect(screen.getByRole('dialog', { name: `Random photos from ${category}` })).toHaveTextContent('1 photographs'))
        expect(api.fetchRandomPhotos).toHaveBeenCalledExactlyOnceWith({ category, limit: 6, signal: expect.any(AbortSignal) })
        fireEvent.click(screen.getByRole('button', { name: 'Close viewer' }))

        fireEvent.click(stats)
        expect(await screen.findByRole('dialog', { name: `${category} statistics` })).toHaveTextContent('Section statistics · All years')
        await waitFor(() => expect(fetchSectionStats).toHaveBeenCalledExactlyOnceWith(category, { signal: expect.any(AbortSignal) }))
        fireEvent.click(screen.getByRole('button', { name: 'Close section statistics' }))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(screen.getByRole('combobox')).toHaveValue('2024')
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
