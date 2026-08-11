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
})
