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
    mediaId: (image) => image.id,
    mediaPreviewSrcSet: () => '',
    mediaThumbnailUrl: (image) => image.thumbnailUrl,
    resolveMediaDownloadUrl: vi.fn(),
    startBrowserDownload: vi.fn(),
}))
vi.mock('./PhotoLightbox', () => ({
    default: ({ images, loading, ariaLabel, onBeforeRefresh }) => (
        <div role="dialog" aria-label={ariaLabel}>
            {loading ? 'Loading photographs' : `${images.length} photographs`}
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
import { clearRandomPhotoSessionCache } from '../utils/randomPhotoSession'

const photos = [
    { id: 'one', albumId: 'album-one', thumbnailUrl: 'https://media.test/one.webp', before: { status: 'unresolved' } },
    { id: 'two', albumId: 'album-one', thumbnailUrl: 'https://media.test/two.webp', before: { status: 'unresolved' } },
]

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
        expect(api.fetchRandomPhotos).toHaveBeenCalledWith({ category: 'Hikes', signal: expect.any(AbortSignal) })
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
})
