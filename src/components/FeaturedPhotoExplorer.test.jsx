import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
    fetchFeaturedPhotos: vi.fn(),
    requestAlbumMediaDownload: vi.fn(),
    requestAlbumPrintSession: vi.fn(),
    requestAlbumOriginalComparison: vi.fn(),
}))

vi.mock('../utils/api', () => api)
vi.mock('../utils/mediaUrls', () => ({
    mediaFileName: () => 'photo.jpg',
    mediaDisplayUrl: (image) => image.url || image.thumbnailUrl,
    mediaId: (image) => image.id,
    mediaPreviewSrcSet: () => '',
    mediaThumbnailUrl: (image) => image.thumbnailUrl,
    resolveMediaDownloadUrl: vi.fn(),
    startBrowserDownload: vi.fn(),
}))
vi.mock('./PhotoLightbox', () => ({
    default: ({ images, index, loading, ariaLabel, emptyMessage, onRetry, onBeforeRefresh, onNext, onClose }) => (
        <div role="dialog" aria-label={ariaLabel}>
            {loading ? 'Loading photographs' : `${images.length} photographs`}
            {emptyMessage && <p role="alert">{emptyMessage}</p>}
            {onRetry && <button onClick={onRetry}>Try again</button>}
            <p data-testid="active-photo">{images[index]?.id}</p>
            <button type="button" onClick={onNext}>Next photo</button>
            <button type="button" onClick={onClose}>Close viewer</button>
            {images.length > 0 && (
                <>
                    <p data-testid="original-status">{images[0].before?.status}</p>
                    <button type="button" onClick={(event) => onBeforeRefresh(event, images[0])}>Compare original</button>
                </>
            )}
        </div>
    ),
}))

import FeaturedPhotoExplorer from './FeaturedPhotoExplorer'
import { clearFeaturedPhotoSessionCache, readFeaturedPhotoSession } from '../utils/featuredPhotoSession'
import { cacheRandomPhotoSession, clearRandomPhotoSessionCache } from '../utils/randomPhotoSession'

const photos = [
    { id: 'one', isFavorite: true, albumId: 'album-one', thumbnailUrl: 'https://media.test/one.webp', before: { status: 'unresolved' } },
    { id: 'two', isFavorite: true, albumId: 'album-one', thumbnailUrl: 'https://media.test/two.webp', before: { status: 'unresolved' } },
]
const starter = Array.from({ length: 6 }, (_, index) => ({
    id: `photo-${index}`, isFavorite: true, albumId: 'album-one', url: `https://media.test/${index}.webp`,
}))

describe('featured photo loading intent', () => {
    beforeEach(() => {
        clearFeaturedPhotoSessionCache()
        clearRandomPhotoSessionCache()
        api.fetchFeaturedPhotos.mockResolvedValue({ images: photos })
        vi.spyOn(window, 'Image').mockImplementation(function () { return {} })
    })

    it('loads all twelve favorites with one starter and one background request', async () => {
        const twelve = Array.from({ length: 12 }, (_, index) => ({
            id: `favorite-${index}`, albumId: 'album-one', isFavorite: true,
        }))
        api.fetchFeaturedPhotos
            .mockResolvedValueOnce({ images: twelve.slice(0, 6), totalPhotos: 12 })
            .mockResolvedValueOnce({ images: twelve, totalPhotos: 12 })
        render(<FeaturedPhotoExplorer />)
        fireEvent.click(screen.getByRole('button', { name: 'Explore Featured Photos' }))
        await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('12 photographs'))
        expect(api.fetchFeaturedPhotos).toHaveBeenCalledTimes(2)
        expect(readFeaturedPhotoSession('')).toEqual(twelve)
    })

    it('ignores the random cache and never displays unfeatured API entries', async () => {
        cacheRandomPhotoSession('', [{ id: 'ordinary', albumId: 'album-one' }])
        api.fetchFeaturedPhotos.mockResolvedValue({ images: [
            ...photos, { id: 'ordinary' }, { id: 'string', isFavorite: 'true' },
        ], totalPhotos: 2 })
        render(<FeaturedPhotoExplorer />)
        fireEvent.click(screen.getByRole('button', { name: 'Explore Featured Photos' }))
        await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('2 photographs'))
        expect(api.fetchFeaturedPhotos).toHaveBeenCalledOnce()
        expect(readFeaturedPhotoSession('')).toEqual(photos)
    })

    it('filters unfeatured background entries too', async () => {
        api.fetchFeaturedPhotos
            .mockResolvedValueOnce({ images: starter, totalPhotos: 12 })
            .mockResolvedValueOnce({ images: [...starter, { id: 'ordinary' }], totalPhotos: 12 })
        render(<FeaturedPhotoExplorer />)
        fireEvent.click(screen.getByRole('button', { name: 'Explore Featured Photos' }))
        await waitFor(() => expect(readFeaturedPhotoSession('')).toHaveLength(6))
        expect(screen.getByRole('dialog')).toHaveTextContent('6 photographs')
    })

    it('shows a section-specific empty state and retries after favorites are added', async () => {
        api.fetchFeaturedPhotos.mockResolvedValueOnce({ images: [], totalPhotos: 0 })
        render(<FeaturedPhotoExplorer category="Hikes" />)
        fireEvent.click(screen.getByRole('button', { name: 'Explore featured photos in Hikes' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('No featured photos are available in Hikes yet.')
        expect(readFeaturedPhotoSession('Hikes')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
        await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('2 photographs'))
        expect(api.fetchFeaturedPhotos).toHaveBeenCalledTimes(2)
    })

    it('keeps one favorite navigable without requesting a full deck', async () => {
        api.fetchFeaturedPhotos.mockResolvedValue({ images: photos.slice(0, 1), totalPhotos: 1 })
        render(<FeaturedPhotoExplorer />)
        fireEvent.click(screen.getByRole('button', { name: 'Explore Featured Photos' }))
        await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('1 photographs'))
        fireEvent.click(screen.getByRole('button', { name: 'Next photo' }))
        expect(screen.getByTestId('active-photo')).toHaveTextContent('one')
        expect(api.fetchFeaturedPhotos).toHaveBeenCalledOnce()
    })

    it.each(['link', 'icon'])('does not fetch or warm photos when the %s button mounts', async (variant) => {
        render(<FeaturedPhotoExplorer variant={variant} />)
        await act(async () => {})
        expect(api.fetchFeaturedPhotos).not.toHaveBeenCalled()
        expect(api.requestAlbumOriginalComparison).not.toHaveBeenCalled()
        expect(window.Image).not.toHaveBeenCalled()
    })

    it.each([
        ['link', 'pointerEnter'], ['link', 'focus'],
        ['icon', 'pointerEnter'], ['icon', 'focus'],
    ])('warms the %s session on %s and reuses it when opened', async (variant, event) => {
        render(<FeaturedPhotoExplorer category="Hikes" variant={variant} />)
        const button = screen.getByRole('button', { name: 'Explore featured photos in Hikes' })
        fireEvent[event](button)
        await waitFor(() => expect(window.Image).toHaveBeenCalledTimes(2))
        expect(api.fetchFeaturedPhotos).toHaveBeenCalledWith({ category: 'Hikes', limit: 6, signal: expect.any(AbortSignal) })
        fireEvent.click(button)
        expect(await screen.findByRole('dialog')).toHaveTextContent('2 photographs')
        expect(api.fetchFeaturedPhotos).toHaveBeenCalledOnce()
        expect(api.requestAlbumOriginalComparison).not.toHaveBeenCalled()
    })

    it('loads on a direct click and shares an in-flight intent request', async () => {
        let resolveRequest
        api.fetchFeaturedPhotos.mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve }))
        render(<FeaturedPhotoExplorer />)
        const button = screen.getByRole('button', { name: 'Explore Featured Photos' })
        fireEvent.click(button)
        expect(screen.getByRole('dialog')).toHaveTextContent('Loading photographs')
        fireEvent.pointerEnter(button)
        fireEvent.focus(button)
        expect(api.fetchFeaturedPhotos).toHaveBeenCalledOnce()
        await act(async () => { resolveRequest({ images: photos }) })
        expect(screen.getByRole('dialog')).toHaveTextContent('2 photographs')
    })

    it('fetches only the selected original after comparison is requested', async () => {
        api.requestAlbumOriginalComparison.mockResolvedValue({ before: { status: 'unavailable' } })
        render(<FeaturedPhotoExplorer />)
        fireEvent.click(screen.getByRole('button', { name: 'Explore Featured Photos' }))
        const compareButton = await screen.findByRole('button', { name: 'Compare original' })
        expect(api.requestAlbumOriginalComparison).not.toHaveBeenCalled()
        fireEvent.click(compareButton)
        await waitFor(() => expect(screen.getByTestId('original-status')).toHaveTextContent('unavailable'))
        expect(api.requestAlbumOriginalComparison).toHaveBeenCalledExactlyOnceWith(
            'album-one', 'one', null, { signal: expect.any(AbortSignal) },
        )
        expect(api.fetchFeaturedPhotos).toHaveBeenCalledOnce()
    })

    it('shows the starter before the full deck and preserves selection while appending unique photos', async () => {
        let resolveDeck
        api.fetchFeaturedPhotos
            .mockResolvedValueOnce({ images: starter, totalPhotos: 100 })
            .mockImplementationOnce(() => new Promise((resolve) => { resolveDeck = resolve }))
        render(<FeaturedPhotoExplorer />)
        fireEvent.pointerEnter(screen.getByRole('button', { name: 'Explore Featured Photos' }))
        await waitFor(() => expect(window.Image).toHaveBeenCalledTimes(2))
        expect(api.fetchFeaturedPhotos).toHaveBeenCalledOnce()
        expect(readFeaturedPhotoSession('')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Explore Featured Photos' }))
        expect(await screen.findByRole('dialog')).toHaveTextContent('6 photographs')
        await waitFor(() => expect(api.fetchFeaturedPhotos).toHaveBeenCalledTimes(2))
        expect(api.fetchFeaturedPhotos).toHaveBeenLastCalledWith({
            category: undefined, limit: 80, priority: 'low', signal: expect.any(AbortSignal),
        })
        fireEvent.click(screen.getByRole('button', { name: 'Next photo' }))
        await act(async () => {
            resolveDeck({ images: [...starter].reverse().concat({ id: 'new', isFavorite: true, albumId: 'album-two' }), totalPhotos: 100 })
        })
        expect(screen.getByRole('dialog')).toHaveTextContent('7 photographs')
        expect(screen.getByTestId('active-photo')).toHaveTextContent('photo-1')
        expect(readFeaturedPhotoSession('').map(photo => photo.id)).toEqual([...starter.map(photo => photo.id), 'new'])
    })

    it('keeps a starter usable after background failure and retries expansion when reopened', async () => {
        api.fetchFeaturedPhotos
            .mockResolvedValueOnce({ images: starter, totalPhotos: 100 })
            .mockRejectedValueOnce(new Error('Offline'))
            .mockResolvedValueOnce({ images: [...starter, { id: 'new', isFavorite: true, albumId: 'album-one' }], totalPhotos: 7 })
        render(<FeaturedPhotoExplorer />)
        fireEvent.click(screen.getByRole('button', { name: 'Explore Featured Photos' }))
        await waitFor(() => expect(api.fetchFeaturedPhotos).toHaveBeenCalledTimes(2))
        expect(screen.getByRole('dialog')).toHaveTextContent('6 photographs')
        expect(readFeaturedPhotoSession('')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Close viewer' }))
        fireEvent.click(screen.getByRole('button', { name: 'Explore Featured Photos' }))
        await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('7 photographs'))
        expect(api.fetchFeaturedPhotos).toHaveBeenCalledTimes(3)
    })

    it('aborts an expansion on close and ignores a late response', async () => {
        let resolveDeck
        api.fetchFeaturedPhotos
            .mockResolvedValueOnce({ images: starter, totalPhotos: 100 })
            .mockImplementationOnce(() => new Promise((resolve) => { resolveDeck = resolve }))
        render(<FeaturedPhotoExplorer />)
        fireEvent.click(screen.getByRole('button', { name: 'Explore Featured Photos' }))
        await waitFor(() => expect(api.fetchFeaturedPhotos).toHaveBeenCalledTimes(2))
        const signal = api.fetchFeaturedPhotos.mock.calls[1][0].signal
        fireEvent.click(screen.getByRole('button', { name: 'Close viewer' }))
        expect(signal.aborted).toBe(true)
        await act(async () => { resolveDeck({ images: starter, totalPhotos: 6 }) })
        expect(readFeaturedPhotoSession('')).toBeNull()
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('isolates category changes from in-flight starter requests', async () => {
        let resolveOld
        api.fetchFeaturedPhotos.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
        const { rerender } = render(<FeaturedPhotoExplorer category="Hikes" />)
        fireEvent.click(screen.getByRole('button', { name: 'Explore featured photos in Hikes' }))
        const signal = api.fetchFeaturedPhotos.mock.calls[0][0].signal
        rerender(<FeaturedPhotoExplorer category="Birding" />)
        expect(signal.aborted).toBe(true)
        await act(async () => { resolveOld({ images: starter, totalPhotos: 6 }) })
        expect(readFeaturedPhotoSession('Hikes')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Explore featured photos in Birding' }))
        expect(await screen.findByRole('dialog')).toHaveAttribute('aria-label', 'Featured photos from Birding')
        await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('2 photographs'))
    })

    it('bounds the merged deck across a pool rotation and reuses the complete cache', async () => {
        const rotated = Array.from({ length: 80 }, (_, index) => ({ id: `rotated-${index}`, isFavorite: true, albumId: 'album-two' }))
        api.fetchFeaturedPhotos
            .mockResolvedValueOnce({ images: starter, totalPhotos: 100 })
            .mockResolvedValueOnce({ images: rotated, totalPhotos: 100 })
        const { unmount } = render(<FeaturedPhotoExplorer />)
        fireEvent.click(screen.getByRole('button', { name: 'Explore Featured Photos' }))
        await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('80 photographs'))
        expect(readFeaturedPhotoSession('')).toHaveLength(80)
        expect(readFeaturedPhotoSession('').slice(0, 6)).toEqual(starter)
        unmount()
        render(<FeaturedPhotoExplorer />)
        fireEvent.click(screen.getByRole('button', { name: 'Explore Featured Photos' }))
        await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('80 photographs'))
        expect(api.fetchFeaturedPhotos).toHaveBeenCalledTimes(2)
    })
})
