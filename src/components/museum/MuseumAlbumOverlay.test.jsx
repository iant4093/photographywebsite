import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyDocumentTheme } from '../../utils/theme'
import MuseumAlbumOverlay from './MuseumAlbumOverlay'

vi.mock('../../pages/AlbumGallery', () => ({
    AlbumGalleryContent: ({ albumId }) => (
        <div>
            <h1>Album {albumId}</h1>
            <button type="button" className="linen-media-frame">Open photograph</button>
            <input aria-label="Album viewer state" defaultValue="Retained content" />
        </div>
    ),
}))

const album = { albumId: 'coast', title: 'Coastal Light' }

afterEach(() => {
    applyDocumentTheme('light')
})

describe('museum album theme', () => {
    it.each(['light', 'dark'])('opens using the selected %s palette and keeps the toolbar concise', async (theme) => {
        applyDocumentTheme(theme)
        const onReturn = vi.fn()
        const onClose = vi.fn()
        render(<MuseumAlbumOverlay album={album} onReturn={onReturn} onClose={onClose} />)

        const photo = await screen.findByRole('button', { name: 'Open photograph' })
        expect(photo.closest('.linen-site')).toHaveAttribute('data-theme', theme)
        expect(photo.matches(`.linen-site[data-theme="${theme}"] .linen-media-frame`)).toBe(true)
        expect(screen.queryByText(/the virtual archive/i)).toBeNull()
        expect(screen.getByRole('button', { name: '← Return to gallery' })).toHaveFocus()

        fireEvent.click(screen.getByRole('button', { name: '← Return to gallery' }))
        expect(onReturn).toHaveBeenCalledOnce()
        fireEvent.click(screen.getByRole('button', { name: 'Close album' }))
        expect(onClose).toHaveBeenCalledOnce()
    })

    it('follows preference changes while open without resetting content, scroll, or focus', async () => {
        applyDocumentTheme('light')
        render(<MuseumAlbumOverlay album={album} onReturn={vi.fn()} onClose={vi.fn()} />)
        const input = await screen.findByRole('textbox', { name: 'Album viewer state' })
        const panel = input.closest('.linen-site')
        const scroller = input.closest('.museum-album-scroll')
        fireEvent.change(input, { target: { value: 'Keep my place' } })
        input.focus()
        scroller.scrollTop = 160

        for (const theme of ['dark', 'light']) {
            await act(async () => { applyDocumentTheme(theme) })
            expect(panel).toHaveAttribute('data-theme', theme)
            expect(screen.getByRole('textbox', { name: 'Album viewer state' })).toBe(input)
            expect(input).toHaveValue('Keep my place')
            expect(input).toHaveFocus()
            expect(scroller.scrollTop).toBe(160)
        }
    })
})
