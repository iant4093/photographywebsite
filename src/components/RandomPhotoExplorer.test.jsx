import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
    fetchRandomPhotos: vi.fn(),
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
    default: ({ images, index, loading, ariaLabel, onBeforeRefresh, onNext, onClose }) => (
        <div role="dialog" aria-label={ariaLabel}>
            {loading ? 'Loading photographs' : `${images.length} photographs`}
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

import RandomPhotoExplorer from './RandomPhotoExplorer'
import { clearRandomPhotoSessionCache, readRandomPhotoSession } from '../utils/randomPhotoSession'

const photos = [
    { id: 'one', albumId: 'album-one', thumbnailUrl: 'https://media.test/one.webp', before: { status: 'unresolved' } },
    { id: 'two', albumId: 'album-one', thumbnailUrl: 'https://media.test/two.webp', before: { status: 'unresolved' } },
]
const starter = Array.from({ length: 6 }, (_, index) => ({
    id: `photo-${index}`, albumId: 'album-one', url: `https://media.test/${index}.webp`,
}))

describe('random photo loading intent', () => {
    beforeEach(() => {
        clearRandomPhotoSessionCache()
        api.fetchRandomPhotos.mockResolvedValue({ images: photos })
        vi.spyOn(window, 'Image').mockImplementation(function () { return {} })
    })

    it.each(['link', 'icon'])('does not fetch or warm photos when the %s button mounts', async (variant) => {
        render(<RandomPhotoExplorer variant={variant} />)
        await act(async () => {})
        expect(api.fetchRandomPhotos).not.toHaveBeenCalled()
        expect(api.requestAlbumOriginalComparison).not.toHaveBeenCalled()
        expect(window.Image).not.toHaveBeenCalled()
    })

    it.each([
        ['link', 'pointerEnter'], ['link', 'focus'],
        ['icon', 'pointerEnter'], ['icon', 'focus'],
    ])('warms the %s session on %s and reuses it when opened', async (variant, event) => {
        render(<RandomPhotoExplorer category="Hikes" variant={variant} />)
        const button = screen.getByRole('button', { name: 'Shuffle Hikes photos' })
        fireEvent[event](button)
        await waitFor(() => expect(window.Image).toHaveBeenCalledTimes(2))
        expect(api.fetchRandomPhotos).toHaveBeenCalledWith({ category: 'Hikes', limit: 6, signal: expect.any(AbortSignal) })
        fireEvent.click(button)
        expect(await screen.findByRole('dialog')).toHaveTextContent('2 photographs')
        expect(api.fetchRandomPhotos).toHaveBeenCalledOnce()
        expect(api.requestAlbumOriginalComparison).not.toHaveBeenCalled()
    })

    it('loads on a direct click and shares an in-flight intent request', async () => {
        let resolveRequest
        api.fetchRandomPhotos.mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve }))
        render(<RandomPhotoExplorer />)
        const button = screen.getByRole('button', { name: 'Explore Random Photos' })
        fireEvent.click(button)
        expect(screen.getByRole('dialog')).toHaveTextContent('Loading photographs')
        fireEvent.pointerEnter(button)
        fireEvent.focus(button)
        expect(api.fetchRandomPhotos).toHaveBeenCalledOnce()
        await act(async () => { resolveRequest({ images: photos }) })
        expect(screen.getByRole('dialog')).toHaveTextContent('2 photographs')
    })

    it('fetches only the selected original after comparison is requested', async () => {
        api.requestAlbumOriginalComparison.mockResolvedValue({ before: { status: 'unavailable' } })
        render(<RandomPhotoExplorer />)
        fireEvent.click(screen.getByRole('button', { name: 'Explore Random Photos' }))
        const compareButton = await screen.findByRole('button', { name: 'Compare original' })
        expect(api.requestAlbumOriginalComparison).not.toHaveBeenCalled()
        fireEvent.click(compareButton)
        await waitFor(() => expect(screen.getByTestId('original-status')).toHaveTextContent('unavailable'))
        expect(api.requestAlbumOriginalComparison).toHaveBeenCalledExactlyOnceWith(
            'album-one', 'one', null, { signal: expect.any(AbortSignal) },
        )
        expect(api.fetchRandomPhotos).toHaveBeenCalledOnce()
    })

    it('shows the starter before the full deck and preserves selection while appending unique photos', async () => {
        let resolveDeck
        api.fetchRandomPhotos
            .mockResolvedValueOnce({ images: starter, totalPhotos: 100 })
            .mockImplementationOnce(() => new Promise((resolve) => { resolveDeck = resolve }))
        render(<RandomPhotoExplorer />)
        fireEvent.pointerEnter(screen.getByRole('button', { name: 'Explore Random Photos' }))
        await waitFor(() => expect(window.Image).toHaveBeenCalledTimes(2))
        expect(api.fetchRandomPhotos).toHaveBeenCalledOnce()
        expect(readRandomPhotoSession('')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Explore Random Photos' }))
        expect(await screen.findByRole('dialog')).toHaveTextContent('6 photographs')
        await waitFor(() => expect(api.fetchRandomPhotos).toHaveBeenCalledTimes(2))
        expect(api.fetchRandomPhotos).toHaveBeenLastCalledWith({
            category: undefined, limit: 80, priority: 'low', signal: expect.any(AbortSignal),
        })
        fireEvent.click(screen.getByRole('button', { name: 'Next photo' }))
        await act(async () => {
            resolveDeck({ images: [...starter].reverse().concat({ id: 'new', albumId: 'album-two' }), totalPhotos: 100 })
        })
        expect(screen.getByRole('dialog')).toHaveTextContent('7 photographs')
        expect(screen.getByTestId('active-photo')).toHaveTextContent('photo-1')
        expect(readRandomPhotoSession('').map(photo => photo.id)).toEqual([...starter.map(photo => photo.id), 'new'])
    })

    it('keeps a starter usable after background failure and retries expansion when reopened', async () => {
        api.fetchRandomPhotos
            .mockResolvedValueOnce({ images: starter, totalPhotos: 100 })
            .mockRejectedValueOnce(new Error('Offline'))
            .mockResolvedValueOnce({ images: [...starter, { id: 'new', albumId: 'album-one' }], totalPhotos: 7 })
        render(<RandomPhotoExplorer />)
        fireEvent.click(screen.getByRole('button', { name: 'Explore Random Photos' }))
        await waitFor(() => expect(api.fetchRandomPhotos).toHaveBeenCalledTimes(2))
        expect(screen.getByRole('dialog')).toHaveTextContent('6 photographs')
        expect(readRandomPhotoSession('')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Close viewer' }))
        fireEvent.click(screen.getByRole('button', { name: 'Explore Random Photos' }))
        await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('7 photographs'))
        expect(api.fetchRandomPhotos).toHaveBeenCalledTimes(3)
    })

    it('aborts an expansion on close and ignores a late response', async () => {
        let resolveDeck
        api.fetchRandomPhotos
            .mockResolvedValueOnce({ images: starter, totalPhotos: 100 })
            .mockImplementationOnce(() => new Promise((resolve) => { resolveDeck = resolve }))
        render(<RandomPhotoExplorer />)
        fireEvent.click(screen.getByRole('button', { name: 'Explore Random Photos' }))
        await waitFor(() => expect(api.fetchRandomPhotos).toHaveBeenCalledTimes(2))
        const signal = api.fetchRandomPhotos.mock.calls[1][0].signal
        fireEvent.click(screen.getByRole('button', { name: 'Close viewer' }))
        expect(signal.aborted).toBe(true)
        await act(async () => { resolveDeck({ images: starter, totalPhotos: 6 }) })
        expect(readRandomPhotoSession('')).toBeNull()
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('isolates category changes from in-flight starter requests', async () => {
        let resolveOld
        api.fetchRandomPhotos.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
        const { rerender } = render(<RandomPhotoExplorer category="Hikes" />)
        fireEvent.click(screen.getByRole('button', { name: 'Shuffle Hikes photos' }))
        const signal = api.fetchRandomPhotos.mock.calls[0][0].signal
        rerender(<RandomPhotoExplorer category="Birding" />)
        expect(signal.aborted).toBe(true)
        await act(async () => { resolveOld({ images: starter, totalPhotos: 6 }) })
        expect(readRandomPhotoSession('Hikes')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Shuffle Birding photos' }))
        expect(await screen.findByRole('dialog')).toHaveAttribute('aria-label', 'Random photos from Birding')
        await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('2 photographs'))
    })

    it('bounds the merged deck across a pool rotation and reuses the complete cache', async () => {
        const rotated = Array.from({ length: 80 }, (_, index) => ({ id: `rotated-${index}`, albumId: 'album-two' }))
        api.fetchRandomPhotos
            .mockResolvedValueOnce({ images: starter, totalPhotos: 100 })
            .mockResolvedValueOnce({ images: rotated, totalPhotos: 100 })
        const { unmount } = render(<RandomPhotoExplorer />)
        fireEvent.click(screen.getByRole('button', { name: 'Explore Random Photos' }))
        await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('80 photographs'))
        expect(readRandomPhotoSession('')).toHaveLength(80)
        expect(readRandomPhotoSession('').slice(0, 6)).toEqual(starter)
        unmount()
        render(<RandomPhotoExplorer />)
        fireEvent.click(screen.getByRole('button', { name: 'Explore Random Photos' }))
        await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('80 photographs'))
        expect(api.fetchRandomPhotos).toHaveBeenCalledTimes(2)
    })
})
