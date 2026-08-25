import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-blurhash', () => ({ Blurhash: () => <div /> }))
vi.mock('../utils/api', () => ({ prefetchPublicAlbum: vi.fn(() => Promise.resolve()) }))
vi.mock('../utils/routePreload', () => ({ preloadAlbumRoute: vi.fn(() => Promise.resolve()) }))

import AlbumCard from './AlbumCard'
import { prefetchPublicAlbum } from '../utils/api'
import { preloadAlbumRoute } from '../utils/routePreload'


const album = {
    albumId: '11111111-1111-4111-8111-111111111111',
    title: 'Public album',
    type: 'photo',
    visibility: 'public',
    coverImageUrl: 'https://media.example.test/albums/cover.jpg',
}

function renderCard(props = {}) {
    return render(<MemoryRouter><AlbumCard album={album} {...props} /></MemoryRouter>)
}

describe('AlbumCard intent prefetch', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.clearAllMocks()
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('prefetches the route and public detail only after sustained pointer intent', () => {
        renderCard()
        const link = screen.getByRole('link', { name: /Public album/ })
        fireEvent.mouseEnter(link)
        act(() => vi.advanceTimersByTime(139))
        expect(prefetchPublicAlbum).not.toHaveBeenCalled()
        act(() => vi.advanceTimersByTime(1))
        expect(preloadAlbumRoute).toHaveBeenCalledWith(album)
        expect(prefetchPublicAlbum).toHaveBeenCalledWith(album.albumId)
    })

    it('cancels incidental hover and starts immediately for touch intent', () => {
        renderCard()
        const link = screen.getByRole('link', { name: /Public album/ })
        fireEvent.mouseEnter(link)
        fireEvent.mouseLeave(link)
        act(() => vi.advanceTimersByTime(200))
        expect(prefetchPublicAlbum).not.toHaveBeenCalled()

        fireEvent.touchStart(link)
        expect(preloadAlbumRoute).toHaveBeenCalledWith(album)
        expect(prefetchPublicAlbum).toHaveBeenCalledWith(album.albumId)
    })

    it('never speculates for dashboard buttons', () => {
        renderCard({ onOpen: vi.fn() })
        const button = screen.getByRole('button', { name: /Public album/ })
        fireEvent.mouseEnter(button)
        act(() => vi.advanceTimersByTime(200))
        expect(preloadAlbumRoute).not.toHaveBeenCalled()
        expect(prefetchPublicAlbum).not.toHaveBeenCalled()
    })

    it('cycles decoded 640px previews after sustained desktop hover and restores the cover on leave', async () => {
        const previewSrcSet = (name) => [640, 960, 1440, 1920]
            .map((width) => ({ width, url: `https://media.example.test/${name}-${width}.webp` }))
        prefetchPublicAlbum.mockResolvedValue({
            images: [
                { id: 'cover', url: album.coverImageUrl, previewSrcSet: previewSrcSet('cover') },
                { id: 'one', url: 'https://media.example.test/one.jpg', previewSrcSet: previewSrcSet('one') },
                { id: 'two', url: 'https://media.example.test/two.jpg', previewSrcSet: previewSrcSet('two') },
            ],
        })
        vi.stubGlobal('matchMedia', vi.fn((query) => ({
            matches: query.includes('hover: hover'),
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        })))
        vi.stubGlobal('Image', class {
            constructor() {
                const image = document.createElement('img')
                image.decode = () => Promise.resolve()
                return image
            }
        })

        renderCard({ preview: true })
        const link = screen.getByRole('link', { name: /Public album/ })
        fireEvent.mouseEnter(link)
        await act(async () => { await vi.dynamicImportSettled() })
        act(() => vi.advanceTimersByTime(649))
        expect(document.querySelector('.album-card-image > img[aria-hidden="true"]')).toBeNull()

        await act(async () => {
            vi.advanceTimersByTime(1)
            await Promise.resolve()
            await Promise.resolve()
        })
        await act(async () => { await vi.advanceTimersByTimeAsync(16) })
        const firstFrame = document.querySelector('.album-card-image > img[aria-hidden="true"]')
        expect(firstFrame.getAttribute('src')).toMatch(/-(640)\.webp$/)
        expect(firstFrame).toHaveStyle({ opacity: '1' })
        expect(firstFrame.getAttribute('src')).not.toContain('cover-640')
        expect(prefetchPublicAlbum).toHaveBeenCalledWith(album.albumId)

        const firstUrl = firstFrame.getAttribute('src')
        await act(async () => {
            vi.advanceTimersByTime(1100)
            await Promise.resolve()
            await Promise.resolve()
        })
        await act(async () => { await vi.advanceTimersByTimeAsync(16) })
        const visibleFrame = [...document.querySelectorAll('.album-card-image > img[aria-hidden="true"]')]
            .find((image) => image.style.opacity === '1')
        expect(visibleFrame.getAttribute('src')).not.toBe(firstUrl)

        fireEvent.mouseLeave(link)
        expect(document.querySelector('.album-card-image > img[aria-hidden="true"]')).toBeNull()
    })
})
