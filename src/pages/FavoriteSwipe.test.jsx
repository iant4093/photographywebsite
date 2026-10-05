import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
    fetchAlbumsFiltered: vi.fn(),
    fetchAlbumMediaPage: vi.fn(),
    updateImageThumbnail: vi.fn(),
}))
const auth = vi.hoisted(() => ({ getIdToken: vi.fn() }))
vi.mock('../utils/api', () => api)
vi.mock('../context/auth', () => ({ useAuth: () => auth }))
vi.mock('../utils/mediaUrls', () => ({
    mediaDisplayUrl: (item) => item.url,
    mediaThumbnailUrl: (item) => item.thumb,
    mediaPreviewSrcSet: () => '',
}))

import { selectChoice } from '../test/selectChoice'
import FavoriteSwipe, { SWIPE_THRESHOLD } from './FavoriteSwipe'

const ALBUMS = [
    { albumId: 'a1', title: 'Coast', type: 'photo', imageCount: 4, favoriteCount: 1 },
    { albumId: 'a2', title: 'Hikes', type: 'photo', imageCount: 2, favoriteCount: 0 },
    { albumId: 'a3', title: 'Films', type: 'video', imageCount: 1, favoriteCount: 0 },
]
const photo = (id, extra = {}) => ({ rawKey: `albums/a1/original/${id}.jpg`, url: `https://x.test/${id}.jpg`, thumb: `https://x.test/${id}-t.jpg`, altText: `Photo ${id}`, ...extra })

function renderPage() {
    return render(<MemoryRouter><FavoriteSwipe /></MemoryRouter>)
}

async function openCoast() {
    renderPage()
    const control = await screen.findByRole('combobox', { name: 'Album' })
    await waitFor(() => expect(control).not.toBeDisabled())
    selectChoice(control, 'a1')
    await screen.findByRole('region', { name: 'Photos to review in Coast' })
    return control
}

const topImage = () => document.querySelector('.favorite-swipe-card.is-top img')

// jsdom has no PointerEvent; carry the pointer fields the page reads.
class TestPointerEvent extends MouseEvent {
    constructor(type, init = {}) {
        super(type, init)
        this.pointerId = init.pointerId
        this.isPrimary = init.isPrimary
    }
}

describe('Swipe Favorites', () => {
    beforeEach(() => {
        vi.stubGlobal('PointerEvent', TestPointerEvent)
        vi.clearAllMocks()
        auth.getIdToken.mockResolvedValue('admin-token')
        api.fetchAlbumsFiltered.mockResolvedValue(ALBUMS)
        api.fetchAlbumMediaPage
            .mockResolvedValueOnce({ items: [photo('p1'), photo('p2', { isFavorite: true })], nextCursor: 'next' })
            .mockResolvedValueOnce({ items: [photo('p3'), photo('p1'), photo('p4', { isFavorite: false })], nextCursor: null })
        api.updateImageThumbnail.mockResolvedValue({ item: {} })
    })
    afterEach(() => {
        cleanup()
        vi.unstubAllGlobals()
    })

    it('groups photo albums by whether they have favorites and shows only photos not yet favorited', async () => {
        const control = await openCoast()
        expect(api.fetchAlbumsFiltered).toHaveBeenCalledWith({ visibility: 'all', type: 'photo', favorites: '1', limit: 100 }, 'admin-token')
        expect(api.fetchAlbumMediaPage).toHaveBeenNthCalledWith(1, 'admin-token', 'a1', { limit: 100, cursor: null })
        expect(api.fetchAlbumMediaPage).toHaveBeenNthCalledWith(2, 'admin-token', 'a1', { limit: 100, cursor: 'next' })
        expect(topImage()).toHaveAttribute('alt', 'Photo p1')
        expect(screen.getByText('1 of 3 · 0 favorited')).toBeInTheDocument()

        fireEvent.click(control)
        const menu = screen.getByRole('listbox')
        const groups = within(menu).getAllByRole('group')
        expect(groups.map((group) => group.getAttribute('aria-labelledby')).map((id) => document.getElementById(id).textContent))
            .toEqual(['Albums with favorites', 'Albums without favorites'])
        expect(within(groups[0]).getByRole('option').textContent).toBe('Coast · 1 of 4 favorited')
        expect(within(groups[1]).getByRole('option').textContent).toBe('Hikes · 2 photos')
        expect(within(menu).queryByText(/Films/)).toBeNull()
    })

    it('favorites with the button or a right swipe, skips with a left swipe, and undoes either', async () => {
        const control = await openCoast()
        fireEvent.click(screen.getByRole('button', { name: 'Favorite photo' }))
        await waitFor(() => expect(api.updateImageThumbnail).toHaveBeenCalledWith('admin-token', 'a1', 'albums/a1/original/p1.jpg', { isFavorite: true }))
        expect(topImage()).toHaveAttribute('alt', 'Photo p3')
        expect(screen.getByRole('status')).toHaveTextContent('Added to favorites.')
        expect(control).toHaveTextContent('Coast · 2 of 4 favorited')

        const card = () => document.querySelector('.favorite-swipe-card.is-top')
        fireEvent.pointerDown(card(), { pointerId: 1, button: 0, isPrimary: true, clientX: 300, clientY: 200 })
        fireEvent.pointerMove(card(), { pointerId: 1, clientX: 260, clientY: 200 })
        expect(card()).toHaveClass('is-dragging')
        fireEvent.pointerUp(card(), { pointerId: 1, clientX: 300 - SWIPE_THRESHOLD - 5, clientY: 200 })
        expect(topImage()).toHaveAttribute('alt', 'Photo p4')
        expect(screen.getByRole('status')).toHaveTextContent('Skipped.')

        // A short drag snaps back without deciding.
        fireEvent.pointerDown(card(), { pointerId: 2, button: 0, isPrimary: true, clientX: 300, clientY: 200 })
        fireEvent.pointerMove(card(), { pointerId: 2, clientX: 330, clientY: 210 })
        fireEvent.pointerUp(card(), { pointerId: 2, clientX: 330, clientY: 210, timeStamp: 10_000 })
        expect(topImage()).toHaveAttribute('alt', 'Photo p4')
        expect(card()).not.toHaveClass('is-dragging')

        fireEvent.click(screen.getByRole('button', { name: 'Undo last swipe' }))
        expect(topImage()).toHaveAttribute('alt', 'Photo p3')
        expect(api.updateImageThumbnail).toHaveBeenCalledTimes(1)
        fireEvent.click(screen.getByRole('button', { name: 'Undo last swipe' }))
        expect(topImage()).toHaveAttribute('alt', 'Photo p1')
        await waitFor(() => expect(api.updateImageThumbnail).toHaveBeenLastCalledWith('admin-token', 'a1', 'albums/a1/original/p1.jpg', { isFavorite: false }))
        expect(screen.getByRole('status')).toHaveTextContent('Removed from favorites.')
        expect(control).toHaveTextContent('Coast · 1 of 4 favorited')
        expect(screen.getByRole('button', { name: 'Undo last swipe' })).toBeDisabled()
    })

    it('uses arrow keys and undo shortcuts, ignoring keys meant for the album menu', async () => {
        const control = await openCoast()
        fireEvent.keyDown(window, { key: 'ArrowRight' })
        await waitFor(() => expect(api.updateImageThumbnail).toHaveBeenCalledTimes(1))
        fireEvent.keyDown(window, { key: 'ArrowLeft' })
        expect(topImage()).toHaveAttribute('alt', 'Photo p4')
        fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
        expect(topImage()).toHaveAttribute('alt', 'Photo p3')
        fireEvent.keyDown(window, { key: 'Backspace' })
        expect(topImage()).toHaveAttribute('alt', 'Photo p1')
        fireEvent.keyDown(control, { key: 'ArrowRight' })
        fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true })
        fireEvent.keyDown(window, { key: 'ArrowRight', metaKey: true })
        expect(topImage()).toHaveAttribute('alt', 'Photo p1')
    })

    it('sends favorite changes one at a time and puts a failed favorite back', async () => {
        await openCoast()
        let finish
        api.updateImageThumbnail
            .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
            .mockRejectedValueOnce(new Error('Service unavailable'))
        fireEvent.click(screen.getByRole('button', { name: 'Favorite photo' }))
        fireEvent.click(screen.getByRole('button', { name: 'Favorite photo' }))
        await waitFor(() => expect(api.updateImageThumbnail).toHaveBeenCalledTimes(1))
        expect(screen.getByText(/saving…/)).toBeInTheDocument()
        await act(async () => finish({ item: {} }))
        await waitFor(() => expect(api.updateImageThumbnail).toHaveBeenCalledTimes(2))
        expect(await screen.findByRole('alert')).toHaveTextContent('That photo was not favorited: Service unavailable')
        expect(topImage()).toHaveAttribute('alt', 'Photo p3')
        expect(screen.getByText('2 of 3 · 1 favorited')).toBeInTheDocument()
    })

    it('keeps a photo out of the stack when removing its favorite fails', async () => {
        await openCoast()
        fireEvent.click(screen.getByRole('button', { name: 'Favorite photo' }))
        await waitFor(() => expect(api.updateImageThumbnail).toHaveBeenCalledTimes(1))
        api.updateImageThumbnail.mockRejectedValueOnce(new Error('Busy'))
        fireEvent.click(screen.getByRole('button', { name: 'Undo last swipe' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('That photo is still a favorite: Busy')
        expect(topImage()).toHaveAttribute('alt', 'Photo p3')
    })

    it('finishes an album and can show the skipped photos again', async () => {
        await openCoast()
        for (let index = 0; index < 3; index += 1) fireEvent.click(screen.getByRole('button', { name: 'Skip photo' }))
        expect(screen.getByText('All caught up')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Skip photo' })).toBeDisabled()
        api.fetchAlbumMediaPage.mockResolvedValueOnce({ items: [photo('p1'), photo('p3')], nextCursor: null })
        await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Review skipped photos again' })))
        expect(topImage()).toHaveAttribute('alt', 'Photo p1')
        expect(screen.getByText('1 of 2 · 0 favorited')).toBeInTheDocument()
    })

    it('refreshes expired photo links without reshuffling the stack', async () => {
        await openCoast()
        api.fetchAlbumMediaPage.mockResolvedValueOnce({ items: [photo('p1', { thumb: 'https://x.test/fresh.jpg' })], nextCursor: null })
        await act(async () => fireEvent.error(topImage()))
        expect(topImage()).toHaveAttribute('src', 'https://x.test/fresh.jpg')
        await act(async () => fireEvent.error(topImage()))
        expect(api.fetchAlbumMediaPage).toHaveBeenCalledTimes(3)
    })

    it('says when every photo is already a favorite, and reports loading failures', async () => {
        api.fetchAlbumMediaPage.mockReset().mockResolvedValueOnce({ items: [photo('p1', { isFavorite: true })], nextCursor: null })
        await openCoast()
        expect(screen.getByText('Every photo in this album is already a favorite.')).toBeInTheDocument()
        expect(screen.queryByText('All caught up')).toBeNull()

        api.fetchAlbumMediaPage.mockRejectedValueOnce(new Error('Gone'))
        selectChoice(screen.getByRole('combobox', { name: 'Album' }), 'a2')
        expect(await screen.findByText('The photos could not be loaded.')).toBeInTheDocument()
        expect(screen.getByRole('alert')).toHaveTextContent('Gone')
        api.fetchAlbumMediaPage.mockResolvedValueOnce({ items: [photo('h1')], nextCursor: null })
        await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Try again' })))
        expect(topImage()).toHaveAttribute('alt', 'Photo h1')
    })

    it('retries the album list', async () => {
        api.fetchAlbumsFiltered.mockRejectedValueOnce(new Error('Offline'))
        renderPage()
        expect(await screen.findByRole('alert')).toHaveTextContent('Offline')
        expect(screen.getByRole('combobox', { name: 'Album' })).toBeDisabled()
        await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Try again' })))
        await waitFor(() => expect(screen.getByRole('combobox', { name: 'Album' })).not.toBeDisabled())
        expect(api.fetchAlbumsFiltered).toHaveBeenCalledTimes(2)
    })
})
