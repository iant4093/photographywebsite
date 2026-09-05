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

    it('prefetches route code and album data only after sustained hover', () => {
        renderCard()
        const link = screen.getByRole('link', { name: /Public album/ })
        expect(prefetchPublicAlbum).not.toHaveBeenCalled()
        fireEvent.mouseEnter(link)
        act(() => vi.advanceTimersByTime(249))
        expect(preloadAlbumRoute).not.toHaveBeenCalled()
        expect(prefetchPublicAlbum).not.toHaveBeenCalled()
        act(() => vi.advanceTimersByTime(1))
        expect(preloadAlbumRoute).toHaveBeenCalledWith(album)
        expect(prefetchPublicAlbum).toHaveBeenCalledExactlyOnceWith(album.albumId)
    })

    it('cancels incidental hover', () => {
        renderCard()
        const link = screen.getByRole('link', { name: /Public album/ })
        fireEvent.mouseEnter(link)
        act(() => vi.advanceTimersByTime(100))
        fireEvent.mouseLeave(link)
        act(() => vi.advanceTimersByTime(300))
        expect(preloadAlbumRoute).not.toHaveBeenCalled()
        expect(prefetchPublicAlbum).not.toHaveBeenCalled()
    })

    it.each(['focus', 'mouseDown', 'touchStart'])('starts immediately on %s and clears pending hover work', (event) => {
        renderCard()
        const link = screen.getByRole('link', { name: /Public album/ })
        fireEvent.mouseEnter(link)
        fireEvent[event](link)
        expect(preloadAlbumRoute).toHaveBeenCalledWith(album)
        expect(prefetchPublicAlbum).toHaveBeenCalledExactlyOnceWith(album.albumId)
        act(() => vi.advanceTimersByTime(300))
        expect(prefetchPublicAlbum).toHaveBeenCalledTimes(1)
    })

    it('prefetches only the hovered album in a catalog', () => {
        const secondAlbum = { ...album, albumId: '22222222-2222-4222-8222-222222222222', title: 'Second album' }
        render(<MemoryRouter><AlbumCard album={album} /><AlbumCard album={secondAlbum} /></MemoryRouter>)
        act(() => vi.advanceTimersByTime(300))
        expect(prefetchPublicAlbum).not.toHaveBeenCalled()
        fireEvent.mouseEnter(screen.getByRole('link', { name: /Second album/ }))
        act(() => vi.advanceTimersByTime(250))
        expect(prefetchPublicAlbum).toHaveBeenCalledExactlyOnceWith(secondAlbum.albumId)
    })

    it('cancels pending hover work when the card unmounts', () => {
        const view = renderCard()
        fireEvent.mouseEnter(screen.getByRole('link', { name: /Public album/ }))
        view.unmount()
        act(() => vi.advanceTimersByTime(300))
        expect(prefetchPublicAlbum).not.toHaveBeenCalled()
    })

    it('cancels pending hover work if the card no longer represents a public album', () => {
        const view = renderCard()
        fireEvent.mouseEnter(screen.getByRole('link', { name: /Public album/ }))
        view.rerender(<MemoryRouter><AlbumCard album={{ ...album, visibility: 'private' }} /></MemoryRouter>)
        act(() => vi.advanceTimersByTime(300))
        expect(prefetchPublicAlbum).not.toHaveBeenCalled()
        fireEvent.focus(screen.getByRole('link', { name: /Public album/ }))
        expect(prefetchPublicAlbum).not.toHaveBeenCalled()
    })

    it('never speculates for dashboard buttons', () => {
        renderCard({ onOpen: vi.fn() })
        const button = screen.getByRole('button', { name: /Public album/ })
        fireEvent.mouseEnter(button)
        act(() => vi.advanceTimersByTime(300))
        expect(preloadAlbumRoute).not.toHaveBeenCalled()
        expect(prefetchPublicAlbum).not.toHaveBeenCalled()
    })

    it('safely cancels a hover while preview code is still loading', () => {
        renderCard({ preview: true })
        const link = screen.getByRole('link', { name: /Public album/ })
        expect(() => {
            fireEvent.mouseEnter(link)
            fireEvent.mouseLeave(link)
        }).not.toThrow()
        expect(prefetchPublicAlbum).not.toHaveBeenCalled()
    })

    it('cycles decoded 640px previews after sustained desktop hover and restores the cover on leave', async () => {
        const previewSrcSet = (name) => [640, 960, 1440, 1920]
            .map((width) => ({ width, url: `https://media.example.test/${name}-${width}.webp` }))
        prefetchPublicAlbum.mockResolvedValue({
            images: [
                { id: 'cover', url: album.coverImageUrl, width: 1800, height: 1200, previewSrcSet: previewSrcSet('cover') },
                { id: 'one', url: 'https://media.example.test/one.jpg', width: 1800, height: 1200, previewSrcSet: previewSrcSet('one') },
                { id: 'two', url: 'https://media.example.test/two.jpg', width: 1800, height: 1200, previewSrcSet: previewSrcSet('two') },
                { id: 'portrait', url: 'https://media.example.test/portrait.jpg', width: 1200, height: 1800, previewSrcSet: previewSrcSet('portrait') },
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
            vi.advanceTimersByTime(2200)
            await Promise.resolve()
            await Promise.resolve()
        })
        await act(async () => { await vi.advanceTimersByTimeAsync(16) })
        const transitionFrames = [...document.querySelectorAll('.album-card-image > img[aria-hidden="true"]')]
        const incomingFrame = transitionFrames.at(-1)
        expect(transitionFrames).toHaveLength(2)
        expect(incomingFrame.getAttribute('src')).not.toBe(firstUrl)
        expect(incomingFrame.getAttribute('src')).not.toContain('portrait-640')
        expect(incomingFrame).toHaveStyle({ opacity: '1' })
        expect(firstFrame).toHaveStyle({ opacity: '1' })

        act(() => vi.advanceTimersByTime(599))
        expect(firstFrame).toBeInTheDocument()
        act(() => vi.advanceTimersByTime(1))
        expect(firstFrame).not.toBeInTheDocument()

        fireEvent.mouseLeave(link)
        expect(document.querySelector('.album-card-image > img[aria-hidden="true"]')).toBeNull()
    })

    it('keeps manifest-based previews while independently warming album navigation data', async () => {
        const manifestAlbum = {
            ...album,
            hoverPreviewStatus: 'ready',
            hoverPreviewVersion: 'a'.repeat(24),
            hoverPreviewManifestUrl: `https://media.example.test/public-previews/${album.albumId}/v3/hover-${'a'.repeat(24)}.json`,
        }
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
            schemaVersion: 1,
            albumId: album.albumId,
            version: 'a'.repeat(24),
            images: ['one', 'two'].map((name) => ({
                url: `https://media.example.test/public-previews/${album.albumId}/v3/${name === 'one' ? '1' : '2'}${'0'.repeat(23)}-w640.webp`,
                width: 640,
                height: 427,
            })),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
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

        renderCard({ album: manifestAlbum, preview: true })
        const link = screen.getByRole('link', { name: /Public album/ })
        fireEvent.mouseEnter(link)
        await act(async () => { await vi.dynamicImportSettled() })
        await act(async () => {
            vi.advanceTimersByTime(650)
            await Promise.resolve()
            await Promise.resolve()
        })
        await act(async () => { await vi.advanceTimersByTimeAsync(16) })

        expect(globalThis.fetch).toHaveBeenCalledOnce()
        expect(prefetchPublicAlbum).toHaveBeenCalledExactlyOnceWith(album.albumId)
        expect(document.querySelector('.album-card-image > img[aria-hidden="true"]')).toBeInTheDocument()
    })
})
