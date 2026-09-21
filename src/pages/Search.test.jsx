import { selectChoice } from '../test/selectChoice'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ fetchAlbumsPage: vi.fn() }))
const catalog = vi.hoisted(() => ({
    snapshots: new Map(),
    deleteCatalogSnapshot: vi.fn(),
    getCatalogSnapshot: vi.fn(),
    loadCompleteCatalog: vi.fn(),
    reconcilePublicCatalogItems: vi.fn(),
    setCatalogSnapshot: vi.fn(),
}))

vi.mock('../utils/api', () => ({ fetchAlbumsPage: api.fetchAlbumsPage }))
vi.mock('../utils/catalogState', () => ({
    CatalogPaginationError: class CatalogPaginationError extends Error {},
    deleteCatalogSnapshot: catalog.deleteCatalogSnapshot,
    getCatalogSnapshot: catalog.getCatalogSnapshot,
    loadCompleteCatalog: catalog.loadCompleteCatalog,
    reconcilePublicCatalogItems: catalog.reconcilePublicCatalogItems,
    setCatalogSnapshot: catalog.setCatalogSnapshot,
}))
vi.mock('../components/AlbumCard', () => ({
    default: ({ album, imageSizes }) => (
        <a
            href={`/${album.type === 'video' ? 'video' : 'album'}/${album.albumId}`}
            data-testid="search-result"
            data-image-sizes={imageSizes}
        >
            {album.title}
        </a>
    ),
}))
vi.mock('../components/SkeletonGrid', () => ({
    default: () => <div role="status">Loading test archive</div>,
}))

import Search from './Search'

const PHOTO_ALBUMS = [
    {
        albumId: 'birds', type: 'photo', title: 'Finley Birds', description: 'Winter wildlife',
        category: 'Wildlife', createdAt: '2026-02-11T00:00:00Z',
    },
    {
        albumId: 'spain', type: 'photo', title: 'Streets of Madrid', description: 'A city walk',
        category: 'Spain 2026', createdAt: '2025-08-03T00:00:00Z',
    },
]
const VIDEO_ALBUMS = [
    {
        albumId: 'bird-film', type: 'video', title: 'Bird in Flight', description: 'Slow motion study',
        category: 'Wildlife', createdAt: '2024-05-01T00:00:00Z',
    },
]

function LocationProbe() {
    const location = useLocation()
    const navigate = useNavigate()
    return <><output aria-label="Current query">{location.search}</output><button onClick={() => navigate('/search?q=city')}>Navigate search</button></>
}

function renderSearch(entry = '/search') {
    return render(
        <MemoryRouter initialEntries={[entry]}>
            <Search />
            <LocationProbe />
        </MemoryRouter>,
    )
}

describe('Search', () => {
    afterEach(() => vi.useRealTimers())
    beforeEach(() => {
        vi.clearAllMocks()
        catalog.snapshots.clear()
        catalog.snapshots.set('public-photos', { items: PHOTO_ALBUMS, nextCursor: null })
        catalog.snapshots.set('public-videos', { items: VIDEO_ALBUMS, nextCursor: null })
        catalog.getCatalogSnapshot.mockImplementation((key) => catalog.snapshots.get(key) || null)
        catalog.setCatalogSnapshot.mockImplementation((key, snapshot) => catalog.snapshots.set(key, snapshot))
        catalog.deleteCatalogSnapshot.mockImplementation((key) => catalog.snapshots.delete(key))
        catalog.reconcilePublicCatalogItems.mockImplementation((items, type) => items.filter((album) => (
            type === 'video' ? album.type === 'video' : album.type !== 'video'
        )))
        catalog.loadCompleteCatalog.mockImplementation(async ({
            fetchPage,
            initialItems = [],
            initialCursor = null,
            hasInitialPage,
            onPage,
        }) => {
            if (hasInitialPage && !initialCursor) return { items: initialItems, nextCursor: null }
            const page = await fetchPage(initialCursor)
            const result = { items: [...initialItems, ...(page.items || [])], nextCursor: page.nextCursor || null }
            onPage?.(result)
            return result
        })
    })

    it('searches the complete archive and keeps shareable filters in the URL', async () => {
        renderSearch('/search?q=bird&type=photo')

        expect(screen.getByRole('link', { name: 'Finley Birds' })).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Finley Birds' }))
            .toHaveAttribute('data-image-sizes', expect.stringContaining('(min-width: 1440px) 520px'))
        expect(screen.queryByRole('link', { name: 'Bird in Flight' })).toBeNull()
        expect(screen.getByText((_content, node) => node?.tagName === 'P' && node.textContent.includes('1 album matching')))
            .toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
        selectChoice(screen.getByLabelText('Format'), 'video')
        expect(screen.getByRole('link', { name: 'Bird in Flight' })).toBeInTheDocument()
        expect(screen.queryByRole('link', { name: 'Finley Birds' })).toBeNull()
        expect(screen.getByLabelText('Current query')).toHaveTextContent('?type=video')

        selectChoice(screen.getByLabelText('Format'), 'all')
        selectChoice(screen.getByLabelText('Category'), 'Wildlife')
        expect(screen.getAllByTestId('search-result')).toHaveLength(2)
        selectChoice(screen.getByLabelText('Year'), '2026')
        expect(screen.getByRole('link', { name: 'Finley Birds' })).toBeInTheDocument()
        expect(screen.queryByRole('link', { name: 'Bird in Flight' })).toBeNull()

        fireEvent.click(screen.getByRole('button', { name: 'Reset search' }))
        expect(screen.getByLabelText('Current query')).toBeEmptyDOMElement()
        expect(screen.getAllByTestId('search-result')).toHaveLength(3)
    })

    it('sorts by title or age and searches descriptions and categories', () => {
        renderSearch('/search?sort=title')
        expect(screen.getAllByTestId('search-result').map((node) => node.textContent))
            .toEqual(['Bird in Flight', 'Finley Birds', 'Streets of Madrid'])

        selectChoice(screen.getByLabelText('Order'), 'oldest')
        expect(screen.getAllByTestId('search-result').map((node) => node.textContent))
            .toEqual(['Bird in Flight', 'Streets of Madrid', 'Finley Birds'])

        fireEvent.change(screen.getByLabelText('Search the archive'), { target: { value: 'city walk' } })
        expect(screen.getByRole('link', { name: 'Streets of Madrid' })).toBeInTheDocument()
        expect(screen.getAllByTestId('search-result')).toHaveLength(1)

        fireEvent.change(screen.getByLabelText('Search the archive'), { target: { value: 'nothing here' } })
        expect(screen.getByRole('heading', { name: 'No albums found' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Show the full archive' }))
        expect(screen.getAllByTestId('search-result')).toHaveLength(3)
    })

    it('keeps typing immediate, coalesces URL writes and cancels stale edits after navigation', async () => {
        vi.useFakeTimers()
        renderSearch()
        await act(async () => {})
        const input = screen.getByLabelText('Search the archive')
        fireEvent.change(input, { target: { value: 'b' } })
        fireEvent.change(input, { target: { value: 'bird' } })
        expect(input).toHaveValue('bird')
        expect(screen.getByLabelText('Current query')).toBeEmptyDOMElement()
        await act(async () => vi.advanceTimersByTime(150))
        expect(screen.getByLabelText('Current query')).toHaveTextContent('?q=bird')
        fireEvent.change(input, { target: { value: 'pending' } })
        fireEvent.click(screen.getByRole('button', { name: 'Navigate search' }))
        expect(input).toHaveValue('city')
        await act(async () => vi.advanceTimersByTime(300))
        expect(screen.getByLabelText('Current query')).toHaveTextContent('?q=city')
        fireEvent.change(input, { target: { value: 'birds' } })
        selectChoice(screen.getByLabelText('Format'), 'photo')
        expect(input).toHaveValue('birds')
        expect(screen.getByLabelText('Current query')).toHaveTextContent('q=birds&type=photo')
        fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
        await act(async () => vi.advanceTimersByTime(300))
        expect(input).toHaveValue('')
        expect(screen.getByLabelText('Current query')).toHaveTextContent('?type=photo')
    })

    it('loads both uncached catalogs to completion', async () => {
        catalog.snapshots.clear()
        api.fetchAlbumsPage.mockImplementation(async ({ type }) => ({
            items: type === 'video' ? VIDEO_ALBUMS : PHOTO_ALBUMS,
            nextCursor: null,
        }))

        renderSearch()
        expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Loading test archive')
        await waitFor(() => expect(screen.getAllByTestId('search-result')).toHaveLength(3))
        expect(api.fetchAlbumsPage).toHaveBeenCalledTimes(2)
        expect(api.fetchAlbumsPage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'photo', visibility: 'public', limit: 100, cursor: null }),
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        )
        expect(api.fetchAlbumsPage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'video', visibility: 'public', limit: 100, cursor: null }),
            expect.anything(),
        )
    })

    it('shows partial results after a failure and can retry the missing catalog', async () => {
        catalog.snapshots.clear()
        api.fetchAlbumsPage.mockImplementation(async ({ type }) => {
            if (type === 'photo') throw new Error('Photos are temporarily unavailable')
            return { items: VIDEO_ALBUMS, nextCursor: null }
        })

        renderSearch()
        const alert = await screen.findByRole('alert')
        expect(within(alert).getByText('Photos are temporarily unavailable')).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Bird in Flight' })).toBeInTheDocument()

        api.fetchAlbumsPage.mockImplementation(async ({ type }) => ({
            items: type === 'video' ? VIDEO_ALBUMS : PHOTO_ALBUMS,
            nextCursor: null,
        }))
        fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
        await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
        expect(screen.getAllByTestId('search-result')).toHaveLength(3)
    })
})
