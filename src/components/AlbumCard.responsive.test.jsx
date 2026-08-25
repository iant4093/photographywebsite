import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const media = vi.hoisted(() => ({
    albumCoverPreviewSrcSet: vi.fn(),
}))

vi.mock('react-blurhash', () => ({ Blurhash: () => <div /> }))
vi.mock('../utils/mediaUrls', () => ({
    albumCoverPreviewSrcSet: media.albumCoverPreviewSrcSet,
    albumCoverUrl: (album) => album.coverThumbnailUrl || album.coverImageUrl || '',
}))
vi.mock('../utils/api', () => ({ prefetchPublicAlbum: vi.fn(() => Promise.resolve()) }))
vi.mock('../utils/routePreload', () => ({ preloadAlbumRoute: vi.fn(() => Promise.resolve()) }))

import AlbumCard from './AlbumCard'

const photoAlbum = {
    albumId: '11111111-1111-4111-8111-111111111111',
    title: 'Responsive photo album',
    type: 'photo',
    visibility: 'public',
    coverImageUrl: 'https://media.example.test/albums/original/photo.jpg',
    coverThumbnailUrl: 'https://media.example.test/albums/thumbnail/photo.jpg',
}

function renderCard(album = photoAlbum, props = {}) {
    return render(<MemoryRouter><AlbumCard album={album} {...props} /></MemoryRouter>)
}

describe('AlbumCard responsive covers', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.stubGlobal('IntersectionObserver', undefined)
        media.albumCoverPreviewSrcSet.mockResolvedValue(
            'https://media.example.test/preview-640.webp 640w, https://media.example.test/preview-960.webp 960w, https://media.example.test/preview-1440.webp 1440w, https://media.example.test/preview-1920.webp 1920w',
        )
    })
    afterEach(() => vi.unstubAllGlobals())

    it('loads responsive photo previews while retaining the JPEG fallback', async () => {
        renderCard()
        const image = screen.getByRole('img', { name: photoAlbum.title })

        expect(image).toHaveAttribute('src', photoAlbum.coverThumbnailUrl)
        await waitFor(() => expect(screen.getByRole('img', { name: photoAlbum.title }))
            .toHaveAttribute('srcset', expect.stringContaining('preview-1920.webp 1920w')))
        expect(screen.getByRole('img', { name: photoAlbum.title }))
            .toHaveAttribute('sizes', '(min-width: 768px) 360px, (min-width: 640px) 320px, 280px')
        expect(media.albumCoverPreviewSrcSet).toHaveBeenCalledWith({
            albumId: photoAlbum.albumId,
            coverImageUrl: photoAlbum.coverImageUrl,
        })
    })

    it('accepts fluid Search sizing and leaves video posters on their safe still-image URL', async () => {
        const searchSizes = '(max-width: 720px) calc(100vw - 3rem), 520px'
        const photo = renderCard(photoAlbum, { imageSizes: searchSizes })
        expect(screen.getByRole('img', { name: photoAlbum.title })).toHaveAttribute('sizes', searchSizes)
        photo.unmount()
        media.albumCoverPreviewSrcSet.mockClear()

        const video = { ...photoAlbum, albumId: 'video', title: 'Video album', type: 'video' }
        renderCard(video)
        expect(screen.getByRole('img', { name: video.title })).not.toHaveAttribute('srcset')
        expect(media.albumCoverPreviewSrcSet).not.toHaveBeenCalled()
    })

    it('shows the optional New marker only during the first four days after upload', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-08-24T20:00:00Z'))
        const recent = renderCard({
            ...photoAlbum,
            coverImageUrl: '',
            coverThumbnailUrl: '',
            uploadedAt: '2026-08-21T20:00:00Z',
        }, { showNewFlag: true })
        expect(screen.getByLabelText('New album')).toHaveTextContent('New')
        recent.unmount()

        renderCard({
            ...photoAlbum,
            coverImageUrl: '',
            coverThumbnailUrl: '',
            uploadedAt: '2026-08-20T20:00:00Z',
        }, { showNewFlag: true })
        expect(screen.queryByLabelText('New album')).toBeNull()
        vi.useRealTimers()
    })
})
